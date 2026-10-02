import { json, run, readJson } from '../../src/api/http';
import { issueTokens, tryRefresh } from '../../src/api/accounts';

/**
 * POST /api/auth/refresh  {refresh_token}
 * Rotation : l'ancien refresh est remplacé par un nouveau (un seul usage).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: true, message: 'Méthode non autorisée.' }, 405);
  const body = await readJson(req);
  const acc = await tryRefresh(String(body.refresh_token || ''));
  if (!acc) return json({ error: true, message: 'Session invalide ou expirée.' }, 401);
  return json(await issueTokens(String(acc.username)));
});
