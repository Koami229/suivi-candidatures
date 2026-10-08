import { json, err, run, readJson, requireAuth, audit } from '../../../src/api/http';
import { sql } from '../../../db/client';

/**
 * POST /api/candidats/:id/purger  (RH) — { confirmation: <id> }
 *
 * Purge RGPD (IRREVERSIBLE) d'un candidat :
 *  - suppression du candidat + de ses entretiens (cascade) ;
 *  - anonymisation du journal des emails (candidat_id NULL,
 *    destinataire « [purge RGPD] ») : la trace d'activité reste,
 *    les données personnelles n'en font plus partie ;
 *  - une ligne d'audit `candidat.purge_rgpd` sans donnée personnelle.
 *
 * Double protection : rôle RH exigé + le corps doit renvoyer l'identifiant
 * exact dans `confirmation` (aucun clic accidentel).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('candidats');
  if (i === -1 || i + 1 >= parts.length || !parts[i + 1]) return err('Identifiant manquant.', 400);
  let id: string;
  try {
    id = decodeURIComponent(parts[i + 1]);
  } catch {
    return err('Identifiant invalide.', 400);
  }

  const body = await readJson(req);
  if (body.confirmation !== id) {
    return err('Confirmation requise : renvoyez l\'identifiant du candidat dans « confirmation ».', 400);
  }

  const found = await sql`SELECT id FROM candidats WHERE id = ${id}`;
  if (found.length === 0) return err('Candidat introuvable (déjà supprimé ?).', 404);

  // Transaction sur une connexion réservée (pattern du pool max: 10).
  const reserved: any = await (sql as any).reserve();
  let nEntretiens = 0;
  let nEnvois = 0;
  try {
    await reserved.unsafe('begin');
    const nRows = await reserved`SELECT count(*)::int AS n FROM entretiens WHERE candidat_id = ${id}`;
    nEntretiens = (nRows[0] as { n: number }).n;
    const anonym = await reserved`UPDATE envois_email SET candidat_id = NULL, destinataire = '[purge RGPD]'
      WHERE candidat_id = ${id} RETURNING id`;
    nEnvois = anonym.length;
    // Journal WhatsApp (étape 9) : mêmes règles d'anonymisation.
    await reserved`UPDATE envois_whatsapp SET candidat_id = NULL, destinataire = '[purge RGPD]'
      WHERE candidat_id = ${id}`;
    const del = await reserved`DELETE FROM candidats WHERE id = ${id} RETURNING id`;
    if (del.length === 0) {
      await reserved.unsafe('rollback');
      return err('Candidat introuvable (déjà supprimé ?).', 404);
    }
    await reserved.unsafe('commit');
  } catch (e) {
    try {
      await reserved.unsafe('rollback');
    } catch {
      // connexion déjà fermée — rien à faire
    }
    throw e;
  } finally {
    reserved.release();
  }

  await audit(auth.username, 'candidat.purge_rgpd', 'candidat', id, {
    entretiens: nEntretiens,
    envois_anonymises: nEnvois,
  });
  return json({ ok: true, purgee: { candidat: id, entretiens: nEntretiens, envois_anonymises: nEnvois } });
});
