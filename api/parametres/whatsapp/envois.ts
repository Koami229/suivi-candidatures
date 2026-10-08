import { json, err, run, requireAuth } from '../../../src/api/http';
import { sql } from '../../../db/client';

/** GET /api/parametres/whatsapp/envois (RH) — 50 derniers messages WhatsApp (journal). */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);
  const rows = await sql`
    SELECT e.envoye_le, e.destinataire, e.mode, e.statut, e.detail,
           (COALESCE(c.prenom, '') || ' ' || COALESCE(c.nom, '')) AS candidat
    FROM envois_whatsapp e
    LEFT JOIN candidats c ON c.id = e.candidat_id
    ORDER BY e.id DESC
    LIMIT 50`;
  return json({
    envois: rows.map((r: any) => ({
      date: r.envoye_le,
      destinataire: r.destinataire,
      mode: r.mode || '',
      statut: r.statut,
      detail: r.detail,
      candidat: (r.candidat as string).trim() || null,
    })),
  });
});
