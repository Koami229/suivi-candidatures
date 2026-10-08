#!/usr/bin/env node
/**
 * Validation de l'étape 9 (notifications v16) sur Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild).
 * 2. Postgres réel embarqué + migrations 0001 + 0002 + 0003.
 * 3. Bootstrap admin + 1 manager (Samsung).
 * 4. Transports email ET WhatsApp simulés (aucun appel réel).
 *
 * Vérifie : migration 0003 (templates v16, tables whatsapp), configuration
 * WhatsApp (jeton chiffré en base, jamais retourné, préservation/effacement,
 * droits), formatWhatsAppNumber (+229 par défaut, 00→+, + conservé), envoi
 * WhatsApp par décision (même texte que l'email, mode texte), bascule
 * automatique vers le modèle pré-approuvé (Meta 400 → template), ignore
 * silencieux (désactivé / non configuré), mot de passe oublié auto-service
 * (manager/recruteur uniquement, hash annulé, email ACTIVATION, réactivation,
 * ancien mot de passe refusé, audit), purge RGPD anonymisant le journal
 * WhatsApp.
 *
 * Usage : node scripts/validate-step9.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step9-'));
const PORT = 55519;
const ADMIN_EMAIL = 'rh@concentrix.com';
const ADMIN_PW = 'Bootstrap!2026';
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 64 hex (test)

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ---------- 1. Bundle ----------
console.log('\n[1] Bundle des fonctions Vercel (esbuild)');
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step9.mjs');
buildSync({
  entryPoints: [path.join(projectRoot, 'scripts', 'api-test-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['xlsx'],
  outfile: bundleOut,
  logLevel: 'silent',
});
check('bundle généré', fs.existsSync(bundleOut));

// ---------- 2. Postgres + migrations ----------
console.log('\n[2] Postgres réel + migrations');
const ep = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pgdata'), user: 'test', password: 'test', port: PORT, persistent: false });
await ep.initialise();
await ep.start();
await ep.createDatabase('suivi');
const db = postgres(`postgres://test:test@127.0.0.1:${PORT}/suivi`, { max: 1 });
try {
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0001_init.sql'), 'utf8'));
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0002_email_templates.sql'), 'utf8'));
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0003_notification_v16.sql'), 'utf8'));
  check('migrations 0001 + 0002 + 0003 appliquées', true);
} catch (e) {
  check('migrations 0001 + 0002 + 0003 appliquées', false, e.message.slice(0, 160));
  throw e;
}
const nOld = (await db`SELECT count(*)::int AS n FROM templates_email WHERE code IN ('PREVIVER','AFFECTATION_PROJET','SELECTED')`)[0].n;
check('migration 0003 : anciens templates purgés', nOld === 0);
const nNew = (await db`SELECT count(*)::int AS n FROM templates_email WHERE code IN ('RH_OK','RH_KO','M1_KO','M2_KO','M3_KO','M_OK','ACTIVATION')`)[0].n;
check('migration 0003 : 7 templates v16 présents', nNew === 7);

// ---------- 3. Environnement ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';
process.env.EMAIL_API_KEY_ENC = ENC_KEY;

// ---------- 4. Bootstrap admin ----------
console.log('\n[3] Bootstrap admin');
execFileSync(process.execPath, ['scripts/bootstrap-admin.mjs'], {
  cwd: projectRoot,
  stdio: 'pipe',
  env: {
    ...process.env,
    ADMIN_BOOTSTRAP_EMAIL: ADMIN_EMAIL,
    ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PW,
    ADMIN_BOOTSTRAP_NOM: 'Doré',
    ADMIN_BOOTSTRAP_PRENOM: 'Awa',
  },
});
check('admin créé', true);
const api = await import(bundleOut);

const RH_EMAIL = ADMIN_EMAIL;
const RH_PW = 'Rh!2026Step9';
function req(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Request('http://app.test' + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
let r;
async function call(fn, request) {
  const response = await fn(request);
  const status = response.status;
  const data = await response.json().catch(() => ({}));
  return { status, data };
}

// ---------- 4. Bootstrap admin + manager ----------
console.log('\n[3] Bootstrap admin + manager');
const boot = await call(api.login, req('POST', '/api/auth/login', { body: { username: RH_EMAIL, password: ADMIN_PW } }));
check('bootstrap admin : login', boot.status === 200, JSON.stringify(boot.data).slice(0, 200) + ' status=' + boot.status);
if (boot.status === 200) {
  const two = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: boot.data.ticket, code: api.totpCodeAt(boot.data.setup.secret, 0) } }));
  check('bootstrap admin : 2FA', two.status === 200);
  r = two;
}
const RH = r.data.access_token;

async function makeAccount({ username, role, nom, prenom, email, projet, pw }) {
  let rr = await call(api.comptesIndex, req('POST', '/api/comptes', { token: RH, body: { username, role, nom, prenom, email, ...(projet ? { projet } : {}) } }));
  if (rr.status !== 200) throw new Error('compte refusé : ' + JSON.stringify(rr.data));
  const tok = new URL(rr.data.link).searchParams.get('activation');
  rr = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: tok, password: pw } }));
  if (rr.status !== 200) throw new Error('activation refusée : ' + JSON.stringify(rr.data));
  rr = await call(api.login, req('POST', '/api/auth/login', { body: { username, password: pw } }));
  rr = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: rr.data.ticket, code: api.totpCodeAt(rr.data.setup.secret, 0) } }));
  if (rr.status !== 200) throw new Error('2fa refusée : ' + JSON.stringify(rr.data));
  return rr.data.access_token;
}
const MGR = await makeAccount({ username: 'm.samsung@concentrix.com', role: 'manager', nom: 'Konan', prenom: 'Serge', email: 'serge.konan@test.com', projet: 'Samsung', pw: 'Manager!2026' });
check('manager Samsung créé + activé + 2FA', !!MGR);

// ---------- 5. Faux transports email + WhatsApp ----------
const mailCalls = [];
let mailFail = false;
api.__setEmailFetchForTests(async (url, init) => {
  mailCalls.push({ url, headers: init.headers || {}, body: JSON.parse(init.body) });
  if (mailFail) { mailFail = false; return { ok: false, status: 500 }; }
  return { ok: true, status: 202 };
});
const waCalls = [];
let waFailText = false;
api.__setWhatsAppFetchForTests(async (url, init) => {
  const body = JSON.parse(init.body);
  waCalls.push({ url, headers: init.headers || {}, body });
  if (waFailText && body.type === 'text') { waFailText = false; return { ok: false, status: 400, text: '{"error":{"message":"User has not approved messaging (window 24h)"}}' }; }
  return { ok: true, status: 200, text: '{"messages":[{"id":"wamid.TEST"}]}' };
});
check('faux transports email + WhatsApp installés', true);

// ---------- 6. Config WhatsApp : défauts + droits ----------
console.log('\n[4] Config WhatsApp — défauts + droits');
r = await call(api.parametresWhatsapp, req('GET', '/api/parametres/whatsapp', { token: RH }));
check('GET défauts (RH)', r.status === 200 && r.data.phone_number_id === '' && r.data.has_token === false && r.data.template_name === '' && r.data.template_lang === 'fr' && r.data.actif === false && r.data.configure === false, JSON.stringify(r.data));
r = await call(api.parametresWhatsapp, req('GET', '/api/parametres/whatsapp', { token: MGR }));
check('GET (manager) → 403', r.status === 403);
r = await call(api.parametresWhatsapp, req('GET', '/api/parametres/whatsapp'));
check('GET (non authentifié) → 401', r.status === 401);
r = await call(api.parametresWhatsapp, req('POST', '/api/parametres/whatsapp', { token: RH }));
check('POST → 405', r.status === 405);

// ---------- 7. Config WhatsApp : écriture + chiffrement ----------
console.log('\n[5] Config WhatsApp — écriture + chiffrement');
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', {
  token: RH,
  body: { phone_number_id: '123456789012345', access_token: 'wa-test-token-999', template_name: 'decision_entretien', template_lang: 'fr', actif: true },
}));
check('PUT config (n° + jeton + modèle + actif)', r.status === 200 && r.data.ok === true);
let row = await db`SELECT * FROM parametres_whatsapp WHERE id = 1`;
check('jeton chiffré en base (v1:…, jamais en clair)', String(row[0].access_token_enc).startsWith('v1:') && !String(row[0].access_token_enc).includes('wa-test-token-999'));
check('jeton décriptable (round trip AES-256-GCM)', api.decryptApiKey(String(row[0].access_token_enc)) === 'wa-test-token-999');
r = await call(api.parametresWhatsapp, req('GET', '/api/parametres/whatsapp', { token: RH }));
check('GET : has_token true, JAMAIS le jeton en clair', r.data.has_token === true && !JSON.stringify(r.data).includes('wa-test-token-999'));
check('GET : configure true (n° + jeton + actif)', r.data.configure === true);

const tokenEncAvant = String((await db`SELECT access_token_enc FROM parametres_whatsapp WHERE id = 1`)[0].access_token_enc);
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { template_name: '' } }));
row = await db`SELECT access_token_enc FROM parametres_whatsapp WHERE id = 1`;
check('jeton conservé si non fourni', r.status === 200 && String(row[0].access_token_enc) === tokenEncAvant);
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { access_token: '' } }));
row = await db`SELECT access_token_enc FROM parametres_whatsapp WHERE id = 1`;
check('jeton effacé si fourni vide', r.status === 200 && row[0].access_token_enc === null);
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: MGR, body: { actif: true } }));
check('PUT (manager) → 403', r.status === 403);
// Rétablissement pour la suite (n° + jeton, sans modèle pour l'instant).
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { access_token: 'wa-test-token-999', actif: true } }));
check('config rétablie (n° + jeton + actif)', r.status === 200);

// ---------- 8. formatWhatsAppNumber ----------
console.log('\n[6] formatWhatsAppNumber (indicatif +229 par défaut)');
const f = api.formatWhatsAppNumber;
check('01 97 00 11 22 → +2290197001122', f('01 97 00 11 22') === '+2290197001122');
check('00229 01 97 00 11 22 → +2290197001122', f('00229 01 97 00 11 22') === '+2290197001122');
check('+229 97 97 00 11 22 → +2299797001122', f('+229 97 97 00 11 22') === '+2299797001122');
check('+2290197001122 inchangé', f('+2290197001122') === '+2290197001122');
check('197001122 (sans indicatif) → +229197001122', f('197001122') === '+229197001122');
check('vide → vide', f('   ') === '');
check('chiffres conservés (pas de séparateur)', f('01 97 00 11 22') === '+229' + '0197001122');

// ---------- 9. Envoi WhatsApp par décision (mode texte) ----------
console.log('\n[7] Envoi WhatsApp — décision RH OK (même texte que l\'email)');
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', {
  token: RH,
  body: { fournisseur: 'resend', api_key: 'resend-test-key-456', sender_email: 'recrutement@concentrix.com', sender_name: 'Concentrix RH', actif: true },
}));
check('config email activée (resend)', r.status === 200);

r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
  token: RH,
  body: { nom: 'Agossou', prenom: 'Zénith', email: 'zenith.agossou@test.com', contact: '01 97 00 11 22', notes: [80, 82, 84], info: { sexe: 'Femme', age: '26', niveau: 'MASTER', domaine: 'Ventes', residence: 'Cotonou' } },
}));
const Z = r.data.id;
check('candidat Z créé (contact 01 97 00 11 22)', r.status === 201);

r = await call(api.candidatsId, req('PUT', `/api/candidats/${Z}`, {
  token: RH,
  body: { identity: { nom: 'Agossou', prenom: 'Zénith', email: 'zenith.agossou@test.com', contact: '01 97 00 11 22' }, info: { age: '26', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Ventes' }, stages: { rh: { date: '2026-10-05', commentaire: 'Très bon profil', decision: 'ok' } } },
}));
check('RH OK → 200 + statut PRÉ-VIVIER', r.status === 200 && r.data.candidat.statut === 'PREVIVER');
check('email RH_OK envoyé (1 appel email)', mailCalls.length === 1 && mailCalls[0].url === 'https://api.resend.com/emails');
check('WhatsApp envoyé (1 appel Meta, type texte)', waCalls.length === 1 && waCalls[0].url === 'https://graph.facebook.com/v19.0/123456789012345/messages' && waCalls[0].body.type === 'text' && waCalls[0].body.messaging_product === 'whatsapp');
check('WhatsApp : destinataire formaté +229 + Bearer jeton', waCalls[0].body.to === '+2290197001122' && waCalls[0].headers.authorization === 'Bearer wa-test-token-999');
{
  const waText = String(waCalls[0].body.text && waCalls[0].body.text.body);
  const mailText = String(mailCalls[0].body.text ?? mailCalls[0].body.body ?? '');
  let di = 0;
  while (di < Math.min(waText.length, mailText.length) && waText[di] === mailText[di]) di++;
  check('WhatsApp : même texte que l\'email', waText === mailText, JSON.stringify({ lenWa: waText.length, lenMail: mailText.length, firstDiff: di, ctxWa: waText.slice(Math.max(0, di - 20), di + 20), ctxMail: mailText.slice(Math.max(0, di - 20), di + 20) }));
}

let jw = (await db`SELECT * FROM envois_whatsapp ORDER BY id DESC LIMIT 5`);
check('journal WhatsApp : 1 ligne envoyée (texte)', jw.length === 1 && jw[0].statut === 'envoye' && jw[0].mode === 'texte' && jw[0].destinataire === '+2290197001122');

// Journal via l'API (droits + contenu)
r = await call(api.parametresWhatsappEnvois, req('GET', '/api/parametres/whatsapp/envois', { token: RH }));
check('journal API (RH) : 1 envoi, candidat nommé', r.status === 200 && r.data.envois.length === 1 && r.data.envois[0].candidat === 'Zénith Agossou' && r.data.envois[0].statut === 'envoye', JSON.stringify(r.data).slice(0, 300));
r = await call(api.parametresWhatsappEnvois, req('GET', '/api/parametres/whatsapp/envois', { token: MGR }));
check('journal API (manager) → 403', r.status === 403);

// ---------- 10. Bascule automatique vers le modèle pré-approuvé ----------
console.log('\n[8] Bascule — refus texte (fenêtre 24 h) → modèle pré-approuvé');
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { template_name: 'decision_entretien' } }));
check('modèle pré-approuvé configuré', r.status === 200);
waFailText = true;
r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
  token: RH,
  body: { nom: 'Kpade', prenom: 'Yvanne', email: 'yvanne.kpade@test.com', contact: '09 98 00 22 33', notes: [78, 80, 82], info: { sexe: 'Femme', age: '24', niveau: 'BAC', domaine: 'Comptabilité', residence: 'Parakou' } },
}));
const Y = r.data.id;
r = await call(api.candidatsId, req('PUT', `/api/candidats/${Y}`, {
  token: RH,
  body: { identity: { nom: 'Kpade', prenom: 'Yvanne', email: 'yvanne.kpade@test.com', contact: '09 98 00 22 33' }, info: { age: '24', sexe: 'Femme', residence: 'Parakou', niveau: 'BAC', domaine: 'Comptabilité' }, stages: { rh: { date: '2026-10-06', commentaire: 'OK', decision: 'ok' } } },
}));
check('Y : RH OK (email RH_OK, 2e envoi email)', r.status === 200 && mailCalls.length === 2);
check('Y : texte refusé puis MODÈLE envoyé (2 appels Meta)', waCalls.length === 3 && waCalls[2].body.type === 'template');
const tplCall = waCalls[2];
check('Y : modèle + langue + corps du message en paramètre', tplCall.body.template.name === 'decision_entretien' && tplCall.body.template.language.code === 'fr' && tplCall.body.template.components[0].parameters[0].text.includes('Yvanne Kpade'));
jw = (await db`SELECT * FROM envois_whatsapp ORDER BY id DESC LIMIT 1`);
check('Y : journal « envoye » en mode modele', jw[0].statut === 'envoye' && jw[0].mode === 'modele');

// Modèle + échec du modèle aussi → échec journalisé
waFailText = true;
api.__setWhatsAppFetchForTests(async () => { waCalls.push({ url: 'meta', body: {} }); return { ok: false, status: 500, text: '{"error":{"message":"boom"}}' }; });
r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
  token: RH,
  body: { nom: 'Vigano', prenom: 'Ulysse', email: 'ulysse.vigano@test.com', contact: '96 00 11 44 55', notes: [85, 88, 90], info: { sexe: 'Homme', age: '30', niveau: 'LICENCE', domaine: 'Logistique', residence: 'Abomey-Calavi' } },
}));
const X2 = r.data.id;
r = await call(api.candidatsId, req('PUT', `/api/candidats/${X2}`, {
  token: RH,
  body: { identity: { nom: 'Vigano', prenom: 'Ulysse', email: 'ulysse.vigano@test.com', contact: '96 00 11 44 55' }, info: { age: '30', sexe: 'Homme', residence: 'Abomey-Calavi', niveau: 'LICENCE', domaine: 'Logistique' }, stages: { rh: { date: '2026-10-07', commentaire: 'OK', decision: 'ok' } } },
}));
jw = (await db`SELECT * FROM envois_whatsapp ORDER BY id DESC LIMIT 1`);
check('X2 : échec texte + échec modèle → « echec » journalisé, décision conservée', r.status === 200 && jw[0].statut === 'echec' && jw[0].mode === 'modele' && /texte :/.test(jw[0].detail || '') && /modèle :/.test(jw[0].detail || ''), JSON.stringify(jw[0]));
// Réinstaller le faux transport WhatsApp (fonctionnel).
api.__setWhatsAppFetchForTests(async (url, init) => {
  waCalls.push({ url, headers: init.headers || {}, body: JSON.parse(init.body) });
  return { ok: true, status: 200, text: '{"messages":[{"id":"wamid.TEST"}]}' };
});

// ---------- 11. Ignore silencieux (désactivé / non configuré) ----------
console.log('\n[9] Ignore silencieux — désactivé, puis non configuré');
const nWaAvant = waCalls.length;
r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { actif: false } }));
r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
  token: RH,
  body: { nom: 'Dossou', prenom: 'Wend', email: 'wend.dossou@test.com', contact: '01 11 22 33 44', notes: [70, 72, 74], info: { sexe: 'Femme', age: '22', niveau: 'BAC', domaine: 'Tourisme', residence: 'Ouidah' } },
}));
const W = r.data.id;
r = await call(api.candidatsId, req('PUT', `/api/candidats/${W}`, {
  token: RH,
  body: { identity: { nom: 'Dossou', prenom: 'Wend', email: 'wend.dossou@test.com', contact: '01 11 22 33 44' }, info: { age: '22', sexe: 'Femme', residence: 'Ouidah', niveau: 'BAC', domaine: 'Tourisme' }, stages: { rh: { date: '2026-10-08', commentaire: 'OK', decision: 'ok' } } },
}));
jw = (await db`SELECT * FROM envois_whatsapp ORDER BY id DESC LIMIT 1`);
check('désactivé → décision OK sans appel Meta, « ignore » journalisé', r.status === 200 && waCalls.length === nWaAvant && jw[0].statut === 'ignore' && /non configur/i.test(jw[0].detail || ''));

r = await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { actif: true, phone_number_id: '' } }));
r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
  token: RH,
  body: { nom: 'Zinsou', prenom: 'Vital', email: 'vital.zinsou@test.com', contact: '02 22 33 44 55', notes: [60, 62, 64], info: { sexe: 'Homme', age: '28', niveau: 'BEPC', domaine: 'BTP', residence: 'Porto-Novo' } },
}));
const V = r.data.id;
r = await call(api.candidatsId, req('PUT', `/api/candidats/${V}`, {
  token: RH,
  body: { identity: { nom: 'Zinsou', prenom: 'Vital', email: 'vital.zinsou@test.com', contact: '02 22 33 44 55' }, info: { age: '28', sexe: 'Homme', residence: 'Porto-Novo', niveau: 'BEPC', domaine: 'BTP' }, stages: { rh: { date: '2026-10-08', commentaire: 'OK', decision: 'ok' } } },
}));
jw = (await db`SELECT * FROM envois_whatsapp ORDER BY id DESC LIMIT 1`);
check('non configuré (n° absent) → « ignore », aucun appel', waCalls.length === nWaAvant && jw[0].statut === 'ignore' && /non configur/i.test(jw[0].detail || ''));
// Rétablissement n° + jeton (état final cohérent).
await call(api.parametresWhatsapp, req('PUT', '/api/parametres/whatsapp', { token: RH, body: { phone_number_id: '123456789012345', actif: true } }));

// ---------- 12. Mot de passe oublié (auto-service) ----------
console.log('\n[10] Mot de passe oublié — manager');
const mRow = await db`SELECT * FROM comptes WHERE username = 'm.samsung@concentrix.com'`;
check('pré-alambic : hash présent, aucun jeton d\'activation', mRow[0].password_hash !== null && mRow[0].activation_token === null);

const nMailAvant = mailCalls.length;
r = await call(api.forgot, req('POST', '/api/auth/forgot', { body: { username: 'm.samsung@concentrix.com' } }));
check('forgot (manager) → 200 + message', r.status === 200 && r.data.ok === true && /réinitialisation/i.test(r.data.message || ''), 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
const mAfter = await db`SELECT * FROM comptes WHERE username = 'm.samsung@concentrix.com'`;
check('mot de passe annulé (NULL) + nouveau jeton d\'activation', mAfter[0].password_hash === null && mAfter[0].activation_token !== null);
check('email ACTIVATION envoyé à l\'email du manager', mailCalls.length === nMailAvant + 1 && mailCalls[mailCalls.length - 1].body.to[0] === 'serge.konan@test.com' && mailCalls[mailCalls.length - 1].body.subject === 'Activation de votre accès');
const newTok = mAfter[0].activation_token;
check('corps de l\'email : lien avec le NOUVEAU jeton', String(mailCalls[mailCalls.length - 1].body.text ?? '').includes('activation=' + newTok));
check('journal email : code ACTIVATION, candidat NULL', (await db`SELECT * FROM envois_email ORDER BY id DESC LIMIT 1`)[0].code === 'ACTIVATION');

const loginAncien = await call(api.login, req('POST', '/api/auth/login', { body: { username: 'm.samsung@concentrix.com', password: 'Manager!2026' } }));
check('ancien mot de passe refusé après forgot (compte inactif)', loginAncien.status === 403 && /activ/i.test(loginAncien.data.message || ''));

r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: newTok, password: 'Nouveau!Pw2026' } }));
check('réactivation via le nouveau lien (nouveau mot de passe)', r.status === 200);
r = await call(api.login, req('POST', '/api/auth/login', { body: { username: 'm.samsung@concentrix.com', password: 'Nouveau!Pw2026' } }));
check('login avec le nouveau mot de passe → ticket 2FA (la 2FA reste active)', r.status === 200 && !!r.data.ticket, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0, 150));
r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: newTok, password: 'Encore!Pw2026' } }));
check('jeton déjà consommé → 400', r.status === 400);

const audW = (await db`SELECT count(*)::int AS n FROM audit_log WHERE action = 'compte.mot_de_passe_oublie'`)[0].n;
check('audit : compte.mot_de_passe_oublie', audW === 1);

// Rejets
r = await call(api.forgot, req('POST', '/api/auth/forgot', { body: { username: 'rh@concentrix.com' } }));
check('forgot (RH/admin) → 400 réservé manager/recruteur', r.status === 400 && /Manager ou Recruteur/i.test(r.data.message || ''));
r = await call(api.forgot, req('POST', '/api/auth/forgot', { body: { username: 'inconnu@concentrix.com' } }));
check('forgot (compte inconnu) → 400', r.status === 400);
r = await call(api.forgot, req('POST', '/api/auth/forgot', { body: { username: 'x@gmail.com' } }));
check('forgot (domaine non @concentrix.com) → 400', r.status === 400);
r = await call(api.forgot, req('GET', '/api/auth/forgot', { token: RH }));
check('forgot GET → 405', r.status === 405);

// ---------- 13. Purge RGPD — journal WhatsApp anonymisé ----------
console.log('\n[11] Purge RGPD — journal WhatsApp anonymisé');
const nWwAvant = (await db`SELECT count(*)::int AS n FROM envois_whatsapp WHERE candidat_id = ${Z}`)[0].n;
check('Z possède un journal WhatsApp', nWwAvant >= 1);
r = await call(api.candidatsPurge, req('POST', `/api/candidats/${Z}/purger`, { token: RH, body: { confirmation: Z } }));
check('purge Z → 200', r.status === 200 && r.data.ok === true, 'status=' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
const wwRestes = await db`SELECT candidat_id, destinataire FROM envois_whatsapp WHERE candidat_id IS NULL`;
check('journal WhatsApp : lignes conservées mais anonymisées', wwRestes.length >= nWwAvant && wwRestes.every((x) => x.candidat_id === null && x.destinataire === '[purge RGPD]'));
const zGone = (await db`SELECT count(*)::int AS n FROM candidats WHERE id = ${Z}`)[0].n;
check('candidat Z supprimé', zGone === 0);

// ---------- Récap ----------
api.__resetEmailFetchForTests();
api.__resetWhatsAppFetchForTests();
console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 9 : ${passed} réussi(s), ${failed} échec(s).`);
await db.end();
await ep.stop();
fs.rmSync(dir, { recursive: true, force: true });
try { fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
