import { json, err, run, readJson, requireAuth, audit } from '../../../src/api/http';
import { sql } from '../../../db/client';
import { loadEmailConfig, sendEmail } from '../../../src/api/email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/parametres/email/test  (RH) — { destinataire }
 * Envoie un email de TEST via le fournisseur configuré : vérifie clé +
 * expéditeur sans attendre un changement de statut. Ne nécessite PAS la
 * bascule « envoi automatique » (c'est une vérification manuelle) mais exige
 * clé API + expéditeur renseignés.
 */
export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  const body = await readJson(req);
  const to = String(body.destinataire ?? '').trim();
  if (!EMAIL_RE.test(to)) return err("L'email destinataire est invalide.", 400);

  let cfg;
  try {
    cfg = await loadEmailConfig();
  } catch (e) {
    return err('Configuration email illisible.', 500);
  }
  if (!cfg.api_key) return err('Clé API non configurée : renseignez d\'abord la clé du fournisseur.', 409);
  if (!cfg.sender_email) return err("Expéditeur non configuré : renseignez d'abord l'email de l'expéditeur.", 409);

  const subject = 'Email de test — Suivi des candidatures';
  const text =
    'Ceci est un email de test envoyé depuis Paramètres > Email.\n\n' +
    'Si vous recevez ce message, la configuration (fournisseur, clé, expéditeur) fonctionne correctement.';

  try {
    await sendEmail(cfg, to, subject, text);
    await sql`INSERT INTO envois_email (candidat_id, code, destinataire, fournisseur, statut, detail)
      VALUES (NULL, 'TEST', ${to}, ${cfg.fournisseur}, 'envoye', NULL)`;
    await audit(auth.username, 'parametres.email.test', 'parametres', 'email', { destinataire: to });
    return json({ ok: true });
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Erreur inconnue';
    await sql`INSERT INTO envois_email (candidat_id, code, destinataire, fournisseur, statut, detail)
      VALUES (NULL, 'TEST', ${to}, ${cfg.fournisseur}, 'echec', ${detail})`;
    return err(`L'envoi a échoué : ${detail}`, 502);
  }
});
