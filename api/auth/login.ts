import bcrypt from 'bcryptjs';
import { sql } from '../../db/client';
import { json, err, run, readJson, audit } from '../../src/api/http';
import { isConcentrixEmail, issueTokens, preauthTicket } from '../../src/api/accounts';
import { newTotpSecret, buildOtpauthUri } from '../../src/api/totp';

/**
 * POST /api/auth/login  {username, password}
 *
 * Étape 1/2 de la connexion : vérifie l'identifiant + mot de passe (bcrypt),
 * puis impose la double authentification — OBLIGATOIRE :
 * - clé déjà configurée  → { ticket }                        (vérification du code)
 * - première connexion   → { ticket, setup:{secret, otpauth_uri} }
 * Le compte n'est pas authentifié tant que /api/auth/twofa n'a pas validé le code.
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!isConcentrixEmail(username)) {
    return err("L'identifiant doit être une adresse email se terminant par @concentrix.com.", 400);
  }
  const rows = await sql`SELECT * FROM comptes WHERE username = ${username}`;
  const acc = rows[0] as Record<string, unknown> | undefined;
  if (!acc || acc.desactive_le) {
    // Durcissement (étape 7) : les échecs de connexion sont journalisés
    // (détection de sondage / brute-force) — sans information discriminante
    // (même réponse « incorrect » pour inconnu / désactivé / mauvais mot de passe).
    await audit(username, 'login.echec', 'compte', username, { motif: 'compte_introuvable_ou_desactive' });
    return err('Identifiant ou mot de passe incorrect.', 401);
  }
  if (acc.password_hash === null) {
    await audit(username, 'login.echec', 'compte', username, { motif: 'compte_inactif' });
    return err(
      "Ce compte n'a pas encore été activé. Utilisez le lien d'activation reçu par email pour définir votre mot de passe.",
      403
    );
  }
  const okPassword = await bcrypt.compare(password, String(acc.password_hash));
  if (!okPassword) {
    await audit(username, 'login.echec', 'compte', username, { motif: 'mot_de_passe_incorrect' });
    return err('Identifiant ou mot de passe incorrect.', 401);
  }

  if (!acc.totp_secret) {
    // Première connexion : clé générée ; elle ne sera enregistrée que si
    // l'utilisateur confirme avec un code valide (comportement identique à l'app).
    const secret = newTotpSecret();
    await audit(username, 'login.twofa_setup_demande');
    return json({ setup: { secret, otpauth_uri: buildOtpauthUri(username, secret) }, ticket: preauthTicket(username, secret) });
  }
  await audit(username, 'login.twofa_demande');
  return json({ setup: null, ticket: preauthTicket(username) });
});
