import { sql } from '../db/client';

/**
 * GET /api/health — vérification de la connexion base de données.
 * Fonction Vercel (Web API : Request/Response). Aucune donnée sensible retournée.
 */
type HealthBody = {
  ok: boolean;
  db: 'up' | 'missing' | 'erreur';
  detail?: string;
  latence_ms?: number;
  lignes?: number;
  horodatage?: string;
};

function json(body: HealthBody, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async function handler(): Promise<Response> {
  if (!sql) {
    return json(
      { ok: false, db: 'missing', detail: 'DATABASE_URL non configurée (variable d\'environnement Vercel).' },
      503
    );
  }
  const t0 = Date.now();
  try {
    const rows = await sql`SELECT 1 AS up`;
    return json(
      {
        ok: true,
        db: 'up',
        latence_ms: Date.now() - t0,
        lignes: rows.length,
        horodatage: new Date().toISOString(),
      },
      200
    );
  } catch (err) {
    return json(
      { ok: false, db: 'erreur', detail: err instanceof Error ? err.message : String(err) },
      500
    );
  }
}
