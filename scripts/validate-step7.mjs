#!/usr/bin/env node
/**
 * Validation de l'étape 7 (durcissement : audit, purge RGPD, sauvegardes)
 * sur Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild).
 * 2. Postgres réel embarqué + migrations 0001 + 0002.
 * 3. Bootstrap admin + 1 manager + transport email simulé.
 *
 * Vérifie :
 *  - exhaustivité de l'audit (échecs de connexion inclus, décisions,
 *    affectations, paramètres email) et ABSENCE de données personnelles
 *    des candidats dans le journal ;
 *  - consultation /api/audit (RH) : ordre, filtres (username, action, q),
 *    droits (403 manager, 401 anonyme, 405 POST) ;
 *  - purge RGPD : double confirmation exigée, 403 manager, 400/404,
 *    suppression en cascade (entretiens), anonymisation du journal emails,
 *    ligne d'audit dédiée, irréversibilité ;
 *  - sauvegarde : export JSON (toutes les tables, compteurs) et
 *    RESTAURATION sur un deuxième Postgres réel (comparaison table par
 *    table, dont comptes avec hashes) ;
 *  - audit du front (sections audit + RGPD, bouton purge, mention
 *    connexion, aucune donnée personnelle exposée).
 *
 * Usage : node scripts/validate-step7.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step7-'));
const PORT = 55514;
const PORT2 = 55515;
const ADMIN_EMAIL = 'rh@concentrix.com';
const ADMIN_PW = 'Bootstrap!2026';

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
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step7.mjs');
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

// ---------- 3. Environnement + comptes ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';
process.env.EMAIL_API_KEY_ENC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

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

function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body && !('content-type' in headers)) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Request('http://local.test' + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
check('manager opérationnel', !!MGR);

// Transport email simulé (aucun appel réel).
const emailCalls = [];
api.__setEmailFetchForTests(async () => {
  emailCalls.push(1);
  return { ok: true, status: 202 };
});
check('transport email simulé installé', true);

// ---------- 4. Alimentation de l'audit (exhaustivité) ----------
console.log('\n[3] Audit — alimenté par toutes les opérations sensibles');
r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: 'Mauvais!2026' } }));
check('mot de passe incorrect → 401 + audité', r.status === 401);
let aud = await db`SELECT detail::text AS d FROM audit_log WHERE action = 'login.echec' ORDER BY id DESC LIMIT 1`;
check('login.echec audité (mot_de_passe_incorrect)', aud.length === 1 && /mot_de_passe_incorrect/.test(aud[0].d));
r = await call(api.login, req('POST', '/api/auth/login', { body: { username: 'inconnu@concentrix.com', password: 'Nimporte!2026' } }));
aud = await db`SELECT detail::text AS d FROM audit_log WHERE action = 'login.echec' ORDER BY id DESC LIMIT 1`;
check('compte inconnu → 401 + audité (compte_introuvable_ou_desactive)', r.status === 401 && /compte_introuvable_ou_desactive/.test(aud[0].d));

// Config email active (pour les déclencheurs ci-après).
await call(api.parametresEmail, req('PUT', '/api/parametres/email', { token: RH, body: { fournisseur: 'brevo', api_key: 'cle-test-000', sender_email: 'recrutement@concentrix.com', sender_name: 'Concentrix RH', actif: true } }));

async function makeCandidat(nom, prenom, email) {
  const rr = await call(api.candidatsIndex, req('POST', '/api/candidats', {
    token: RH,
    body: { nom, prenom, email, contact: '01 00 00 00 00', notes: [85, 86, 84], info: { sexe: 'Femme', age: '28', niveau: 'MASTER', domaine: 'Marketing', residence: 'Cotonou' } },
  }));
  if (rr.status !== 201) throw new Error('candidat refusé : ' + JSON.stringify(rr.data));
  return rr.data.id;
}
const P = await makeCandidat('Zoungrana', 'Paméla', 'pamela.zoungrana@test.com');
await call(api.candidatsId, req('PUT', `/api/candidats/${P}`, {
  token: RH,
  body: { identity: { nom: 'Zoungrana', prenom: 'Paméla', email: 'pamela.zoungrana@test.com', contact: '01 00 00 00 00' }, info: { age: '28', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Marketing' }, stages: { rh: { date: '2026-09-30', commentaire: 'Très bon profil', decision: 'ok' } } },
}));
// MAJ info seule (sans étape) → action distincte « candidat.maj ».
await call(api.candidatsId, req('PUT', `/api/candidats/${P}`, {
  token: RH,
  body: { info: { age: '28', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Marketing' } },
}));
await call(api.previvierAffecter, req('POST', `/api/previvier/${P}/affecter`, { token: RH, body: { projet: 'Samsung' } }));
// Seconde connexion RH (2FA déjà configurée) → action « login.twofa_ok ».
{
  const sec = (await db`SELECT totp_secret FROM comptes WHERE username = ${ADMIN_EMAIL}`)[0];
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: r.data.ticket, code: api.totpCodeAt(String(sec.totp_secret), 0) } }));
  RH = r.data.access_token;
}

const audAll = await db`SELECT action FROM audit_log`;
const actions = new Set(audAll.map((a) => a.action));
for (const expected of ['candidat.cree', 'candidat.maj', 'entretien.saisi', 'candidat.affecte', 'parametres.email.maj', 'login.twofa_ok', 'compte.cree', 'login.echec']) {
  check(`audit : « ${expected} » présent`, actions.has(expected));
}
// Aucune donnée personnelle des candidats dans le journal.
const audJson = JSON.stringify((await db`SELECT * FROM audit_log`).map((x) => x));
check('audit : aucune donnée personnelle des candidats (nom/email absents)', !audJson.includes('Paméla') && !audJson.includes('Zoungrana') && !audJson.includes('pamela.zoungrana@test.com'));

// ---------- 5. Consultation /api/audit ----------
console.log('\n[4] Consultation /api/audit');
r = await call(api.auditIndex, req('GET', '/api/audit', { token: RH }));
check('GET audit (RH) → 200 + événements', r.status === 200 && Array.isArray(r.data.events) && r.data.events.length >= 10);
const e0 = r.data.events[0], e1 = r.data.events[1];
check('tri décroissant (le plus récent en premier)', new Date(e0.date) >= new Date(e1.date));
r = await call(api.auditIndex, req('GET', '/api/audit?username=m.samsung%40concentrix.com', { token: RH }));
check('filtre username (manager uniquement)', r.status === 200 && r.data.events.length >= 2 && r.data.events.every((e) => e.username === 'm.samsung@concentrix.com'));
r = await call(api.auditIndex, req('GET', '/api/audit?action=login', { token: RH }));
check('filtre action (préfixe login)', r.status === 200 && r.data.events.every((e) => e.action.startsWith('login')) && r.data.events.length >= 3);
r = await call(api.auditIndex, req('GET', '/api/audit?q=candidat.purge', { token: RH }));
check('recherche libre fonctionnelle (0 résultat pour l\'instant)', r.status === 200 && Array.isArray(r.data.events));
r = await call(api.auditIndex, req('GET', '/api/audit?limit=3', { token: RH }));
check('limit respecté', r.status === 200 && r.data.events.length === 3);
r = await call(api.auditIndex, req('GET', '/api/audit', { token: MGR }));
check('manager → 403', r.status === 403);
r = await call(api.auditIndex, req('GET', '/api/audit'));
check('non authentifié → 401', r.status === 401);
r = await call(api.auditIndex, req('POST', '/api/audit', { token: RH, body: {} }));
check('POST → 405', r.status === 405);

// ---------- 6. Purge RGPD ----------
console.log('\n[5] Purge RGPD');
const nEntAvant = (await db`SELECT count(*)::int AS n FROM entretiens WHERE candidat_id = ${P}`)[0].n;
const nEnvAvant = (await db`SELECT count(*)::int AS n FROM envois_email WHERE candidat_id = ${P}`)[0].n;
check('pré-requis : 1 entretien + 1 email journalisé (RH_OK, v16)', nEntAvant === 1 && nEnvAvant === 1, `ent=${nEntAvant} env=${nEnvAvant}`);

r = await call(api.candidatsPurge, req('POST', `/api/candidats/${P}/purger`, { token: MGR, body: { confirmation: P } }));
check('purge (manager) → 403', r.status === 403);
r = await call(api.candidatsPurge, req('POST', `/api/candidats/${P}/purger`, { token: RH, body: { confirmation: 'autre-id' } }));
check('purge sans confirmation exacte → 400', r.status === 400);
r = await call(api.candidatsPurge, req('POST', `/api/candidats/${P}/purger`, { token: RH }));
check('purge sans corps → 400', r.status === 400);
r = await call(api.candidatsPurge, req('POST', `/api/candidats/c_inexistant/purger`, { token: RH, body: { confirmation: 'c_inexistant' } }));
check('purge d\'un candidat inexistant → 404', r.status === 404);

r = await call(api.candidatsPurge, req('POST', `/api/candidats/${P}/purger`, { token: RH, body: { confirmation: P } }));
check('purge → 200 + compteurs', r.status === 200 && r.data.purgee.entretiens === 1 && r.data.purgee.envois_anonymises === 1, JSON.stringify(r.data));
check('candidat supprimé (404)', (await call(api.candidatsId, req('GET', `/api/candidats/${P}`, { token: RH }))).status === 404);
check('entretiens effacés (cascade)', (await db`SELECT count(*)::int AS n FROM entretiens WHERE candidat_id = ${P}`)[0].n === 0);
const envRestes = await db`SELECT candidat_id, destinataire FROM envois_email WHERE id IN (SELECT id FROM envois_email ORDER BY id DESC LIMIT 10)`;
const anonymes = envRestes.filter((x) => x.destinataire === '[purge RGPD]');
check('traces d\'emails anonymisées (candidat_id NULL, destinataire [purge RGPD])', anonymes.length === 1 && anonymes.every((x) => x.candidat_id === null));
aud = await db`SELECT detail::text AS d, cible_id FROM audit_log WHERE action = 'candidat.purge_rgpd' ORDER BY id DESC LIMIT 1`;
check('purge consignée à l\'audit (sans données personnelles)', aud.length === 1 && aud[0].cible_id === P && !/pamela|zoungrana/i.test(aud[0].d));
r = await call(api.candidatsPurge, req('POST', `/api/candidats/${P}/purger`, { token: RH, body: { confirmation: P } }));
check('purge idempotente → 404 (déjà purgé)', r.status === 404);
r = await call(api.auditIndex, req('GET', '/api/audit?q=purge', { token: RH }));
check('consultation : la purge est trouvable (q=purge)', r.status === 200 && r.data.events.some((e) => e.action === 'candidat.purge_rgpd'));

// ---------- 7. Sauvegarde / restauration ----------
console.log('\n[6] Sauvegarde (db:export) + restauration (db:restore) sur 2e Postgres');
// Candidat de contrôle (P a été purgé juste avant — l'export doit contenir
// au moins un candidat).
const Q = await makeCandidat('Kpode', 'Quentin', 'quentin.kpode@test.com');
const backupsDir = path.join(projectRoot, 'backups');
if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'backup-export.mjs')], { cwd: projectRoot, stdio: 'pipe', env: process.env });
const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.json'));
check('export : fichier JSON écrit', files.length === 1, files.join(','));
const payload = JSON.parse(fs.readFileSync(path.join(backupsDir, files[0]), 'utf8'));
const nCand = (await db`SELECT count(*)::int AS n FROM candidats`)[0].n;
const nAud = (await db`SELECT count(*)::int AS n FROM audit_log`)[0].n;
check('export : compteurs exacts (candidats, audit)', payload.counts.candidats === nCand && payload.counts.audit_log === nAud && payload.counts.candidats >= 1, JSON.stringify(payload.counts));
check('export : toutes les tables présentes', ['templates_email', 'parametres_email', 'parametres_whatsapp', 'comptes', 'candidats', 'entretiens', 'envois_email', 'envois_whatsapp', 'audit_log'].every((t) => Array.isArray(payload.tables[t])));
check('export : clé email chiffrée (pas en clair)', !JSON.stringify(payload).includes('cle-test-000'));

// Deuxième Postgres réel : restauration.
const ep2 = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pgdata2'), user: 'test', password: 'test', port: PORT2, persistent: false });
await ep2.initialise();
await ep2.start();
await ep2.createDatabase('suivi');
const db2 = postgres(`postgres://test:test@127.0.0.1:${PORT2}/suivi`, { max: 1 });
const url2 = `postgres://test:test@127.0.0.1:${PORT2}/suivi`;
execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'backup-export.mjs'), 'restore', path.join('backups', files[0])], {
  cwd: projectRoot,
  stdio: 'pipe',
  env: { ...process.env, DATABASE_URL: url2 },
});
let ok = true;
let detail = '';
for (const t of ['templates_email', 'parametres_email', 'parametres_whatsapp', 'comptes', 'candidats', 'entretiens', 'envois_email', 'envois_whatsapp', 'audit_log']) {
  // Noms de tables issus d'un tableau littéral (jamais d'entrée utilisateur) :
  // concaténation obligatoire (postgres.js binderait ${t} comme paramètre $1).
  const nSrc = (await db.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  const nDst = (await db2.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  if (nSrc !== nDst) {
    ok = false;
    detail += ` ${t}:${nSrc}/${nDst}`;
  }
}
check('restauration : mêmes compteurs sur les 9 tables', ok, detail);
const cSrc = (await db`SELECT id, email FROM candidats LIMIT 1`)[0];
const cDst = (await db2`SELECT id, email FROM candidats WHERE id = ${cSrc.id}`)[0];
check('restauration : contenu identique (échantillon candidat)', !!cDst && cDst.email === cSrc.email);
const hSrc = (await db`SELECT username, password_hash FROM comptes LIMIT 1`)[0];
const hDst = (await db2`SELECT username, password_hash FROM comptes WHERE username = ${hSrc.username}`)[0];
check('restauration : mots de passe (hachés) intacts', !!hDst && hDst.password_hash === hSrc.password_hash);
await db2.end();
await ep2.stop();
fs.rmSync(backupsDir, { recursive: true, force: true });

// ---------- 8. Audit du front ----------
console.log('\n[7] Audit du front (étape 7)');
const front = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
check('front : section journal d\'audit (filtres + table)', front.includes('Journal d\'audit') && front.includes('audit-body') && front.includes('btn-audit-refresh'));
check('front : section Données personnelles (RGPD)', front.includes('Données personnelles (RGPD)') && front.includes('Responsable du traitement'));
check('front : bouton purge (RGPD) + double confirmation', front.includes('modal-purge') && front.includes('PURGER (RGPD)') && front.includes('/purger'));
check('front : mention RGPD sur l\'écran de connexion', /RGPD/.test(front.split('<div class="login-hint">')[1].split('</div>')[0]));

// ---------- Récap ----------
api.__resetEmailFetchForTests();
console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 7 : ${passed} réussi(s), ${failed} échec(s).`);
await db.end();
await ep.stop();
fs.rmSync(dir, { recursive: true, force: true });
try { fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
