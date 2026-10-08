import { json, err, run, readJson, requireAuth, audit } from '../../../src/api/http';
import { loadWhatsAppConfig, saveWhatsAppConfig, isWhatsAppConfigured } from '../../../src/api/whatsapp';
import { encryptApiKey } from '../../../src/api/email';
import { sql } from '../../../db/client';

/**
 * GET /api/parametres/whatsapp  (RH) — configuration WhatsApp.
 *   Le jeton n'est JAMAIS retourné (indicateur `has_token` seulement).
 * PUT /api/parametres/whatsapp  (RH) —
 *   { phone_number_id?, access_token? (vide = effacer), template_name?,
 *     template_lang?, actif? }
 *   Le jeton fourni est chiffré (AES-256-GCM) avant d'être stocké ;
 *   non fourni, l'existant est conservé tel quel (en base, chiffré).
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  const rows = await sql`SELECT * FROM parametres_whatsapp WHERE id = 1`;
  const row = rows[0] as Record<string, any> | undefined;
  if (!row) return err('Configuration WhatsApp absente (migration 0003 ?).', 500);

  if (req.method === 'GET') {
    const cfg = await loadWhatsAppConfig();
    return json({
      phone_number_id: cfg.phone_number_id,
      has_token: !!cfg.access_token,
      template_name: cfg.template_name,
      template_lang: cfg.template_lang,
      actif: cfg.actif,
      configure: isWhatsAppConfigured(cfg),
    });
  }

  if (req.method !== 'PUT') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);

  const phone = body.phone_number_id !== undefined ? String(body.phone_number_id).trim() : String(row.phone_number_id || '');
  const template = body.template_name !== undefined ? String(body.template_name).trim() : String(row.template_name || '');
  const lang = body.template_lang !== undefined ? String(body.template_lang).trim().slice(0, 8) : String(row.template_lang || 'fr');
  const actif = typeof body.actif === 'boolean' ? body.actif : !!row.actif;
  const tokenEnc =
    body.access_token !== undefined
      ? String(body.access_token).trim()
        ? encryptApiKey(String(body.access_token).trim())
        : null
      : row.access_token_enc ?? null;

  await saveWhatsAppConfig({
    phone_number_id: phone,
    access_token_enc: tokenEnc,
    template_name: template,
    template_lang: lang,
    actif,
  });
  await audit(auth.username, 'parametres.whatsapp.maj', 'whatsapp', '1', {
    phone: !!phone,
    token: tokenEnc !== null,
    actif,
  });
  return json({ ok: true });
});
