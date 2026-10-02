import { json, err, run, readJson, requireAuth, audit } from '../../src/api/http';
import { verifyJwt } from '../../src/api/jwt';
import { requireEnv } from '../../src/lib/config';
import { verifyTotpCode } from '../../src/api/totp';
import { sql } from '../../db/client';

/**
 * POST /api/auth/twofa-confirm  {ticket, code}
 * Confirme la nouvelle clé 2FA avec un code valide → la remplace.
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;

  const body = await readJson(req);
  const payload = verifyJwt(String(body.ticket || ''), requireEnv('JWT_SECRET'));
  if (!payload || payload.purpose !== 'twofa_setup' || payload.sub !== auth.username) {
    return err('Demande expirée — relancez la génération de clé.', 400);
  }
  const secret = String(payload.totp_setup_secret || '');
  if (!verifyTotpCode(secret, String(body.code || ''))) {
    return err('Code incorrect ou expiré. Vérifiez l\'heure de votre appareil et réessayez.', 400);
  }
  await sql`UPDATE comptes SET totp_secret = ${secret}, totp_activee_le = now(), mis_a_jour_le = now() WHERE username = ${auth.username}`;
  await audit(auth.username, 'compte.twofa_reinitialisee');
  return json({ ok: true });
});
