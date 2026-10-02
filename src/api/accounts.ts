import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from '../../db/client';
import { requireEnv, optionalEnv } from '../lib/config';
import { signJwt } from './jwt';

/**
 * Accès base de données aux comptes + émission de tokens.
 * Règles conservées de l'app : identifiant = email @concentrix.com,
 * manager obligatoirement rattaché à un projet, activation par lien.
 */

export type AccountRow = Record<string, any>;

export const ACCESS_TTL_SEC = 15 * 60; // 15 min
export const REFRESH_TTL_DAYS = 7;
export const ACTIVATION_TTL_DAYS = 7;
const PREAUTH_TTL_SEC = 10 * 60; // ticket 2FA : 10 min

export function publicUser(a: AccountRow) {
  return {
    username: a.username,
    role: a.role,
    nom: a.nom,
    prenom: a.prenom,
    email: a.email,
    projet: a.projet || null,
  };
}

export async function findAccountByUsername(username: string): Promise<AccountRow | null> {
  const rows = await sql`SELECT * FROM comptes WHERE username = ${username} AND desactive_le IS NULL`;
  return (rows[0] as AccountRow) || null;
}

/** Règle conservée : tout identifiant doit être un email @concentrix.com. */
export function isConcentrixEmail(v: string): boolean {
  const s = (v || '').trim().toLowerCase();
  const at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return false;
  const domain = s.slice(at + 1);
  const suffix = '.concentrix.com';
  return domain === 'concentrix.com' || domain.slice(-suffix.length) === suffix;
}

export function activationLink(token: string): string {
  const base = (optionalEnv('APP_URL') || '').replace(/\/$/, '');
  return `${base}/?activation=${encodeURIComponent(token)}`;
}

export function preauthTicket(username: string, totpSetupSecret?: string): string {
  const claims: Record<string, unknown> = { sub: username, purpose: 'preauth' };
  if (totpSetupSecret) claims.totp_setup_secret = totpSetupSecret;
  return signJwt(claims, requireEnv('JWT_SECRET'), PREAUTH_TTL_SEC);
}

export function twofaSetupTicket(username: string, secret: string): string {
  return signJwt(
    { sub: username, purpose: 'twofa_setup', totp_setup_secret: secret },
    requireEnv('JWT_SECRET'),
    PREAUTH_TTL_SEC
  );
}

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Émet un token d'accès (15 min) + un refresh opaque (7 jours, stocké HACHÉ
 * en base — révocable). Rotation à chaque refresh.
 */
export async function issueTokens(username: string) {
  const access = signJwt({ sub: username, purpose: 'access' }, requireEnv('JWT_SECRET'), ACCESS_TTL_SEC);
  const refresh = randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000);
  await sql`UPDATE comptes
    SET refresh_token_hash = ${sha256hex(refresh)}, refresh_token_exp = ${exp}, last_login_le = now()
    WHERE username = ${username}`;
  return { access_token: access, refresh_token: refresh };
}

/** Retourne le compte si le refresh token est valide et non expiré. */
export async function tryRefresh(refreshToken: string): Promise<AccountRow | null> {
  if (!refreshToken) return null;
  const rows = await sql`SELECT * FROM comptes WHERE refresh_token_hash = ${sha256hex(refreshToken)} AND desactive_le IS NULL`;
  const acc = rows[0] as AccountRow | undefined;
  if (!acc) return null;
  if (!acc.refresh_token_exp || acc.refresh_token_exp.getTime() < Date.now()) return null;
  return acc;
}

export async function revokeRefresh(username: string): Promise<void> {
  await sql`UPDATE comptes SET refresh_token_hash = NULL, refresh_token_exp = NULL WHERE username = ${username}`;
}

/** Compte en attente d'activation (mot de passe pas encore défini). */
export async function findAccountByActivationToken(token: string): Promise<{ account: AccountRow; expired: boolean } | null> {
  if (!token) return null;
  const rows = await sql`SELECT * FROM comptes WHERE activation_token IS NOT NULL AND activation_token::text = ${token} AND desactive_le IS NULL`;
  const acc = rows[0] as AccountRow | undefined;
  if (!acc) return null;
  const expired =
    !acc.activation_token_cree_le ||
    Date.now() - acc.activation_token_cree_le.getTime() > ACTIVATION_TTL_DAYS * 86400000;
  return { account: acc, expired };
}

export async function activateAccount(username: string, passwordHash: string): Promise<void> {
  await sql`UPDATE comptes
    SET password_hash = ${passwordHash}, activation_token = NULL, activation_token_cree_le = NULL, mis_a_jour_le = now()
    WHERE username = ${username}`;
}

/** Validation partagée création/modification d'un compte (règles de l'app). */
export function validateAccountPayload(p: Record<string, unknown>): string | null {
  const username = String(p.username || '').trim().toLowerCase();
  const role = String(p.role || '');
  const nom = String(p.nom || '').trim();
  const prenom = String(p.prenom || '').trim();
  const email = String(p.email || '').trim();
  if (!isConcentrixEmail(username)) return "L'identifiant doit être une adresse email se terminant par @concentrix.com.";
  if (!['rh', 'recruteur', 'manager'].includes(role)) return 'Rôle invalide.';
  if (!nom) return 'Le nom est obligatoire.';
  if (!prenom) return 'Le prénom est obligatoire.';
  if (!email || email.indexOf('@') <= 0) return "L'email est obligatoire.";
  if (role === 'manager' && !String(p.projet || '').trim()) {
    return 'Le projet du ressort est obligatoire pour un manager.';
  }
  return null;
}

export function newActivationToken(): string {
  return randomUUID();
}
