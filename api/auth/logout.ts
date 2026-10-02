import { json, run, readJson, audit } from '../../src/api/http';
import { revokeRefresh, tryRefresh } from '../../src/api/accounts';

/**
 * POST /api/auth/logout  {refresh_token}
 * Révoque le refresh token (idempotent).
 */
export default run(async (req: Request) => {
  const body = await readJson(req);
  const acc = await tryRefresh(String(body.refresh_token || ''));
  if (acc) {
    await revokeRefresh(String(acc.username));
    await audit(String(acc.username), 'logout');
  }
  return json({ ok: true });
});
