import bcrypt from 'bcryptjs';
import { json, err, run, readJson, audit } from '../../src/api/http';
import { findAccountByActivationToken, activateAccount } from '../../src/api/accounts';
import { passwordIssues } from '../../src/api/password';

/**
 * POST /api/auth/activation  {token, password}
 * Définit le mot de passe via le lien d'activation (politique appliquée côté serveur).
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);
  const token = String(body.token || '');
  const password = String(body.password || '');

  const found = await findAccountByActivationToken(token);
  if (!found || found.expired) return err('Ce lien n\'est plus valide.', 400);

  const issues = passwordIssues(password);
  if (issues.length) return err('Le mot de passe doit contenir : ' + issues.join(', ') + '.', 400);

  const hash = await bcrypt.hash(password, 12);
  await activateAccount(String(found.account.username), hash);
  await audit(String(found.account.username), 'compte.activation');
  return json({ ok: true });
});
