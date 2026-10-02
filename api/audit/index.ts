import { json, err, run, requireAuth } from '../../src/api/http';
import { sql } from '../../db/client';

/**
 * GET /api/audit  (RH) — consultation du journal d'audit (« qui a fait quoi »).
 *
 * Filtres (optionnels) :
 *   - `username` : utilisateur exact ;
 *   - `action`   : préfixe d'action (ex. `login`, `candidat`…) ;
 *   - `q`        : recherche libre (utilisateur, cible, détail) ;
 *   - `limit`    : 1-500 (défaut 100).
 *
 * Le journal est alimenté par toutes les opérations sensibles (étapes 2 à 7) :
 * connexions (dont échecs), 2FA, activation, comptes, candidats (création,
 * import, décision d'entretien, modification, affectation, suppression,
 * purge RGPD), paramètres email. Il ne contient AUCUNE donnée personnelle des
 * candidats (noms, emails…) : uniquement qui, quoi, cible et métadonnées.
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);

  const url = new URL(req.url);
  const username = String(url.searchParams.get('username') || '').trim();
  const action = String(url.searchParams.get('action') || '').trim();
  const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

  // Conditions construites en paramètres — aucune concaténation d'entrée utilisateur.
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (username) {
    conds.push(`username = $${vals.length + 1}`);
    vals.push(username);
  }
  if (action) {
    conds.push(`action LIKE $${vals.length + 1}`);
    vals.push(action + '%');
  }
  if (q) {
    conds.push(`(username ILIKE $${vals.length + 1} OR action ILIKE $${vals.length + 2} OR cible_id ILIKE $${vals.length + 3} OR detail::text ILIKE $${vals.length + 4})`);
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

  const rows = (await sql.unsafe(
    `SELECT username, action, cible_type, cible_id, detail, cree_le FROM audit_log${where} ORDER BY id DESC LIMIT ${limit}`,
    vals
  )) as Record<string, any>[];

  return json({
    events: rows.map((r) => ({
      id: Number(r.id),
      date: new Date(r.cree_le).toISOString(),
      username: r.username || null,
      action: r.action,
      cibleType: r.cible_type || null,
      cibleId: r.cible_id || null,
      detail: r.detail && Object.keys(r.detail).length ? r.detail : null,
    })),
  });
});
