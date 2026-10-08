import { sql } from '../../db/client';
import { decryptApiKey, encryptApiKey } from './email';

/**
 * WhatsApp Business (Cloud API — Meta) — étape 9 (v16).
 *
 * Arbitrages :
 *  - le **numéro expéditeur** (Phone Number ID), le **jeton d'accès
 *    permanent**, le **modèle pré-approuvé** et la langue sont des DONNÉES
 *    (ligne `parametres_whatsapp`), jamais du code — Paramètres > WhatsApp ;
 *  - le jeton est **chiffré en base (AES-256-GCM)** avec la même clé que la
 *    clé API email : il n'existe jamais en clair dans la base, le code ni
 *    les réponses d'API ;
 *  - l'envoi est **côté serveur** (le navigateur ne parle jamais à Meta) ;
 *  - deux modes (reprise de la v16) : message TEXTE libre (fenêtre de 24 h)
 *    avec bascule automatique vers le message MODÈLE pré-approuvé (toujours
 *    autorisé) ;
 *  - un échec n'empêche jamais le flux : journalisé dans `envois_whatsapp`.
 */

export interface WhatsAppConfig {
  phone_number_id: string;
  /** Déchiffré, uniquement en mémoire — jamais retourné par une API. */
  access_token: string | null;
  template_name: string;
  template_lang: string;
  actif: boolean;
}

const GRAPH_VERSION = 'v19.0';

export async function loadWhatsAppConfig(): Promise<WhatsAppConfig> {
  const rows = await sql`SELECT * FROM parametres_whatsapp WHERE id = 1`;
  const r = rows[0] as Record<string, any> | undefined;
  if (!r) throw new Error('Ligne de configuration WhatsApp absente (migration 0003 ?).');
  return {
    phone_number_id: String(r.phone_number_id || ''),
    access_token: r.access_token_enc ? decryptApiKey(String(r.access_token_enc)) : null,
    template_name: String(r.template_name || ''),
    template_lang: String(r.template_lang || 'fr'),
    actif: !!r.actif,
  };
}

export async function saveWhatsAppConfig(cfg: {
  phone_number_id: string;
  access_token_enc: string | null;
  template_name: string;
  template_lang: string;
  actif: boolean;
}): Promise<void> {
  await sql`UPDATE parametres_whatsapp SET
      phone_number_id = ${cfg.phone_number_id},
      access_token_enc = ${cfg.access_token_enc},
      template_name = ${cfg.template_name},
      template_lang = ${cfg.template_lang},
      actif = ${cfg.actif},
      mis_a_jour_le = now()
    WHERE id = 1`;
}

export function whatsappHasToken(cfg: WhatsAppConfig): boolean {
  return !!cfg.access_token;
}

export function isWhatsAppConfigured(cfg: WhatsAppConfig): boolean {
  return !!cfg.phone_number_id && !!cfg.access_token;
}

/**
 * Normalise le numéro candidat au format international WhatsApp.
 * Indicatif par défaut : Bénin (+229) — reprise de la v16
 * (WHATSAPP_DEFAULT_COUNTRY_CODE). Renvoie '' si rien à normaliser.
 */
export function formatWhatsAppNumber(contact: string): string {
  let digits = String(contact || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('229') && digits.length > 10) return '+' + digits;
  if (digits.length > 10) return '+' + digits; // indicatif autre pays, déjà fourni
  return '+229' + digits;
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json?: () => Promise<any> }>;
let _fetch: FetchLike = (fetch as unknown) as FetchLike;

/** SEAM DE TEST : aucun appel réel à Meta dans la suite de validation. */
export function __setWhatsAppFetchForTests(f: FetchLike): void {
  _fetch = f;
}
export function __resetWhatsAppFetchForTests(): void {
  _fetch = (fetch as unknown) as FetchLike;
}

/** Appel Meta — lève si l'API refuse (ex. fenêtre 24 h dépassée). */
async function metaCall(cfg: WhatsAppConfig, to: string, payload: Record<string, any>): Promise<void> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phone_number_id}/messages`;
  const res = await _fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.access_token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `Meta a renvoyé HTTP ${res.status}.`;
    try {
      const j = await res.json?.();
      const m = j?.error?.message;
      if (m) detail += ` ${m}`;
    } catch {
      // réponse non JSON — le message HTTP suffit
    }
    throw new Error(detail);
  }
}

export interface WhatsAppTriggerResult {
  statut: 'envoye' | 'echec' | 'ignore';
  mode: 'texte' | 'modele' | null;
  detail: string;
}

/**
 * Envoi automatique d'un message de résultat (même texte que l'email de
 * la décision). Ne lève JAMAIS. Non configuré → 'ignore' silencieux
 * (la v16 n'alerte pas à chaque sauvegarde).
 */
export async function triggerWhatsApp(args: {
  candidat: Record<string, any>;
  text: string;
}): Promise<WhatsAppTriggerResult> {
  const { candidat } = args;
  const to = formatWhatsAppNumber(String(candidat.contact || ''));

  const log = async (statut: WhatsAppTriggerResult['statut'], mode: 'texte' | 'modele' | null, detail: string): Promise<WhatsAppTriggerResult> => {
    try {
      await sql`INSERT INTO envois_whatsapp (candidat_id, destinataire, mode, statut, detail)
        VALUES (${candidat.id ?? null}, ${to || ''}, ${mode}, ${statut}, ${detail || null})`;
    } catch (e) {
      console.error('envois_whatsapp', e);
    }
    return { statut, mode, detail };
  };

  if (!to) return log('ignore', null, 'Candidat sans numéro.');
  if (!args.text) return log('ignore', null, 'Message vide.');

  let cfg: WhatsAppConfig;
  try {
    cfg = await loadWhatsAppConfig();
  } catch (e) {
    return log('ignore', null, `Configuration illisible : ${e instanceof Error ? e.message : 'erreur inconnue'}`);
  }
  if (!cfg.actif || !isWhatsAppConfigured(cfg)) return log('ignore', null, 'WhatsApp non configuré (Paramètres > WhatsApp).');

  // 1) Mode TEXTE (reprend mot pour mot le texte de l'email) — autorisé
  //    uniquement dans la fenêtre de service client (24 h).
  try {
    await metaCall(cfg, to, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: args.text },
    });
    return await log('envoye', 'texte', '');
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'Erreur inconnue';
    // 2) Bascule automatique vers le MODÈLE pré-approuvé (hors fenêtre 24 h)
    //    — reprise de la v16 : bascule sur tout refus du mode texte.
    if (cfg.template_name) {
      try {
        await metaCall(cfg, to, {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: cfg.template_name,
            language: { code: cfg.template_lang || 'fr' },
            components: [{ type: 'body', parameters: [{ type: 'text', text: args.text }] }],
          },
        });
        return await log('envoye', 'modele', 'texte refusé (' + detail + ')');
      } catch (e2) {
        return await log('echec', 'modele', `texte : ${detail} ; modèle : ${e2 instanceof Error ? e2.message : 'erreur inconnue'}`);
      }
    }
    return await log('echec', 'texte', detail);
  }
}
