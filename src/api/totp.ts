import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) — vérifié CÔTE SERVEUR.
 * SHA-1 / 6 chiffres / 30 s, tolérance ±1 pas de temps (léger décalage d'horloge).
 * Aucune dépendance externe : encodage base32 et HMAC maison sur node:crypto.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_ISSUER = 'Suivi RH Concentrix';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = (s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Nouvelle clé TOTP (160 bits → 32 caractères base32). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCodeAt(secret: string, stepOffset: number): string {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const sig = createHmac('sha1', key).update(msg).digest();
  const off = sig[sig.length - 1] & 0xf;
  const code =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return (code % 1000000).toString().padStart(6, '0');
}

export function verifyTotpCode(secret: string, codeEntered: string): boolean {
  const code = (codeEntered || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((off) => totpCodeAt(secret, off) === code);
}

export function buildOtpauthUri(username: string, secret: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&digits=6&period=30`;
}
