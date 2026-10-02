import { json, err, run, readJson, requireAuth, audit, sessionFullName } from '../../../src/api/http';
import { sql } from '../../../db/client';
import { EMAIL_PROVIDERS, TEMPLATE_CODES, encryptApiKey } from '../../../src/api/email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * GET /api/parametres/email  (RH) — configuration + templates.
 *   La clé API n'est JAMAIS retournée : uniquement `has_key`.
 * PUT /api/parametres/email  (RH) — mise à jour partielle :
 *   { fournisseur?, sender_email?, sender_name?, api_key?, remove_api_key?,
 *     actif?, templates?: [{ code, objet, corps }] }
 *   - `api_key` non vide  → remplace la clé (chiffrée avant stockage) ;
 *   - `api_key` absente / vide → la clé existante est conservée ;
 *   - `remove_api_key: true` → efface la clé.
 *   `libelle` des templates est en lecture seule (identifiant du déclencheur).
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM parametres_email WHERE id = 1`;
    const r = rows[0] as Record<string, any>;
    const tpls = await sql`SELECT code, libelle, objet, corps FROM templates_email ORDER BY code`;
    return json({
      fournisseur: r.fournisseur,
      has_key: !!r.api_key,
      sender_email: r.sender_email || '',
      sender_name: r.sender_name || '',
      actif: !!r.actif,
      mis_a_jour_par: r.mis_a_jour_par || null,
      mis_a_jour_le: r.mis_a_jour_le ? new Date(r.mis_a_jour_le).toISOString() : null,
      templates: (tpls as Record<string, any>[]).map((t) => ({
        code: t.code,
        libelle: t.libelle,
        objet: t.objet,
        corps: t.corps,
      })),
    });
  }

  if (req.method !== 'PUT') return err('Méthode non autorisée.', 405);
  const body = await readJson(req);

  // ----- Validation ------------------------------------------------------
  if (body.fournisseur !== undefined && !(EMAIL_PROVIDERS as readonly string[]).includes(String(body.fournisseur))) {
    return err('Fournisseur inconnu (resend, brevo, sendgrid).', 400);
  }
  if (body.sender_email !== undefined && !EMAIL_RE.test(String(body.sender_email).trim())) {
    return err("L'email de l'expéditeur est invalide.", 400);
  }
  if (body.sender_name !== undefined && String(body.sender_name).length > 120) {
    return err("Le nom de l'expéditeur est trop long (120 caractères max).", 400);
  }
  const keyStr = body.api_key === undefined || body.api_key === null ? null : String(body.api_key).trim();
  if (keyStr !== null && keyStr === '' && body.remove_api_key !== true) {
    // clé vide sans remove_api_key = « conserver l'existante » (rien à faire)
  } else if (keyStr !== null && keyStr.length > 512) {
    return err('Clé API trop longue (512 caractères max).', 400);
  }
  const tplsIn = Array.isArray(body.templates) ? (body.templates as Record<string, any>[]) : null;
  if (tplsIn) {
    for (const t of tplsIn) {
      if (!t || !(TEMPLATE_CODES as readonly string[]).includes(String(t.code))) return err('Template inconnu.', 400);
      if (typeof t.objet !== 'string' || t.objet.length > 300) return err('Objet de template invalide (300 caractères max).', 400);
      if (typeof t.corps !== 'string' || t.corps.length > 8000) return err('Corps de template trop long (8 000 caractères max).', 400);
    }
  }

  // ----- Application -----------------------------------------------------
  const rows = await sql`SELECT * FROM parametres_email WHERE id = 1`;
  const cur = rows[0] as Record<string, any>;
  const next = {
    fournisseur: body.fournisseur !== undefined ? String(body.fournisseur) : String(cur.fournisseur),
    sender_email: body.sender_email !== undefined ? String(body.sender_email).trim() : String(cur.sender_email || ''),
    sender_name: body.sender_name !== undefined ? String(body.sender_name).trim() : String(cur.sender_name || ''),
    actif: body.actif !== undefined ? !!body.actif : !!cur.actif,
  };
  let api_key: string | null = String(cur.api_key ?? null) ?? null;
  if (body.remove_api_key === true) api_key = null;
  else if (keyStr !== null && keyStr !== '') api_key = encryptApiKey(keyStr);

  await sql`UPDATE parametres_email SET fournisseur = ${next.fournisseur},
      sender_email = ${next.sender_email}, sender_name = ${next.sender_name},
      actif = ${next.actif}, api_key = ${api_key},
      mis_a_jour_par = ${sessionFullName(auth.account)}, mis_a_jour_le = now()
    WHERE id = 1`;
  if (tplsIn) {
    for (const t of tplsIn) {
      await sql`UPDATE templates_email SET objet = ${t.objet}, corps = ${t.corps} WHERE code = ${t.code}`;
    }
  }

  await audit(auth.username, 'parametres.email.maj', 'parametres', 'email', {
    fournisseur_change: next.fournisseur !== String(cur.fournisseur),
    api_key_change: api_key !== String(cur.api_key ?? null),
    actif_change: next.actif !== !!cur.actif,
    templates: tplsIn ? tplsIn.map((t) => String(t.code)) : [],
  });

  return json({ ok: true, has_key: !!api_key, actif: next.actif, fournisseur: next.fournisseur });
});
