import { json, err, run, requireAuth, sessionFullName } from '../src/api/http';
import { computePv } from '../src/api/candidats';

/**
 * GET /api/pv  (Manager) — PV de synthèse : entretiens menés par ce manager
 * (identifié par son nom de session) sur SON projet, triés par date puis
 * par candidat, avec les compteurs OK/KO/MB.
 */
export default run(async (req: Request) => {
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['manager']);
  if (!auth.ok) return auth.response;
  const projet = String(auth.account.projet || '');
  if (!projet) return err('Ce compte n\'est pas rattaché à un projet.', 400);
  const pv = await computePv(sessionFullName(auth.account), projet);
  return json(pv);
});
