import { json, err, run, readJson, requireAuth, audit } from '../../src/api/http';
import { validateAccountPayload, revokeRefresh } from '../../src/api/accounts';
import { sql } from '../../db/client';

/**
 * GET    /api/comptes/:username  (RH) — détail d'un accès.
 * PUT    /api/comptes/:username  (RH) — modification (nom, prénom, email, projet,
 *         éventuel changement d'identifiant — l'intéressé doit alors se
 *         reconnecter avec le nouvel identifiant).
 * DELETE /api/comptes/:username  (RH) — suppression DOUCE (desactive_le) :
 *         le compte ne peut plus se connecter ; réversible en base.
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  // L'identifiant est lu dans l'URL (indépendant du runtime Vercel).
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('comptes');
  if (i === -1 || i + 1 >= parts.length) return err('Identifiant manquant.', 400);
  let old: string;
  try {
    old = decodeURIComponent(parts[i + 1]).toLowerCase();
  } catch {
    return err('Identifiant invalide.', 400);
  }

  if (req.method === 'GET') {
    const rows = await sql`SELECT username, role, nom, prenom, email, projet, (password_hash IS NOT NULL) AS activated FROM comptes WHERE username = ${old} AND desactive_le IS NULL`;
    if (!rows.length) return err('Compte introuvable.', 404);
    return json({ account: rows[0] });
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const problem = validateAccountPayload(body);
    if (problem) return err(problem, 400);

    const rows = await sql`SELECT 1 FROM comptes WHERE username = ${old} AND desactive_le IS NULL`;
    if (!rows.length) return err('Compte introuvable.', 404);

    const username = String(body.username!).trim().toLowerCase();
    const role = String(body.role!);
    const email = String(body.email!).trim();
    const projet = role === 'manager' ? String(body.projet!).trim() : null;

    if (username !== old) {
      const dupe = await sql`SELECT 1 FROM comptes WHERE username = ${username}`;
      if (dupe.length) return err('Cet identifiant est déjà utilisé.', 400);
    }

    await sql`
      UPDATE comptes
      SET username = ${username}, role = ${role},
          nom = ${String(body.nom!).trim()}, prenom = ${String(body.prenom!).trim()},
          email = ${email}, projet = ${projet}, mis_a_jour_le = now()
      WHERE username = ${old}`;
    // L'intéressé doit se reconnecter (nouveaux identifiants / droits).
    await revokeRefresh(username);
    await audit(auth.username, 'compte.modifie', 'compte', username, { ancien: old });
    return json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      UPDATE comptes
      SET desactive_le = now(), refresh_token_hash = NULL, refresh_token_exp = NULL, mis_a_jour_le = now()
      WHERE username = ${old} AND desactive_le IS NULL
      RETURNING username`;
    if (!rows.length) return err('Compte introuvable.', 404);
    await audit(auth.username, 'compte.supprime', 'compte', old);
    return json({ ok: true });
  }

  return err('Méthode non autorisée.', 405);
});
