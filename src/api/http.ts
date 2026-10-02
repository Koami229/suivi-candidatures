import { sql } from '../../db/client';
import { requireEnv } from '../lib/config';
import { verifyJwt } from './jwt';

/**
 * Helpers HTTP partagés par les fonctions Vercel (Web API : Request/Response).
 */

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function err(message: string, status: number, code?: string): Response {
  return json({ error: true, code: code ?? null, message }, status);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Enveloppe les handlers : toute erreur inattendue → 500 neutre (pas de stack leakée). */
export function run(
  fn: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await fn(req);
    } catch (e) {
      console.error(e);
      return err('Erreur interne du serveur.', 500);
    }
  };
}

export type AuthResult =
  | { ok: true; username: string; role: string; account: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Exige un token d'accès JWT valide ET un compte actif (non désactivé).
 * `roles` restreint l'accès (ex. ['rh'] pour les routes admin).
 */
export async function requireAuth(req: Request, roles?: string[]): Promise<AuthResult> {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (!token) return { ok: false, response: err('Non authentifié.', 401, 'no_token') };
  const payload = verifyJwt(token, requireEnv('JWT_SECRET'));
  if (!payload || typeof payload.sub !== 'string') {
    return { ok: false, response: err('Session expirée ou invalide.', 401, 'invalid_token') };
  }
  const rows = await sql`SELECT * FROM comptes WHERE username = ${payload.sub} AND desactive_le IS NULL`;
  const account = rows[0] as Record<string, unknown> | undefined;
  if (!account) return { ok: false, response: err('Compte indisponible.', 401, 'account_gone') };
  if (roles && !roles.includes(String(account.role))) {
    return { ok: false, response: err('Accès refusé.', 403, 'forbidden') };
  }
  return { ok: true, username: String(account.username), role: String(account.role), account };
}

/**
 * Nom complet de l'accédant (« Prénom Nom »), identique à ce que l'app
 * affiche pour le « recruteur ayant reçu le candidat » / le manager du PV.
 */
export function sessionFullName(account: Record<string, unknown>): string {
  return [String(account.prenom || '').trim(), String(account.nom || '').trim()]
    .filter(Boolean)
    .join(' ');
}

/** Journal d'audit — ne bloque jamais le flux métier en cas d'erreur. */
export async function audit(
  username: string | null,
  action: string,
  cibleType?: string,
  cibleId?: string,
  detail?: Record<string, unknown>
): Promise<void> {
  try {
    await sql`INSERT INTO audit_log (username, action, cible_type, cible_id, detail)
      VALUES (${username}, ${action}, ${cibleType ?? null}, ${cibleId ?? null}, ${detail ?? {}})`;
  } catch (e) {
    console.error('audit', e);
  }
}
