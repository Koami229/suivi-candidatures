import { json, run, requireAuth, audit } from '../../src/api/http';
import { newTotpSecret, buildOtpauthUri } from '../../src/api/totp';
import { twofaSetupTicket } from '../../src/api/accounts';

/**
 * POST /api/auth/twofa-regenerate — génère une NOUVELLE clé (à confirmer).
 * L'ancienne clé reste active tant que le code de confirmation n'a pas validé
 * la nouvelle (comportement identique à l'app actuelle).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: true, message: 'Méthode non autorisée.' }, 405);
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const secret = newTotpSecret();
  await audit(auth.username, 'compte.twofa_reinit_demande');
  return json({
    secret,
    otpauth_uri: buildOtpauthUri(auth.username, secret),
    ticket: twofaSetupTicket(auth.username, secret),
  });
});
