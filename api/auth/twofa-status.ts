import { json, run, requireAuth } from '../../src/api/http';

/** GET /api/auth/twofa-status — la 2FA est-elle configurée sur ce compte ? */
export default run(async (req: Request) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return json({ configured: Boolean(auth.account.totp_secret) });
});
