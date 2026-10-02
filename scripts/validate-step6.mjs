#!/usr/bin/env node
/**
 * Validation de l'étape 6 (Geoapify via proxy API + autocomplétion) sur
 * Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild).
 * 2. Postgres réel embarqué + migrations 0001 + 0002.
 * 3. Bootstrap admin + 1 manager (périmètre du proxy : tout compte authentifié).
 * 4. Couche HTTP du proxy REMPLACÉE par un faux transport (aucun appel réel
 *    à Geoapify) ; la clé est un env de test.
 *
 * Vérifie : auth (401), validation q (400), normalisation des résultats
 * (seuls les champs consommés), limite (défaut 6 / max 8 / min 1), HTTPS
 * forcé + filtre Bénin + français sur l'URL amont, clé présente en amont et
 * JAMAIS dans la réponse, rôles (manager OK), échecs amont (502), JSON
 * invalide (200 vide, gracieux), clé absente (503 explicite), 405, et
 * audit du front (aucune clé en dur, autocomplétion branchée sur le proxy).
 *
 * Usage : node scripts/validate-step6.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step6-'));
const PORT = 55518;
const ADMIN_EMAIL = 'rh@concentrix.com';
const ADMIN_PW = 'Bootstrap!2026';
const GEO_KEY = 'geo-test-key-000';

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
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step6.mjs');
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
  check('migrations 0001 + 0002 appliquées', true);
} catch (e) {
  check('migrations 0001 + 0002 appliquées', false, e.message.slice(0, 160));
  throw e;
}

// ---------- 3. Environnement ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';
process.env.GEOAPIFY_API_KEY = GEO_KEY;

// ---------- 4. Bootstrap admin + manager ----------
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

// ---------- 5. Faux transport Geoapify ----------
const canned = [
  { formatted: 'Cotonou, Littoral, Bénin', city: 'Cotonou', state: 'Littoral', county: '', lat: 6.3728613, lon: 2.3917597, geocode_id: 'x1' },
  { formatted: 'Porto-Novo, Ouémé, Bénin', city: 'Porto-Novo', state: 'Ouémé', county: '', lat: 6.4965309, lon: 2.6038474, geocode_id: 'x2' },
  { formatted: 'Abomey-Calavi, Atlantique, Bénin', city: 'Abomey-Calavi', state: 'Atlantique', county: '', lat: 6.2914, lon: 2.3085 },
  { formatted: 'Parakou, Alibori, Bénin', city: 'Parakou', state: 'Alibori', county: '', lat: 9.3384, lon: 2.6305 },
  { formatted: 'Lokossa, Couffo, Bénin', city: 'Lokossa', state: 'Couffo', county: '', lat: 6.9436, lon: 1.9834 },
  { formatted: 'Bohicon, Plateau, Bénin', city: 'Bohicon', state: 'Plateau', county: '', lat: 7.2005, lon: 2.6205 },
  { formatted: 'Dassa-Zoumé, Zou, Bénin', city: 'Dassa-Zoumé', state: 'Zou', county: '', lat: 7.5394, lon: 2.6522 },
  { formatted: 'Natitingou, Atacora, Bénin', city: 'Natitingou', state: 'Atacora', county: '', lat: 10.3156, lon: 1.9834 },
  { formatted: 'Abomey, Collines, Bénin', city: 'Abomey', state: 'Collines', county: '', lat: 7.1812, lon: 2.6305 },
  { formatted: 'Canet, Mono, Bénin', city: 'Canet', state: 'Mono', county: '', lat: 7.06, lon: 1.8 },
];
const geoCalls = [];
let geoBehavior = 'ok'; // ok | http401 | http500 | throw | badjson
api.__setGeoFetchForTests(async (url) => {
  geoCalls.push(url);
  if (geoBehavior === 'throw') throw new Error('network down');
  const status = geoBehavior === 'http401' ? 401 : geoBehavior === 'http500' ? 500 : 200;
  return {
    ok: status === 200,
    status,
    json: async () => {
      if (geoBehavior === 'badjson') throw new Error('bad json');
      return { results: canned };
    },
  };
});
check('faux transport Geoapify installé (aucun appel réel)', true);

// ---------- 6. Proxy ----------
console.log('\n[4] Proxy /api/geo/search');
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton'));
check('non authentifié → 401', r.status === 401);
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
// (le faux transport a intercepté, mais on vérifie d'abord la validation ci-dessous)

r = await call(api.geoSearch, req('GET', '/api/geo/search?q=a', { token: RH }));
check('q trop courte (1 caractère) → 400', r.status === 400);
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=' + 'x'.repeat(121), { token: RH }));
check('q trop longue (121 caractères) → 400', r.status === 400);
r = await call(api.geoSearch, req('POST', '/api/geo/search?q=Coton', { token: RH, body: {} }));
check('POST → 405', r.status === 405);

geoCalls.length = 0;
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('recherche valide → 200, 6 résultats par défaut', r.status === 200 && r.data.results.length === 6);
check('résultat normalisé (champs consommés uniquement)', JSON.stringify(Object.keys(r.data.results[0]).sort()) === JSON.stringify(['city', 'county', 'formatted', 'lat', 'lon', 'state']) && r.data.results[0].formatted === 'Cotonou, Littoral, Bénin' && typeof r.data.results[0].lat === 'number');
const upUrl = geoCalls[0] || '';
check('amont : HTTPS + filtre Bénin + français + texte', upUrl.startsWith('https://api.geoapify.com/v1/geocode/autocomplete?') && upUrl.includes('filter=countrycode:bj') && upUrl.includes('lang=fr') && upUrl.includes('text=Coton'));
check('amont : clé présente', upUrl.includes('apiKey=' + encodeURIComponent(GEO_KEY)));
check('réponse : clé JAMAIS exposée', !JSON.stringify(r.data).includes(GEO_KEY));
check('1 seul appel amont par recherche', geoCalls.length === 1);

geoCalls.length = 0;
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Porto&limit=3', { token: RH }));
check('limit=3 → 3 résultats', r.status === 200 && r.data.results.length === 3);
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Porto&limit=99', { token: RH }));
check('limit=99 → 8 (plafond)', r.status === 200 && r.data.results.length === 8);
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Porto&limit=0', { token: RH }));
check('limit=0 → 1 (minimum)', r.status === 200 && r.data.results.length === 1);

r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: MGR }));
check('manager (tout compte authentifié) → 200', r.status === 200 && r.data.results.length === 6);

console.log('\n[5] Proxy — échecs amont et config');
geoBehavior = 'http401';
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('amont 401 → 502 explicite', r.status === 502 && /HTTP 401/.test(r.data.message || ''));
geoBehavior = 'http500';
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('amont 500 → 502 explicite', r.status === 502 && /HTTP 500/.test(r.data.message || ''));
geoBehavior = 'throw';
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('réseau indisponible → 502 « inaccessible »', r.status === 502 && /inaccessible/i.test(r.data.message || ''));
geoBehavior = 'badjson';
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('JSON amont invalide → 200 + liste vide (gracieux)', r.status === 200 && Array.isArray(r.data.results) && r.data.results.length === 0);
geoBehavior = 'ok';

delete process.env.GEOAPIFY_API_KEY;
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('clé absente → 503 + message (env GEOAPIFY_API_KEY)', r.status === 503 && /GEOAPIFY_API_KEY/.test(r.data.message || ''));
process.env.GEOAPIFY_API_KEY = GEO_KEY;
r = await call(api.geoSearch, req('GET', '/api/geo/search?q=Coton', { token: RH }));
check('clé restaurée → 200', r.status === 200 && r.data.results.length === 6);

// ---------- 7. Audit du front et du dépôt ----------
console.log('\n[6] Audit — aucune clé en dur, autocomplétion branchée');
const front = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
check('front : aucune clé Geoapify en dur', !/GEOAPIFY_API_KEY/.test(front) && !(/[a-f0-9]{32}/i.test(front) && /geoapify/i.test(front)) && !/apiKey=/.test(front));
check('front : autocomplétion branchée sur le proxy', front.includes('/api/geo/search?q=') && front.includes('geoapify-suggestions') && front.includes('wireResidenceMap()'));
check('front : CSS + hint résidence restaurés', front.includes('.residence-hint{') && front.includes('.geoapify-suggestion:hover{'));

// La clé Geoapify divulguée de l'app d'origine ne doit nulle part dans le
// dépôt. Détection GÉNÉRIQUE — la valeur elle-même ne figure pas dans le code
// source (un dépôt public ne doit rien contenir de reconstituable) :
//  - une clé hexadécimale de 32 caractères cohabitant avec une mention
//    « geoapify » dans le même fichier ;
//  - un paramètre clé non vide dans un contexte géocodage.
const looksLikeGeoKey = (text) =>
  (/[a-f0-9]{32}/i.test(text) && /geoapify/i.test(text)) ||
  /geoapify[^\n]{0,120}?[?&](?:api_?key|key)=[a-z0-9_-]{16,}/i.test(text) ||
  /api_?key=[a-z0-9_-]{32}/i.test(text);
function walk(dirPath, out) {
  for (const f of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === '.validate-bundle' || f.name === '.git') continue;
    const p = path.join(dirPath, f.name);
    if (f.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(projectRoot, []);
const leaks = files.filter((p) => {
  try {
    return looksLikeGeoKey(fs.readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
});
check('dépôt : clé divulguée d\'origine absente partout', leaks.length === 0, leaks.slice(0, 3).join(', '));

// ---------- Récap ----------
api.__resetGeoFetchForTests();
console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 6 : ${passed} réussi(s), ${failed} échec(s).`);
await db.end();
await ep.stop();
fs.rmSync(dir, { recursive: true, force: true });
try { fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
