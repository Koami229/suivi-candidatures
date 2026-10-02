import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * JWT HS256 minimaliste (node:crypto — aucune dépendance externe).
 * - access : 15 min, claims {sub, purpose:'access'}
 * - tickets courts (2FA) : {sub, purpose:'preauth'|'twofa_setup', totp_setup_secret?}
 * La signature est vérifiée en temps constant.
 */

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signJwt(payload: Record<string, unknown>, secret: string, ttlSec: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { ...payload, iat: now, exp: now + ttlSec };
  const h = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const p = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const sig = createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + sig;
}

export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest();
  const got = Buffer.from(parts[2], 'base64url');
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp !== 'number') return null;
    // 5 s de dérive d'horloge tolérées.
    if (payload.exp < Math.floor(Date.now() / 1000) - 5) return null;
    return payload;
  } catch {
    return null;
  }
}
