#!/usr/bin/env node
/**
 * Validation de l'étape 5 (emails) sur Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild).
 * 2. Postgres réel embarqué + migrations 0001 + 0002.
 * 3. Bootstrap admin + 1 manager (Samsung).
 * 4. Couche HTTP des adaptateurs REMPLACÉE par un faux transport (aucun
 *    appel réel aux fournisseurs) ; la config email (fournisseur/clé/
 *    expéditeur/templates) est manipulée via les API Paramètres > Email.
 *
 * Vérifie : configuration (clé chiffrée en base, jamais retournée,
 * préservation si vide), validation des champs, templates personnalisés,
 * déclencheurs (PREVIVER après RH OK, AFFECTATION_PROJET, SELECTED après OK
 * manager), rendu des variables, bascule « actif », absence de clé,
 * adaptateurs resend/brevo/sendgrid, échec d'envoi journalisé sans bloquer
 * la décision, email de test, journal, audit, droits (403/401).
 *
 * Usage : node scripts/validate-step5.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step5-'));
const PORT = 55516;
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
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step5.mjs');
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

// ---------- 2. Postgres + migrations 0001 + 0002 ----------
console.log('\n[2] Postgres réel + migrations');
const ep = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pgdata'), user: 'test', password: 'test', port: PORT, persistent: false });
await ep.initialise();
await ep.start();
await ep.createDatabase('suivi');
const db = postgres(`postgres://test:test@127.0.0.1:${PORT}/suivi`, { max: 1 });
try {
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0001_init.sql'), 'utf8'));
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0002_email_templates.sql'), 'utf8'));
  check('migrations 0001 + 0002 appliquées', true);
} catch (e) {
  check('migrations 0001 + 0002 appliquées', false, e.message.slice(0, 160));
  throw e;
}
const tplAffect = await db`SELECT corps, objet FROM templates_email WHERE code = 'AFFECTATION_PROJET'`;
check('template affectation : {{etape}} présent, plus de « (date : »', tplAffect[0].corps.includes('{{etape}}') && !tplAffect[0].corps.includes('(date :'), String(tplAffect[0].corps).slice(0, 80));

// ---------- 3. Environnement ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';
process.env.EMAIL_API_KEY_ENC = ENC_KEY;

// ---------- 4. Bootstrap admin + comptes ----------
console.log('\n[3] Bootstrap admin + manager');
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

function req(method, p, { body, token, raw } = {}) {
  const headers = {};
  if (body && !raw) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Request('http://local.test' + p, {
    method,
    headers,
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(fn, r) {
  const res = await fn(r);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let RH;
let r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.setup.secret, 0) } }));
RH = r.data.access_token;
check('connexion RH + 2FA', !!RH);

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
check('manager Samsung opérationnel', !!MGR);

// ---------- 5. Faux transport email ----------
const calls = [];
let failNext = false;
api.__setEmailFetchForTests(async (url, init) => {
  calls.push({ url, headers: init.headers || {}, body: JSON.parse(init.body) });
  if (failNext) {
    failNext = false;
    return { ok: false, status: 500 };
  }
  return { ok: true, status: 202 };
});
check('faux transport installé (aucun appel réel aux fournisseurs)', true);

// ---------- 6. Lecture de la configuration ----------
console.log('\n[4] Configuration — lecture');
r = await call(api.parametresEmail, req('GET', '/api/parametres/email', { token: RH }));
check('GET config (RH) : défauts', r.status === 200 && r.data.fournisseur === 'resend' && r.data.actif === false && r.data.has_key === false && r.data.templates.length === 3, JSON.stringify(r.data).slice(0, 120));
check('GET config (RH) : 3 templates attendus', r.data.templates.map((t) => t.code).sort().join(',') === 'AFFECTATION_PROJET,PREVIVER,SELECTED');
r = await call(api.parametresEmail, req('GET', '/api/parametres/email', { token: MGR }));
check('GET config (manager) → 403', r.status === 403);
r = await call(api.parametresEmail, req('GET', '/api/parametres/email'));
check('GET config (non authentifié) → 401', r.status === 401);

// ---------- 7. Écriture de la configuration ----------
console.log('\n[5] Configuration — écriture + chiffrement');
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', {
  token: RH,
  body: { fournisseur: 'brevo', api_key: 'brevo-test-key-123', sender_email: 'recrutement@concentrix.com', sender_name: 'Concentrix RH', actif: true },
}));
check('PUT config brevo + clé + expéditeur + actif', r.status === 200 && r.data.has_key === true && r.data.fournisseur === 'brevo');

let row = await db`SELECT api_key FROM parametres_email WHERE id = 1`;
check('clé chiffrée en base (v1:…, jamais en clair)', String(row[0].api_key).startsWith('v1:') && !String(row[0].api_key).includes('brevo-test-key-123'));

r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { actif: true } }));
row = await db`SELECT api_key FROM parametres_email WHERE id = 1`;
check('clé conservée si non fournie', String(row[0].api_key).startsWith('v1:') && r.status === 200);

const before = String(row[0].api_key);
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { api_key: '' } }));
row = await db`SELECT api_key FROM parametres_email WHERE id = 1`;
check('clé conservée si fournie vide', String(row[0].api_key) === before);

r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { fournisseur: 'mailgun' } }));
check('fournisseur inconnu → 400', r.status === 400);
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { sender_email: 'pas-un-email' } }));
check("expéditeur invalide → 400", r.status === 400);
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: MGR, body: { fournisseur: 'resend' } }));
check('PUT config (manager) → 403', r.status === 403);

// ---------- 8. Templates personnalisés ----------
console.log('\n[6] Templates — personnalisation');
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', {
  token: RH,
  body: {
    templates: [
      { code: 'SELECTED', objet: 'RETENU — {{projet}} (test)', corps: 'Bonjour {{prenom}} {{candidat}},\n\nCandidature retenue (projet {{projet}}, moyenne {{score}}).\n\nCDT-EQUIPE-RH-TEST' },
    ],
  },
}));
check('PUT template SELECTED personnalisé', r.status === 200);
r = await call(api.parametresEmail, req('GET', '/api/parametres/email', { token: RH }));
const tplSel = r.data.templates.find((t) => t.code === 'SELECTED');
check('template personnalisé persisté', tplSel && tplSel.objet === 'RETENU — {{projet}} (test)' && tplSel.corps.includes('CDT-EQUIPE-RH-TEST'));
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { templates: [{ code: 'INVENTE', objet: 'x', corps: 'y' }] } }));
check('template inconnu → 400', r.status === 400);

// ---------- 9. Déclencheurs sur le parcours d'Awa ----------
console.log('\n[7] Déclencheurs — parcours complet (Awa Traoré)');
async function makeCandidat(nom, prenom, email) {
  const rr = await call(api.candidatsIndex, req('POST', '/api/candidats', {
    token: RH,
    body: {
      nom, prenom, email, contact: '01 00 00 00 00', notes: [85, 90, 88],
      info: { sexe: 'Femme', age: '28', niveau: 'MASTER', domaine: 'Marketing', residence: 'Cotonou' },
    },
  }));
  if (rr.status !== 201) throw new Error('candidat refusé : ' + JSON.stringify(rr.data));
  return rr.data.id;
}
const A = await makeCandidat('Traoré', 'Awa', 'awa.traore@test.com');
check('candidat A créé (moyenne 87.7)', calls.length === 0);

r = await call(api.candidatsId, req('PUT', `/api/candidats/${A}`, {
  token: RH,
  body: { identity: { nom: 'Traoré', prenom: 'Awa', email: 'awa.traore@test.com', contact: '01 00 00 00 00' }, info: { age: '28', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Marketing' }, stages: { rh: { date: '2026-09-28', commentaire: 'Très bon profil', decision: 'ok' } } },
}));
check('RH OK → 200 + statut PRÉ-VIVIER', r.status === 200 && r.data.candidat.statut === 'PREVIVER');
check('email PREVIVER envoyé (1 appel Brevo)', calls.length === 1 && calls[0].url === 'https://api.brevo.com/v3/smtp/email');
check('payload Brevo : clé + expéditeur + destinataire', calls[0].headers['api-key'] === 'brevo-test-key-123' && calls[0].body.sender.email === 'recrutement@concentrix.com' && calls[0].body.to[0].email === 'awa.traore@test.com');
check('rendu PREVIVER : prénoms + objet', calls[0].body.textContent.includes('Awa') && calls[0].body.textContent.includes('Traoré') && calls[0].body.subject === 'Votre candidature — prochaine étape');

r = await call(api.previvierAffecter, req('POST', `/api/previvier/${A}/affecter`, { token: RH, body: { projet: 'Samsung' } }));
check('affectation Samsung → 200', r.status === 200 && r.data.projet === 'Samsung');
check('email AFFECTATION_PROJET envoyé', calls.length === 2 && calls[1].body.textContent.includes('Samsung') && calls[1].body.textContent.includes('Entretien Manager 1') && calls[1].body.subject.includes('Samsung'));

r = await call(api.candidatsId, req('PUT', `/api/candidats/${A}`, {
  token: MGR,
  body: { stages: { m1: { date: '2026-09-29', commentaire: 'Excellente maîtrise', decision: 'ok' } } },
}));
check('OK manager M1 → SELECTED', r.status === 200 && r.data.candidat.statut === 'SELECTED');
check('email SELECTED = TEMPLATE PERSONNALISÉ (contenu admin)', calls.length === 3 && calls[2].body.textContent.includes('CDT-EQUIPE-RH-TEST') && calls[2].body.textContent.includes('87.7') && calls[2].body.subject === 'RETENU — Samsung (test)');

const j1 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('journal : 3 envois, tous envoyés, candidat nommé', j1.length === 3 && j1.every((e) => e.statut === 'envoye' && e.candidat === 'Awa Traoré' && e.fournisseur === 'brevo'));
check('journal : ordre et codes (SELECTED le plus récent)', j1[0].code === 'SELECTED' && j1[1].code === 'AFFECTATION_PROJET' && j1[2].code === 'PREVIVER');
check('rendu : aucun placeholder résiduel {{…}}', calls.every((c) => !c.body.textContent.includes('{{') && !c.body.subject.includes('{{')));

r = await call(api.candidatsId, req('PUT', `/api/candidats/${A}`, {
  token: RH,
  body: { info: { age: '28', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Marketing' } },
}));
check('MAJ info sans transition → aucun email', r.status === 200 && calls.length === 3);

// ---------- 10. Bascule « actif » + absence de clé ----------
console.log('\n[8] Bascule actif / absence de clé');
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { actif: false } }));
const B = await makeCandidat('Dosso', 'Bénin', 'benin.dosso@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${B}`, { token: RH, body: { identity: { nom: 'Dosso', prenom: 'Bénin', email: 'benin.dosso@test.com', contact: '01 00 00 00 00' }, info: { age: '25', sexe: 'Homme', residence: 'Parakou', niveau: 'BAC' }, stages: { rh: { date: '2026-09-28', commentaire: 'OK', decision: 'ok' } } } }));
const j2 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('actif désactivé → décision OK, email « ignoré »', r.status === 200 && r.data.candidat.statut === 'PREVIVER' && calls.length === 3 && j2[0].code === 'PREVIVER' && j2[0].statut === 'ignore' && /désactiv/i.test(j2[0].detail || ''));

r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { actif: true, remove_api_key: true } }));
r = await call(api.parametresEmail, req('GET', '/api/parametres/email', { token: RH }));
check('remove_api_key → has_key false', r.status === 200 && r.data.has_key === false);
const C = await makeCandidat('Gbaguidi', 'Clara', 'clara.gbaguidi@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${C}`, { token: RH, body: { identity: { nom: 'Gbaguidi', prenom: 'Clara', email: 'clara.gbaguidi@test.com', contact: '01 00 00 00 00' }, info: { age: '30', sexe: 'Femme', residence: 'Lokossa', niveau: 'LICENCE', domaine: 'Finance' }, stages: { rh: { date: '2026-09-28', commentaire: 'OK', decision: 'ok' } } } }));
const j3 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('clé absente → email « ignoré » (cause lisible)', r.status === 200 && calls.length === 3 && j3[0].code === 'PREVIVER' && j3[0].statut === 'ignore' && /Clé API non configurée/i.test(j3[0].detail || ''));

// ---------- 11. Adaptateurs resend / sendgrid ----------
console.log('\n[9] Adaptateurs — resend, sendgrid, échec');
r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { fournisseur: 'resend', api_key: 'resend-test-key-456', sender_email: 'recrutement@concentrix.com', sender_name: 'Concentrix RH' } }));
const D = await makeCandidat('Hounkpatin', 'Didier', 'didier.hounkpatin@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${D}`, { token: RH, body: { identity: { nom: 'Hounkpatin', prenom: 'Didier', email: 'didier.hounkpatin@test.com', contact: '01 00 00 00 00' }, info: { age: '27', sexe: 'Homme', residence: 'Bohicon', niveau: 'MASTER', domaine: 'IT' }, stages: { rh: { date: '2026-09-28', commentaire: 'OK', decision: 'ok' } } } }));
check('adaptateur Resend : URL + Bearer + from/to', calls.length === 4 && calls[3].url === 'https://api.resend.com/emails' && calls[3].headers.authorization === 'Bearer resend-test-key-456' && calls[3].body.from.includes('recrutement@concentrix.com') && calls[3].body.to[0] === 'didier.hounkpatin@test.com');

r = await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { fournisseur: 'sendgrid', api_key: 'SG.test-key-789' } }));
const E = await makeCandidat('Tchibozo', 'Estelle', 'estelle.tchibozo@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${E}`, { token: RH, body: { identity: { nom: 'Tchibozo', prenom: 'Estelle', email: 'estelle.tchibozo@test.com', contact: '01 00 00 00 00' }, info: { age: '26', sexe: 'Femme', residence: 'Porto-Novo', niveau: 'THESE', domaine: 'Recherche' }, stages: { rh: { date: '2026-09-28', commentaire: 'OK', decision: 'ok' } } } }));
check('adaptateur SendGrid : URL + Bearer + personalizations', calls.length === 5 && calls[4].url === 'https://api.sendgrid.com/v3/mail/send' && calls[4].headers.authorization === 'Bearer SG.test-key-789' && calls[4].body.personalizations[0].to[0].email === 'estelle.tchibozo@test.com' && calls[4].body.from.email === 'recrutement@concentrix.com');

failNext = true;
const F = await makeCandidat('Akueson', 'Félix', 'felix.akueson@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${F}`, { token: RH, body: { identity: { nom: 'Akueson', prenom: 'Félix', email: 'felix.akueson@test.com', contact: '01 00 00 00 00' }, info: { age: '24', sexe: 'Homme', residence: 'Abomey-Calavi', niveau: 'BAC' }, stages: { rh: { date: '2026-09-28', commentaire: 'OK', decision: 'ok' } } } }));
const j4 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('échec fournisseur → décision conservée + « échec » journalisé', r.status === 200 && r.data.candidat.statut === 'PREVIVER' && calls.length === 6 && j4[0].statut === 'echec' && /HTTP 500/.test(j4[0].detail || ''));

// ---------- 12. Email de test ----------
console.log('\n[10] Email de test + journal + audit');
r = await call(api.parametresEmailTest, req('POST', '/api/parametres/email/test', { token: RH, body: { destinataire: 'rh@concentrix.com' } }));
const j5 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('email de test envoyé (code TEST, sans candidat)', r.status === 200 && calls.length === 7 && j5[0].code === 'TEST' && j5[0].destinataire === 'rh@concentrix.com' && j5[0].statut === 'envoye' && j5[0].candidat === null);
r = await call(api.parametresEmailTest, req('POST', '/api/parametres/email/test', { token: RH, body: { destinataire: 'x' } }));
check('test : destinataire invalide → 400', r.status === 400);
r = await call(api.parametresEmailTest, req('POST', '/api/parametres/email/test', { token: MGR, body: { destinataire: 'rh@concentrix.com' } }));
check('test : manager → 403', r.status === 403);
failNext = true;
r = await call(api.parametresEmailTest, req('POST', '/api/parametres/email/test', { token: RH, body: { destinataire: 'rh@concentrix.com' } }));
const j6 = (await call(api.parametresEmailEnvois, req('GET', '/api/parametres/email/envois', { token: RH }))).data.envois;
check('test : échec fournisseur → 502 + « échec » journalisé', r.status === 502 && j6[0].code === 'TEST' && j6[0].statut === 'echec');

const aud = await db`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('parametres.email.maj', 'parametres.email.test')`;
check('audit alimenté (parametres.email.≥3)', aud[0].n >= 3, `n=${aud[0].n}`);

// ---------- 13. Chiffrement — round trip ----------
console.log('\n[11] Chiffrement — round trip');
const finalRow = await db`SELECT api_key FROM parametres_email WHERE id = 1`;
check('décryptage en base = clé saisie (round trip AES-256-GCM)', api.decryptApiKey(String(finalRow[0].api_key)) === 'SG.test-key-789');
check('8 appels transport simulés au total (aucun réel)', calls.length === 8);

// ---------- Récap ----------
api.__resetEmailFetchForTests();
console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 5 : ${passed} réussi(s), ${failed} échec(s).`);
await db.end();
await ep.stop();
fs.rmSync(dir, { recursive: true, force: true });
try { fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
