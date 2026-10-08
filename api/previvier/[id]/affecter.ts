import { json, err, run, readJson, requireAuth, audit } from '../../../src/api/http';
import { fetchAllCandidates, currentManagerRound, controleAffectation, isKnownProjet } from '../../../src/api/candidats';
import { sql } from '../../../db/client';

/**
 * POST /api/previvier/:id/affecter  (RH ou Recruteur) — { projet }
 *
 * Affecte le candidat (de retour en pré-vivier après un KO/MB, ou
 * validé à la RH) à un projet. Le projet déjà traité par ce candidat
 * est TOUJOURS refusé (règle métier).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh', 'recruteur']);
  if (!auth.ok) return auth.response;

  // L'identifiant candidat est lu dans l'URL (indépendant du runtime Vercel).
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('previvier');
  if (i === -1 || i + 1 >= parts.length || !parts[i + 1]) return err('Identifiant manquant.', 400);
  let id: string;
  try {
    id = decodeURIComponent(parts[i + 1]);
  } catch {
    return err('Identifiant invalide.', 400);
  }

  const body = await readJson(req);
  const projet = String(body.projet ?? '').trim();
  if (!isKnownProjet(projet)) return err('Projet inconnu.', 400);

  const all = await fetchAllCandidates();
  const c = all.find((x) => x.id === id);
  if (!c) return err('Candidat introuvable.', 404);

  // Contrôles d'affectation v16 : projet déjà traité + doublons de la même
  // personne (une seule affectation simultanée, jamais deux fois le même projet).
  const ctrl = controleAffectation(c, projet, all);
  if (!ctrl.ok) return err(ctrl.message, 400);
  if (currentManagerRound(c.stages) === null) {
    return err('Ce candidat n\'est pas en attente d\'un tour manager.', 400);
  }

  await sql`UPDATE candidats SET projet = ${projet} WHERE id = ${id}`;
  await audit(auth.username, 'candidat.affecte', 'candidat', id, { projet });

  // Politique v16 : aucun email à l'affectation — l'email part à la
  // DÉCISION (OK/KO) enregistrée par le manager.
  return json({ ok: true, projet });
});
