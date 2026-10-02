import { json, err, run, readJson, requireAuth, audit } from '../../src/api/http';
import {
  validateAccountPayload,
  activationLink,
  newActivationToken,
  isConcentrixEmail,
} from '../../src/api/accounts';
import { sql } from '../../db/client';

/**
 * GET  /api/comptes  (RH) — liste des accès manager & recruteur (vue Paramètres).
 * POST /api/comptes  (RH) — crée un accès ; génère un lien d'activation
 *                           (la personne définit elle-même son mot de passe).
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT username, role, nom, prenom, email, projet,
             (password_hash IS NOT NULL) AS activated
      FROM comptes
      WHERE desactive_le IS NULL AND role IN ('manager','recruteur')
      ORDER BY role, nom, prenom`;
    return json({ accounts: rows });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const problem = validateAccountPayload(body);
    if (problem) return err(problem, 400);

    const username = String(body.username!).trim().toLowerCase();
    const role = String(body.role!);
    const email = String(body.email!).trim();
    const projet = role === 'manager' ? String(body.projet!).trim() : null;

    const dupe = await sql`SELECT 1 FROM comptes WHERE username = ${username}`;
    if (dupe.length) return err('Cet identifiant est déjà utilisé.', 400);

    const token = newActivationToken();
    await sql`
      INSERT INTO comptes (username, role, nom, prenom, email, projet, activation_token, activation_token_cree_le)
      VALUES (${username}, ${role}, ${String(body.nom!).trim()}, ${String(body.prenom!).trim()}, ${email}, ${projet}, ${token}, now())`;
    await audit(auth.username, 'compte.cree', 'compte', username, { role });
    return json({ link: activationLink(token), email, prenom: String(body.prenom!).trim() });
  }

  return err('Méthode non autorisée.', 405);
});
