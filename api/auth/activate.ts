import { json, err, run } from '../../src/api/http';
import { findAccountByActivationToken } from '../../src/api/accounts';

/**
 * GET /api/auth/activate?token=… — vérifie un lien d'activation (validité + expiration 7 j).
 */
export default run(async (req: Request) => {
  if (req.method !== 'GET') return err('Méthode non autorisée.', 405);
  const token = new URL(req.url).searchParams.get('token') || '';
  const found = await findAccountByActivationToken(token);
  if (!found || found.expired) {
    return err('Ce lien d\'activation n\'est pas valide ou a expiré.', 400);
  }
  return json({
    valid: true,
    username: found.account.username,
    prenom: found.account.prenom,
    email: found.account.email,
  });
});
