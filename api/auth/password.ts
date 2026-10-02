import bcrypt from 'bcryptjs';
import { json, err, run, readJson, requireAuth, audit } from '../../src/api/http';
import { passwordIssues } from '../../src/api/password';
import { sql } from '../../db/client';

/**
 * POST /api/auth/password  {current, new_password} — changement de mot de passe.
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const body = await readJson(req);
  const current = String(body.current || '');
  const next = String(body.new_password || '');

  const okCurrent = await bcrypt.compare(current, String(auth.account.password_hash || ''));
  if (!okCurrent) return err('Mot de passe actuel incorrect.', 400, 'bad_current');

  const issues = passwordIssues(next);
  if (issues.length) return err('Le nouveau mot de passe doit contenir : ' + issues.join(', ') + '.', 400);

  const hash = await bcrypt.hash(next, 12);
  await sql`UPDATE comptes SET password_hash = ${hash}, mis_a_jour_le = now() WHERE username = ${auth.username}`;
  await audit(auth.username, 'compte.mot_de_passe_modifie');
  return json({ ok: true });
});
