import { json, err, run, requireAuth, audit } from '../../../src/api/http';
import { activationLink, newActivationToken } from '../../../src/api/accounts';
import { sql } from '../../../db/client';

/**
 * POST /api/comptes/:username/reset  (RH)
 * Réinitialise le mot de passe : l'ancien est désactivé (NULL) et un nouveau
 * lien d'activation est généré — l'intéressé définit un nouveau mot de passe.
 * (Comportement identique à l'app actuelle, mais le mot de passe n'existe
 * jamais en clair ni dans le code.)
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('comptes');
  if (i === -1 || i + 1 >= parts.length) return err('Identifiant manquant.', 400);
  let u: string;
  try {
    u = decodeURIComponent(parts[i + 1]).toLowerCase();
  } catch {
    return err('Identifiant invalide.', 400);
  }

  const rows = await sql`SELECT email, prenom FROM comptes WHERE username = ${u} AND desactive_le IS NULL`;
  if (!rows.length) return err('Compte introuvable.', 404);

  const token = newActivationToken();
  await sql`
    UPDATE comptes
    SET password_hash = NULL, activation_token = ${token}, activation_token_cree_le = now(),
        refresh_token_hash = NULL, refresh_token_exp = NULL, mis_a_jour_le = now()
    WHERE username = ${u}`;
  await audit(auth.username, 'compte.mot_de_passe_reinitialise', 'compte', u);
  return json({ link: activationLink(token), email: rows[0].email, prenom: rows[0].prenom });
});
