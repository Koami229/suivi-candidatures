import { json, run, requireAuth } from '../../src/api/http';
import { publicUser } from '../../src/api/accounts';

/**
 * GET /api/auth/me — utilisateur courant (vérifie le token d'accès + compte actif).
 * Utilisé par le front à l'ouverture de l'app pour restaurer la session.
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  return json(publicUser(auth.account));
});
