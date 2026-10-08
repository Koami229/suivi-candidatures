import { json, err, run, readJson, audit } from '../../src/api/http';
import { findAccountByUsername, isConcentrixEmail, newActivationToken, activationLink } from '../../src/api/accounts';
import { sendActivationEmail } from '../../src/api/email';
import { sql } from '../../db/client';

/**
 * POST /api/auth/forgot — « Mot de passe oublié ? » (v16).
 *
 * AUTO-SERVICE réservé aux accès MANAGER et RECRUTEUR (jamais l'admin) :
 * un email contenant un nouveau lien d'activation est envoyé, la personne
 * définit elle-même son nouveau mot de passe — plus de réinitialisation
 * par l'administrateur (réponse de l'app v16, identiques messages).
 *
 * Le mot de passe courant est annulé (définition obligatoire via le lien),
 * l'ancien jeton d'activation est remplacé. Audité.
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);
  const u = String(body.username ?? '').trim().toLowerCase();

  if (!isConcentrixEmail(u)) {
    return err("L'identifiant doit être une adresse email se terminant par @concentrix.com.", 400);
  }
  const acc = await findAccountByUsername(u);
  if (!acc || (acc.role !== 'manager' && acc.role !== 'recruteur')) {
    return err('Aucun accès Manager ou Recruteur ne correspond à cet identifiant.', 400);
  }
  if (acc.desactive_le) {
    return err('Ce compte a été désactivé par l\'administrateur.', 400);
  }

  const token = newActivationToken();
  await sql`UPDATE comptes
      SET password_hash = NULL,
          activation_token = ${token},
          activation_token_cree_le = now(),
          mis_a_jour_le = now()
    WHERE username = ${acc.username}`;
  await audit(acc.username, 'compte.mot_de_passe_oublie', 'compte', acc.username);

  // L'envoi n'empêche jamais la réponse (config email absente → le lien
  // reste disponible via l'admin qui peut le recréer… non : le lien est
  // celui ci-dessus, valide 7 jours ; l'admin peut relancer un reset).
  await sendActivationEmail({ email: String(acc.email || u), prenom: String(acc.prenom || ''), nom: String(acc.nom || '') }, activationLink(token));

  return json({ ok: true, message: 'Un e-mail de réinitialisation vous a été envoyé.' });
});
