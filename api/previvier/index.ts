import { json, err, run, requireAuth } from '../../src/api/http';
import { fetchAllCandidates, estDansPrevivier, currentManagerRound, projetsDejaTraites } from '../../src/api/candidats';

/**
 * GET /api/previvier  (RH ou Recruteur)
 *
 * Reprise du pré-vivier de l'app : candidats qui ont passé le seuil SHL
 * et dont l'entretien RH est « OK » — donc en attente d'une affectation
 * manager (tours restants déjà traités affichés pour interdire la
 * re-affectation sur le même projet).
 */
export default run(async (req: Request) => {
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh', 'recruteur']);
  if (!auth.ok) return auth.response;

  const all = await fetchAllCandidates();
  const items = all
    .filter(estDansPrevivier)
    .map((c) => ({
      candidat: c,
      round: currentManagerRound(c.stages),
      roundIndex: c.stages.m1.decision !== 'a_faire' ? (c.stages.m2.decision !== 'a_faire' ? 3 : 2) : 1,
      projetsTraites: projetsDejaTraites(c.stages),
    }));
  return json({ items, total: items.length });
});
