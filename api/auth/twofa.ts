import { sql } from '../../db/client';
import { json, err, run, readJson, audit } from '../../src/api/http';
import { verifyJwt } from '../../src/api/jwt';
import { requireEnv } from '../../src/lib/config';
import { verifyTotpCode } from '../../src/api/totp';
import { issueTokens, publicUser } from '../../src/api/accounts';

/**
 * POST /api/auth/twofa  {ticket, code}
 *
 * Étape 2/2 de la connexion : vérifie le code TOTP (RFC 6238, ±1 pas de temps)
 * côté serveur, enregistre la clé en cas de première configuration, puis
 * émet les tokens de session (access + refresh).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);
  const ticket = String(body.ticket || '');
  const code = String(body.code || '');

  const payload = verifyJwt(ticket, requireEnv('JWT_SECRET'));
  if (!payload || payload.purpose !== 'preauth' || typeof payload.sub !== 'string') {
    return err('Session de connexion expirée — reconnectez-vous.', 400);
  }
  const username = payload.sub;

  const rows = await sql`SELECT * FROM comptes WHERE username = ${username} AND desactive_le IS NULL`;
  const acc = rows[0] as Record<string, unknown> | undefined;
  if (!acc) return err('Compte indisponible.', 401);

  const setupSecret = typeof payload.totp_setup_secret === 'string' ? payload.totp_setup_secret : null;
  const secretToCheck = setupSecret || (acc.totp_secret as string | null);
  if (!secretToCheck) {
    return err('Double authentification non configurée — réessayez de vous connecter.', 400);
  }
  if (!verifyTotpCode(secretToCheck, code)) {
    await audit(username, 'login.twofa_code_invalide');
    return err('Code incorrect ou expiré. Vérifiez l\'heure de votre appareil et réessayez.', 401);
  }

  if (setupSecret) {
    await sql`UPDATE comptes SET totp_secret = ${setupSecret}, totp_activee_le = now(), mis_a_jour_le = now() WHERE username = ${username}`;
    await audit(username, 'login.twofa_activee');
  } else {
    await audit(username, 'login.twofa_ok');
  }

  const tokens = await issueTokens(username);
  return json({ ...tokens, user: publicUser(acc) });
});
