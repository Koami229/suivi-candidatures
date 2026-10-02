import { json, err, run, requireAuth } from '../src/api/http';
import { computeStats } from '../src/api/candidats';

/**
 * GET /api/stats  (RH) — filtres : from, to, sexe, niveau, projet, geoloc, statut.
 *
 * Mêmes métriques que le tableau de bord de l'app (le seuil SHL n'est PAS
 * un filtre : la liste affichée contient déjà que les candidats au-dessus
 * du seuil). `parVille` est calculé uniquement si `geoloc=oui` (candidats
 * dont l'entretien RH a été réalisé).
 */
export default run(async (req: Request) => {
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const stats = await computeStats({
    from: p.get('from') || '',
    to: p.get('to') || '',
    sexe: p.get('sexe') || '',
    niveau: p.get('niveau') || '',
    projet: p.get('projet') || '',
    geoloc: p.get('geoloc') || '',
    statut: p.get('statut') || '',
  });
  return json(stats);
});
