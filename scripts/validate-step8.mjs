#!/usr/bin/env node
/**
 * Validation de l'étape 8 (règles métier v16) sur Postgres réel :
 *
 *  - langues : 7 options (Anglais…Portugais) ;
 *  - affectation avec contrôles anti-doublons : une même personne
 *    (même email OU même nom+prénom) n'est affectée qu'à UN projet à la fois,
 *    et n'est jamais re-affectée à un projet déjà traité (tous tours confondus) ;
 *  - affectation directe depuis l'entretien RH (décision OK uniquement,
 *    refus → entretien enregistré + `affectationErreur`) ;
 *  - enregistrement manager refusé (400) si le projet du tour a déjà été
 *    traité sur un autre tour — affectation effacée (retour pré-vivier) ;
 *  - visibilité manager : un candidat déjà reçu sur son projet disparaît
 *    de sa liste ;
 *  - garde-fou d'intégrité : affectation vers un projet déjà traité annulée
 *    au chargement et persistée à la prochaine modification ;
 *  - audit du front (STAGES.hasAffectation, langues, synchro KO, historique).
 *
 * Usage : node scripts/validate-step8.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step8-'));
const PORT = 55519;
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
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step8.mjs');
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
await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0001_init.sql'), 'utf8'));
await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0002_email_templates.sql'), 'utf8'));
check('migrations 0001 + 0002 appliquées', true);

// ---------- 3. Environnement + comptes ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';

console.log('\n[3] Bootstrap admin + managers');
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
const MGR_SAM = await makeAccount({ username: 'm.samsung@concentrix.com', role: 'manager', nom: 'Konan', prenom: 'Serge', email: 'serge.konan@test.com', projet: 'Samsung', pw: 'Manager!2026' });
const MGR_AMZ = await makeAccount({ username: 'm.amazon@concentrix.com', role: 'manager', nom: 'Diallo', prenom: 'Moussa', email: 'moussa.diallo@test.com', projet: 'Amazon', pw: 'Manager!2026' });
check('2 managers opérationnels (Samsung, Amazon)', !!MGR_SAM && !!MGR_AMZ);

// Transport email simulé (aucun appel réel) — l'étape 8 ne change pas les
// déclencheurs, on neutralise juste les envois automatiques.
api.__setEmailFetchForTests(async () => ({ ok: true, status: 202 }));
check('transport email simulé installé', true);

async function makeCandidat(nom, prenom, email) {
  const rr = await call(api.candidatsIndex, req('POST', '/api/candidats', {
    token: RH,
    body: { nom, prenom, email, contact: '01 00 00 00 00', notes: [85, 86, 84], info: { sexe: 'Femme', age: '28', niveau: 'MASTER', domaine: 'Marketing', residence: 'Cotonou' } },
  }));
  if (rr.status !== 201) throw new Error('candidat refusé : ' + JSON.stringify(rr.data));
  return rr.data.id;
}
// Saisie RH via l'API (identité/info inchangées).
async function putRH(id, { decision, projet, commentaire = 'Test étape 8', date = '2026-10-08' }) {
  return call(api.candidatsId, req('PUT', `/api/candidats/${id}`, {
    token: RH,
    body: { stages: { rh: { date, commentaire, decision, ...(projet ? { projet } : {}) } } },
  }));
}
async function putManager(id, token, { decision, commentaire = 'Tour manager test', date = '2026-10-09', key = 'm1' }) {
  // Le tour du manager est déterminé côté serveur ; on renvoie la réponse brute.
  return call(api.candidatsId, req('PUT', `/api/candidats/${id}`, {
    token,
    body: { stages: { [key]: { date, commentaire, decision } } },
  }));
}
async function getCandidat(id, token) {
  const rr = await call(api.candidatsId, req('GET', `/api/candidats/${id}`, { token }));
  return rr;
}
async function listCandidats(token) {
  const rr = await call(api.candidatsIndex, req('GET', '/api/candidats', { token }));
  return rr.data.candidates || [];
}
async function affecter(id, projet, token = RH) {
  return call(api.previvierAffecter, req('POST', `/api/previvier/${id}/affecter`, { token, body: { projet } }));
}

// ---------- 4. Langues (7) ----------
console.log('\n[4] Langues — 7 options (v16)');
check('constante LANGUES : 7 valeurs', api.LANGUES.length === 7, `(${api.LANGUES.join(', ')})`);
check('constante LANGUES : les 4 nouvelles présentes', ['Chinois', 'Allemand', 'Russe', 'Portugais'].every((l) => api.LANGUES.includes(l)));
const front = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
check('front : LANGUES_OPTS à 7 valeurs', /var LANGUES_OPTS = \["Anglais","Espagnol","Arabe","Chinois","Allemand","Russe","Portugais"\];/.test(front));
// Info acceptant les nouvelles langues.
const L1 = await makeCandidat('Langue', 'Test', 'langue.test@test.com');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${L1}`, {
  token: RH,
  body: { info: { age: '28', sexe: 'Femme', residence: 'Cotonou', niveau: 'MASTER', domaine: 'Marketing', langues: ['Anglais', 'Chinois', 'Portugais'], informatique: ['Pack Office'] } },
}));
check('MAJ info : langues v16 acceptées', r.status === 200 && JSON.stringify(r.data.candidat?.langues) === JSON.stringify(['Anglais', 'Chinois', 'Portugais']));

// ---------- 5. Affectation directe depuis l'entretien RH ----------
console.log('\n[5] Affectation directe depuis l\'entretien RH');
const A = await makeCandidat('Adele', 'Adjonkou', 'adele.adj@test.com');
r = await putRH(A, { decision: 'ok', projet: 'Samsung' });
check('RH OK + projet → 200', r.status === 200, JSON.stringify(r.data).slice(0, 120));
check('RH OK + projet → candidat affecté Samsung', r.data.candidat?.projet === 'Samsung');
{
  const row = await db`SELECT projet FROM entretiens WHERE candidat_id = ${A} AND etape = 'RH'`;
  check('RH OK + projet → projet conservé sur la ligne RH', row[0]?.projet === 'Samsung');
}
r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: RH }));
const itemA = (r.data.items || []).find((it) => it.candidat.id === A);
check('RH OK + projet → reste au pré-vivier avec son projet (bouton « Réaffecter »)', !!itemA && itemA.candidat.projet === 'Samsung' && itemA.round === 'm1');

const B = await makeCandidat('Bakari', 'Owona', 'bakari.owona@test.com');
r = await putRH(B, { decision: 'ok' });
check('RH OK sans projet → 200, non affecté', r.status === 200 && r.data.candidat?.projet === '');
{
  const row = await db`SELECT projet FROM entretiens WHERE candidat_id = ${B} AND etape = 'RH'`;
  check('RH OK sans projet → ligne RH projet vide', row[0]?.projet === '');
}

const C = await makeCandidat('Chabi', 'Sossou', 'chabi.sossou@test.com');
r = await putRH(C, { decision: 'ko', projet: 'Samsung' });
check('RH KO + projet → 200 (entretien enregistré)', r.status === 200);
check('RH KO + projet → pas d\'affectation', r.data.candidat?.projet === '' && r.data.candidat?.statut === 'REJET');
{
  const row = await db`SELECT projet FROM entretiens WHERE candidat_id = ${C} AND etape = 'RH'`;
  check('RH KO + projet → projet non conservé (vide)', row[0]?.projet === '');
}
r = await putRH(L1, { decision: 'ok', projet: 'PasUnProjet' });
check('RH OK + projet inconnu → 400', r.status === 400);

// Doublon : même personne (même nom+prénom, email différent) déjà affectée
// ailleurs → l'affectation de la seconde fiche est refusée.
const D1 = await makeCandidat('Doumbia', 'Fatou', 'fatou.d1@test.com');
const D2 = await makeCandidat('Doumbia', 'Fatou', 'fatou.d2@test.com');
r = await putRH(D1, { decision: 'ok', projet: 'Amazon' });
check('doublon D1 : RH OK + Amazon', r.status === 200 && r.data.candidat?.projet === 'Amazon');
r = await putRH(D2, { decision: 'ok', projet: 'Samsung' });
check('doublon D2 : RH OK + Samsung → refusé (déjà affecté ailleurs)', r.status === 200 && r.data.candidat?.projet === '' && /existe en double/.test(r.data.affectationErreur || ''), JSON.stringify(r.data).slice(0, 160));
check('doublon D2 : message d\'affectationErreur renvoyé', !!r.data.affectationErreur);

// Doublon : la fiche jumelle a déjà été reçue sur ce projet.
const E1 = await makeCandidat('Eyenga', 'Koffi', 'eyenga.e1@test.com');
const E2 = await makeCandidat('Eyenga', 'Koffi', 'eyenga.e2@test.com');
r = await putRH(E1, { decision: 'ok', projet: 'Amazon' });
check('E1 : RH OK + Amazon', r.status === 200);
r = await putManager(E1, MGR_AMZ, { decision: 'ko' }); // E1 passe M1 KO chez Amazon
check('E1 : M1 KO Amazon (manager)', r.status === 200, JSON.stringify(r.data).slice(0, 120));
r = await putRH(E2, { decision: 'ok', projet: 'Amazon' });
check('E2 : RH OK + Amazon → refusé (jumelle déjà reçue sur ce projet)', r.status === 200 && r.data.candidat?.projet === '' && /fiche en double/.test(r.data.affectationErreur || ''), JSON.stringify(r.data.affectationErreur || ''));

// ---------- 6. Affectation pré-vivier (contrôles renforcés) ----------
console.log('\n[6] Affectation pré-vivier — contrôles v16');
const F1 = await makeCandidat('Fagla', 'Hounkpatin', 'fagla.h@test.com');
r = await putRH(F1, { decision: 'ok' });
check('F1 : RH OK (pré-vivier)', r.status === 200);
r = await affecter(F1, 'Amazon');
check('F1 : affectation Amazon → 200', r.status === 200 && r.data.projet === 'Amazon');
r = await putManager(F1, MGR_AMZ, { decision: 'ko' });
check('F1 : M1 KO Amazon → retour pré-vivier, projet effacé', r.status === 200 && r.data.candidat?.projet === '');
r = await affecter(F1, 'Amazon');
check('F1 : ré-affectation Amazon → 400 (déjà reçu)', r.status === 400 && /déjà effectué un entretien/.test(r.data.message || ''), JSON.stringify(r.data).slice(0, 160));
r = await affecter(F1, 'Samsung');
check('F1 : affectation Samsung → 200', r.status === 200);
r = await affecter(D2, 'Samsung');
check('D2 (doublon de D1@Amazon) : affectation Samsung → 400', r.status === 400 && /existe en double/.test(r.data.message || ''), JSON.stringify(r.data.message || ''));

// ---------- 7. Contrôle bloquant du manager ----------
console.log('\n[7] Contrôle bloquant de l\'enregistrement manager');
// F1 : tour M2 Samsung par le manager Samsung (normal — M1 KO débloque M2).
r = await putManager(F1, MGR_SAM, { decision: 'mb', key: 'm2' });
check('F1 : M2 MB Samsung → 200, retour pré-vivier', r.status === 200 && r.data.candidat?.projet === '');

// G1 : affectation invalide en base (données legacy) — au chargement, le
// garde-fou la normalise (projet vide) ; le manager ne peut donc plus
// enregistrer (403 « non affecté »), et la correction est persistée à la
// prochaine modification réussie de la fiche.
const G1 = await makeCandidat('Gnassingbe', 'Amoussou', 'gnassingbe.a@test.com');
r = await putRH(G1, { decision: 'ok', projet: 'Samsung' });
check('G1 : RH OK + Samsung', r.status === 200);
r = await putManager(G1, MGR_SAM, { decision: 'ko' });
check('G1 : M1 KO Samsung', r.status === 200);
await db`UPDATE candidats SET projet = 'Samsung' WHERE id = ${G1}`; // état legacy invalide
r = await putManager(G1, MGR_SAM, { decision: 'ko', commentaire: 'M2 illégitime', date: '2026-10-10', key: 'm2' });
// Le tour de G1 est maintenant M2 (M1 KO débloque M2) — mais l'affectation
// « Samsung » (déjà traité) a été annulée au chargement → non affecté.
check('G1 : M2 sur affectation legacy invalide → 403 (non affecté)', r.status === 403, JSON.stringify(r.data).slice(0, 160));
r = await call(api.candidatsId, req('PUT', `/api/candidats/${G1}`, {
  token: RH,
  body: { info: { age: '30', sexe: 'Homme', residence: 'Parakou', niveau: 'BAC', domaine: 'Logistique' } },
}));
check('G1 : MAJ info RH → 200', r.status === 200);
{
  const row = await db`SELECT projet FROM candidats WHERE id = ${G1}`;
  check('G1 : affectation legacy effacée (persistée au chargement)', row[0].projet === '');
}

// ---------- 8. Visibilité manager ----------
console.log('\n[8] Visibilité manager — jamais deux fois le même projet');
// H1 : le manager Amazon ne voit pas H1 si H1 a déjà été reçu chez Amazon.
const H1 = await makeCandidat('Houngbédji', 'Clarisse', 'houngbedji.c@test.com');
r = await putRH(H1, { decision: 'ok', projet: 'Amazon' });
check('H1 : RH OK + Amazon', r.status === 200);
r = await putManager(H1, MGR_AMZ, { decision: 'ko' });
check('H1 : M1 KO Amazon', r.status === 200);
await db`UPDATE candidats SET projet = 'Amazon' WHERE id = ${H1}`; // état legacy invalide
r = await getCandidat(H1, MGR_AMZ);
check('H1 : manager Amazon → 404 (candidat déjà reçu chez lui, invisible)', r.status === 404, `statut=${r.status}`);
{
  const list = await listCandidats(MGR_AMZ);
  check('H1 : absent de la liste du manager Amazon', !list.some((x) => x.id === H1));
}
// Et le garde-fou a corrigé l'état au chargement → H1 visible par le RH sans projet.
r = await getCandidat(H1, RH);
check('H1 : le RH voit H1 (projet corrigé à vide)', r.status === 200 && r.data.candidat?.projet === '');

// I1 : candidat sain chez Amazon → visible par le manager Amazon.
const I1 = await makeCandidat('Iba', 'Tossave', 'iba.t@test.com');
r = await putRH(I1, { decision: 'ok', projet: 'Amazon' });
check('I1 : RH OK + Amazon', r.status === 200);
r = await getCandidat(I1, MGR_AMZ);
check('I1 : visible par le manager Amazon (première fois)', r.status === 200);

// ---------- 8b. SELECTED conserve son projet ----------
console.log('\n[8b] Garde-fou — ne touche pas le projet d\'un candidat SELECTED');
const K1 = await makeCandidat('Kpade', 'Sena', 'kpade.sena@test.com');
r = await putRH(K1, { decision: 'ok', projet: 'Samsung' });
check('K1 : RH OK + Samsung', r.status === 200);
r = await putManager(K1, MGR_SAM, { decision: 'ok' });
check('K1 : M1 OK Samsung → SELECTED', r.status === 200 && r.data.candidat?.statut === 'SELECTED');
check('K1 : SELECTED conserve son projet (réponse)', r.data.candidat?.projet === 'Samsung');
r = await getCandidat(K1, RH); // rechargement : le garde-fou ne doit rien effacer
check('K1 : SELECTED conserve son projet (rechargement)', r.status === 200 && r.data.candidat?.projet === 'Samsung');
{
  const row = await db`SELECT projet FROM candidats WHERE id = ${K1}`;
  check('K1 : projet SELECTED intact en base', row[0].projet === 'Samsung');
}

// ---------- 9. Garde-fou d'intégrité (persistance) ----------
console.log('\n[9] Garde-fou d\'intégrité — correction persistée');
// J1 : affectation legacy invalide ; une MAJ quelconque la persiste à vide.
const J1 = await makeCandidat('Jakpa', 'Rémy', 'jakpa.r@test.com');
r = await putRH(J1, { decision: 'ok', projet: 'Samsung' });
r = await putManager(J1, MGR_SAM, { decision: 'ko' });
check('J1 : RH OK + Samsung puis M1 KO', r.status === 200);
await db`UPDATE candidats SET projet = 'Samsung' WHERE id = ${J1}`;
r = await getCandidat(J1, RH);
check('J1 : au chargement, projet corrigé à vide (mémoire)', r.data.candidat?.projet === '');
r = await call(api.candidatsId, req('PUT', `/api/candidats/${J1}`, {
  token: RH,
  body: { info: { age: '29', sexe: 'Homme', residence: 'Porto-Novo', niveau: 'BAC', domaine: 'Informatique' } },
}));
{
  const row = await db`SELECT projet FROM candidats WHERE id = ${J1}`;
  check('J1 : après MAJ, correction persistée en base', row[0].projet === '');
}

// ---------- 10. Audit du front ----------
console.log('\n[10] Audit du front (v16)');
check('front : STAGES rh a hasAffectation', /key:"rh"[^}]*hasAffectation:true/.test(front));
check('front : champ « Affecter au projet / poste correspondant »', front.includes('Affecter au projet / poste correspondant'));
check('front : synchro KO → champ vidé et désactivé', front.includes('syncAffectationWithDecision'));
check('front : alerte affectation refusée depuis l\'entretien RH', front.includes('L\'entretien RH a bien été enregistré, mais l\'affectation n\'a pas pu être appliquée'));
check('front : historique — affectation RH non rappelée', front.includes("if(d.projet && !s.hasAffectation) rows.push([\"Projet\", d.projet])"));
check('front : options « déjà reçu en entretien » désactivées', front.includes('(déjà reçu en entretien)'));

// ---------- Récap ----------
console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 8 : ${passed} réussi(s), ${failed} échec(s).`);
await db.end();
await ep.stop();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
