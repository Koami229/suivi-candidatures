import { json, err, run, requireAuth } from '../../../src/api/http';
import { sql } from '../../../db/client';

/**
 * GET /api/parametres/email/envois  (RH) — journal des 100 derniers envois
 * (déploiement, test manuel, échec, ignoré) : « pourquoi pas d'email ? »
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);

  const rows = (await sql`
    SELECT e.id, e.code, e.destinataire, e.fournisseur, e.statut, e.detail, e.envoye_le,
           c.nom AS c_nom, c.prenom AS c_prenom
    FROM envois_email e
    LEFT JOIN candidats c ON c.id = e.candidat_id
    ORDER BY e.envoye_le DESC, e.id DESC
    LIMIT 100`) as Record<string, any>[];

  return json({
    envois: rows.map((r) => ({
      id: Number(r.id),
      date: new Date(r.envoye_le).toISOString(),
      candidat: r.c_prenom || r.c_nom ? `${r.c_prenom || ''} ${r.c_nom || ''}`.trim() : null,
      code: r.code,
      destinataire: r.destinataire,
      fournisseur: r.fournisseur,
      statut: r.statut,
      detail: r.detail || null,
    })),
  });
});
