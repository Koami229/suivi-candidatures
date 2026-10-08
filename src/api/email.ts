import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { sql } from '../../db/client';
import { requireEnv } from '../lib/config';

/**
 * Moteur d'emails — étape 5.
 *
 * Arbitrages (doc 01 §3.4, validés par le client) :
 *  - le **fournisseur**, la **clé API** et l'**expéditeur** sont des DONNÉES
 *    (ligne `parametres_email`), jamais du code : changer de fournisseur =
 *    changer la ligne, pas le code. Resend, Brevo et SendGrid sont de simples
 *    adaptateurs — aucun n'est codé en dur comme « celui de la prod ».
 *  - la clé API est **chiffrée en base (AES-256-GCM)** avec une clé venue de
 *    l'env `EMAIL_API_KEY_ENC` : elle n'existe jamais en clair dans la base,
 *    dans le code ni dans les réponses d'API.
 *  - le **contenu** des emails vient UNIQUEMENT des lignes `templates_email`
 *    (personnalisables dans Paramètres > Email).
 *  - un échec d'envoi **ne bloque jamais** le flux métier : il est journalisé
 *    dans `envois_email` (statut `echec`), et le code ne lève jamais.
 */

export const EMAIL_PROVIDERS = ['resend', 'brevo', 'sendgrid'] as const;
/**
 * Codes de templates (v16) : un email PAR DÉCISION (jamais pour MB) +
 * activation de compte (accès interne). Les anciens codes
 * SELECTED / PREVIVER / AFFECTATION_PROJET (étape 5) sont remplacés.
 */
export const TEMPLATE_CODES = ['RH_OK', 'RH_KO', 'M1_KO', 'M2_KO', 'M3_KO', 'M_OK', 'ACTIVATION'] as const;

/** Libellé d'étape pour les emails (reprise de STAGE_EMAIL_LABELS, v16). */
export const STAGE_EMAIL_LABELS: Record<string, string> = {
  rh: 'entretien RH',
  m1: 'premier entretien Manager',
  m2: 'deuxième entretien Manager',
  m3: 'troisième entretien Manager',
};

/** Date « 2026-10-08 » → « 8/10/2026 » (reprise de formatInterviewDateFr, v16). */
export function formatDateFr(dateStr: string): string {
  // Reprise de formatInterviewDateFr() (v16) : date ISO → JJ/MM/AAAA
  // (zéros conservés, « 28/09/2026 »), '' si la date est absente ou invalide.
  const s = String(dateStr || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return '';
  const a = parseInt(m[1], 10);
  const mois = parseInt(m[2], 10);
  const j = parseInt(m[3], 10);
  if (!a || mois < 1 || mois > 12 || !j) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ---------------------------------------------------------------------
// Chiffrement de la clé API (AES-256-GCM) — clé venue de l'env uniquement.
// ---------------------------------------------------------------------

function encKey(): Buffer {
  const raw = requireEnv('EMAIL_API_KEY_ENC');
  // 64 caractères hexadécimaux = clé 256 bits directe ; sinon normalisation
  // SHA-256 (documenté) — dans tous les cas la clé de chiffrement vient de
  // l'environnement Vercel, jamais du code.
  const asHex = Buffer.from(raw, 'hex');
  return asHex.length === 32 && asHex.toString('hex') === raw.toLowerCase()
    ? asHex
    : createHash('sha256').update(raw).digest();
}

/** Format stocké : `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export function encryptApiKey(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptApiKey(stored: string): string {
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Clé API illisible en base (format inconnu).');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

export interface EmailConfig {
  fournisseur: string;
  /** Déchiffrée, uniquement en mémoire — jamais retournée par une API. */
  api_key: string | null;
  sender_email: string;
  sender_name: string;
  actif: boolean;
}

export async function loadEmailConfig(): Promise<EmailConfig> {
  const rows = await sql`SELECT * FROM parametres_email WHERE id = 1`;
  const r = rows[0] as Record<string, any> | undefined;
  if (!r) throw new Error('Ligne de configuration email absente (migration 0001 ?).');
  return {
    fournisseur: String(r.fournisseur),
    api_key: r.api_key ? decryptApiKey(String(r.api_key)) : null,
    sender_email: String(r.sender_email || ''),
    sender_name: String(r.sender_name || ''),
    actif: !!r.actif,
  };
}

// ---------------------------------------------------------------------
// Adaptateurs fournisseurs — la seule différence entre eux : URL/headers/
// forme du payload. Aucun fournisseur n'est privilégié.
// ---------------------------------------------------------------------

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number }>;
let _fetch: FetchLike = (fetch as unknown) as FetchLike;

/**
 * SEAM DE TEST : remplace la couche HTTP des adaptateurs (utilisé par la
 * suite de validation, qui ne doit pas appeler les vrais fournisseurs).
 * Inopérant en production — le bundle Vercel ne l'appelle jamais.
 */
export function __setEmailFetchForTests(f: FetchLike): void {
  _fetch = f;
}
export function __resetEmailFetchForTests(): void {
  _fetch = (fetch as unknown) as FetchLike;
}

/** Envoi via le fournisseur configuré — lève si le fournisseur refuse. */
export async function sendEmail(cfg: EmailConfig, to: string, subject: string, text: string): Promise<void> {
  const from = cfg.sender_name ? `${cfg.sender_name} <${cfg.sender_email}>` : cfg.sender_email;
  if (cfg.fournisseur === 'resend') {
    const res = await _fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Resend a renvoyé HTTP ${res.status}.`);
  } else if (cfg.fournisseur === 'brevo') {
    const res = await _fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'api-key': String(cfg.api_key) },
      body: JSON.stringify({
        sender: { name: cfg.sender_name, email: cfg.sender_email },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!res.ok) throw new Error(`Brevo a renvoyé HTTP ${res.status}.`);
  } else if (cfg.fournisseur === 'sendgrid') {
    const res = await _fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: cfg.sender_email, name: cfg.sender_name },
        subject,
        content: [{ type: 'text/plain', value: text }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid a renvoyé HTTP ${res.status}.`);
  } else {
    throw new Error(`Fournisseur inconnu : ${cfg.fournisseur}`);
  }
}

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------

/** Substitue les `{{variable}}` — une variable inconnue devient une chaîne vide. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : ''
  );
}

// ---------------------------------------------------------------------
// Déclencheur
// ---------------------------------------------------------------------

export interface EmailTriggerResult {
  statut: 'envoye' | 'echec' | 'ignore';
  detail: string;
}

/**
 * Déclenche un email automatique (code = template) et le journalise dans
 * `envois_email` — **ne lève jamais** : le flux métier n'est jamais bloqué
 * par un problème de messagerie.
 */
export async function triggerEmail(args: {
  code: string;
  candidat: Record<string, any>;
  projet?: string;
  etape?: string;
  date?: string;
  lien?: string;
}): Promise<EmailTriggerResult> {
  const { code, candidat } = args;
  const to = String(candidat.email || '').trim();

  const log = async (statut: 'envoye' | 'echec' | 'ignore', detail: string, fournisseur: string | null = null): Promise<EmailTriggerResult> => {
    try {
      await sql`INSERT INTO envois_email (candidat_id, code, destinataire, fournisseur, statut, detail)
        VALUES (${candidat.id}, ${code}, ${to}, ${fournisseur}, ${statut}, ${detail || null})`;
    } catch (e) {
      console.error('envois_email', e);
    }
    return { statut, detail };
  };

  if (!to) return log('ignore', 'Candidat sans email.');

  let cfg: EmailConfig;
  try {
    cfg = await loadEmailConfig();
  } catch (e) {
    return log('ignore', `Configuration illisible : ${e instanceof Error ? e.message : 'erreur inconnue'}`);
  }
  if (!cfg.actif) return log('ignore', 'Envoi automatique désactivé (Paramètres > Email).');
  if (!cfg.api_key) return log('ignore', 'Clé API non configurée (Paramètres > Email).');
  if (!cfg.sender_email) return log('ignore', "Expéditeur non configuré (Paramètres > Email).");

  const rendered = await renderTriggerEmail(code, candidat, args);
  if (!rendered) return log('ignore', `Template « ${code} » introuvable.`);

  try {
    await sendEmail(cfg, to, rendered.subject, rendered.body);
    return await log('envoye', '', cfg.fournisseur);
  } catch (e) {
    return await log('echec', e instanceof Error ? e.message : 'Erreur inconnue', cfg.fournisseur);
  }
}

/**
 * Rend le template d'un déclencheur avec les variables standard
 * (prenom, candidat, nom_complet, projet, etape, date (format français),
 * score, lien). Utilisé par triggerEmail et par le déclencheur WhatsApp
 * (même texte que l'email — reprise de la v16).
 */
export async function renderTriggerEmail(
  code: string,
  candidat: Record<string, any>,
  args: { projet?: string; etape?: string; date?: string; lien?: string } = {}
): Promise<{ subject: string; body: string } | null> {
  const tplRows = await sql`SELECT * FROM templates_email WHERE code = ${code}`;
  const tpl = tplRows[0] as Record<string, any> | undefined;
  if (!tpl) return null;
  const vars: Record<string, string> = {
    prenom: String(candidat.prenom || ''),
    candidat: String(candidat.nom || ''),
    nom_complet: `${String(candidat.prenom || '')} ${String(candidat.nom || '')}`.trim(),
    projet: String(args.projet || ''),
    etape: String(args.etape || ''),
    date: formatDateFr(String(args.date || '')),
    score: String(candidat.moyenne ?? ''),
    lien: String(args.lien || ''),
  };
  return { subject: renderTemplate(tpl.objet, vars), body: renderTemplate(tpl.corps, vars) };
}

/**
 * Email d'activation d'un ACCÈS INTERNE (compte manager/recruteur/admin) :
 * template ACTIVATION avec le lien de définition du mot de passe.
 * Journalisé dans `envois_email` (candidat_id NULL — pas un candidat).
 * Ne lève jamais.
 */
export async function sendActivationEmail(
  acc: { email: string; prenom: string; nom: string },
  lien: string
): Promise<EmailTriggerResult> {
  const to = String(acc.email || '').trim();
  try {
    if (!to) return { statut: 'ignore', detail: 'Compte sans email.' };
    const cfg = await loadEmailConfig();
    if (!cfg.actif) return { statut: 'ignore', detail: 'Envoi automatique désactivé (Paramètres > Email).' };
    if (!cfg.api_key) return { statut: 'ignore', detail: 'Clé API non configurée (Paramètres > Email).' };
    if (!cfg.sender_email) return { statut: 'ignore', detail: 'Expéditeur non configuré (Paramètres > Email).' };
    const rows = await sql`SELECT * FROM templates_email WHERE code = 'ACTIVATION'`;
    const tpl = rows[0] as Record<string, any> | undefined;
    if (!tpl) return { statut: 'ignore', detail: 'Template « ACTIVATION » introuvable.' };
    const vars: Record<string, string> = {
      prenom: String(acc.prenom || ''),
      candidat: String(acc.nom || ''),
      nom_complet: `${String(acc.prenom || '')} ${String(acc.nom || '')}`.trim(),
      lien,
    };
    await sendEmail(cfg, to, renderTemplate(tpl.objet, vars), renderTemplate(tpl.corps, vars));
    await sql`INSERT INTO envois_email (candidat_id, code, destinataire, fournisseur, statut, detail)
      VALUES (NULL, 'ACTIVATION', ${to}, ${cfg.fournisseur}, 'envoye', NULL)`;
    return { statut: 'envoye', detail: '' };
  } catch (e) {
    try {
      await sql`INSERT INTO envois_email (candidat_id, code, destinataire, fournisseur, statut, detail)
        VALUES (NULL, 'ACTIVATION', ${to || ''}, NULL, 'echec', ${e instanceof Error ? e.message : 'Erreur inconnue'})`;
    } catch {
      // journal impossible — le flux n'est en tout cas pas bloqué
    }
    return { statut: 'echec', detail: e instanceof Error ? e.message : 'Erreur inconnue' };
  }
}
