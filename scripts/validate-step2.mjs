#!/usr/bin/env node
/**
 * Validation de l'étape 2 (authentification serveur) sur Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild — ce que fait Vercel au deploy).
 * 2. Monte un Postgres réel embarqué, applique 0001_init.sql.
 * 3. Crée l'admin avec le script de production (bootstrap-admin.mjs).
 * 4. Appelle les handlers avec de vrais Request/Response :
 *    login → 2FA (première configuration + vérification), /me, refresh
 *    (rotation), création/activation/reset/suppression de comptes,
 *    changement de mot de passe, gestion 2FA, rôles, audit.
 *
 * Usage : node scripts/validate-step2.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step2-'));
const PORT = 55511;
const ADMIN_EMAIL = 'rh@concentrix.com';
const ADMIN_PW = 'Bootstrap!2026';
const MGR_EMAIL = 'm@concentrix.com';

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

// ---------- 1. Bundle des fonctions Vercel ----------
// NB : le bundle vit DANS le projet (et non dans /tmp) afin que Node puisse
// résoudre les dépendances marquées `external` (xlsx, CJS) depuis node_modules.
console.log('\n[1] Bundle des fonctions Vercel (esbuild)');
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle-step2.mjs');
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

// ---------- 2. Postgres réel + migration ----------
console.log('\n[2] Postgres réel + migration');
const ep = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pgdata'), user: 'test', password: 'test', port: PORT, persistent: false });
await ep.initialise();
await ep.start();
await ep.createDatabase('suivi');
const db = postgres(`postgres://test:test@127.0.0.1:${PORT}/suivi`, { max: 1 });
try {
  await db.unsafe(fs.readFileSync(path.join(projectRoot, 'migrations', '0001_init.sql'), 'utf8'));
  check('migration appliquée', true);
} catch (e) {
  check('migration appliquée', false, e.message.slice(0, 160));
  throw e;
}

// ---------- 3. Environnement (ce que Vercel injecte) ----------
process.env.DATABASE_URL = `postgres://test:test@127.0.0.1:${PORT}/suivi`;
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef-0123456789abcdef';
process.env.APP_URL = 'http://app.test';

// ---------- 4. Bootstrap admin (script de production) ----------
console.log('\n[3] Bootstrap admin');
try {
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
  check('admin créé (script de production)', true);
} catch (e) {
  check('admin créé (script de production)', false, String(e.stderr || e.message).slice(0, 160));
  throw e;
}

// ---------- 5. Import de l'API ----------
const api = await import(bundleOut);

function req(method, p, { body, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Request('http://local.test' + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function call(fn, r) {
  const res = await fn(r);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // ---------- A. Connexion admin + 2FA première configuration ----------
  console.log('\n[4] Connexion + double authentification (admin)');
  let r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: 'Mauvais!12345' } }));
  check('mot de passe incorrect → 401', r.status === 401);

  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
  check('login admin → 2FA à configurer (clé + ticket)', r.status === 200 && !!r.data.setup?.secret && !!r.data.setup?.otpauth_uri && !!r.data.ticket);
  const ticket1 = r.data.ticket;
  const secret1 = r.data.setup.secret;

  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: ticket1, code: '000000' } }));
  check('code 2FA incorrect → 401', r.status === 401);

  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
  const ticket2 = r.data.ticket;
  const code = api.totpCodeAt(r.data.setup.secret, 0);
  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: ticket2, code } }));
  check('code 2FA valide → access + refresh + user', r.status === 200 && !!r.data.access_token && !!r.data.refresh_token && r.data.user?.role === 'rh' && r.data.user?.username === ADMIN_EMAIL);
  let access = r.data.access_token;
  let refresh = r.data.refresh_token;

  const totpRow = await db`SELECT totp_secret, totp_activee_le FROM comptes WHERE username = ${ADMIN_EMAIL}`;
  check('clé 2FA enregistrée en base', !!totpRow[0].totp_secret && !!totpRow[0].totp_activee_le);

  // Re-login : la 2FA passe maintenant en mode « vérification »
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
  check('2e login → 2FA en mode vérification (setup = null)', r.status === 200 && r.data.setup === null && !!r.data.ticket);

  // ---------- B. Session /me ----------
  console.log('\n[5] Session (JWT)');
  r = await call(api.me, req('GET', '/api/auth/me', { token: access }));
  check('GET /me avec token valide', r.status === 200 && r.data.username === ADMIN_EMAIL && r.data.role === 'rh');
  r = await call(api.me, req('GET', '/api/auth/me', { token: 'a.b.c' }));
  check('GET /me avec token invalide → 401', r.status === 401);
  r = await call(api.me, req('GET', '/api/auth/me'));
  check('GET /me sans token → 401', r.status === 401);

  // ---------- C. Refresh (rotation) ----------
  // NB : deux tokens émis dans la même seconde portent les mêmes claims JWT
  // (iat en secondes) et sont donc textuellement identiques — on vérifie la
  // validité, et la rotation est prouvée par l'invalidation de l'ancien refresh.
  r = await call(api.refresh, req('POST', '/api/auth/refresh', { body: { refresh_token: refresh } }));
  check('refresh → nouveau token d\'accès valide', r.status === 200 && !!r.data.access_token);
  const oldRefresh = refresh;
  access = r.data.access_token;
  refresh = r.data.refresh_token;
  r = await call(api.refresh, req('POST', '/api/auth/refresh', { body: { refresh_token: oldRefresh } }));
  check('ancien refresh invalidé (rotation) → 401', r.status === 401);

  // ---------- D. Création de compte manager ----------
  console.log('\n[6] Gestion des comptes (RH)');
  r = await call(api.comptesIndex, req('POST', '/api/comptes', {
    token: access,
    body: { username: MGR_EMAIL, role: 'manager', nom: 'Benali', prenom: 'Karim', email: MGR_EMAIL },
  }));
  check('manager sans projet → 400', r.status === 400);

  r = await call(api.comptesIndex, req('POST', '/api/comptes', {
    token: access,
    body: { username: MGR_EMAIL, role: 'manager', nom: 'Benali', prenom: 'Karim', email: MGR_EMAIL, projet: 'Samsung' },
  }));
  check('manager avec projet créé + lien d\'activation', r.status === 200 && String(r.data.link).includes('activation='));
  const mgrToken = new URL(r.data.link).searchParams.get('activation');

  r = await call(api.comptesIndex, req('POST', '/api/comptes', {
    token: access,
    body: { username: MGR_EMAIL, role: 'manager', nom: 'X', prenom: 'Y', email: MGR_EMAIL, projet: 'Samsung' },
  }));
  check('identifiant en double → 400', r.status === 400);

  // ---------- E. Activation ----------
  console.log('\n[7] Activation du compte manager');
  r = await call(api.activate, req('GET', '/api/auth/activate?token=' + encodeURIComponent(mgrToken)));
  check('lien d\'activation valide', r.status === 200 && r.data.valid && r.data.username === MGR_EMAIL && r.data.prenom === 'Karim');
  r = await call(api.activate, req('GET', '/api/auth/activate?token=00000000-0000-0000-0000-000000000000'));
  check('lien invalide → 400', r.status === 400);
  r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: mgrToken, password: 'faible' } }));
  check('mot de passe faible refusé → 400', r.status === 400);
  const MGR_PW = 'Manager!2026';
  r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: mgrToken, password: MGR_PW } }));
  check('activation OK', r.status === 200);
  r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: mgrToken, password: MGR_PW } }));
  check('lien déjà utilisé → 400', r.status === 400);

  // ---------- F. Connexion manager + rôles ----------
  console.log('\n[8] Connexion manager + contrôle de rôle');
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: MGR_PW } }));
  check('login manager → 2FA à configurer', r.status === 200 && !!r.data.setup);
  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.setup.secret, 0) } }));
  check('login manager 2FA OK (role + projet)', r.status === 200 && r.data.user?.role === 'manager' && r.data.user?.projet === 'Samsung');
  const mgrAccess = r.data.access_token;
  let mgrRefresh = r.data.refresh_token;

  r = await call(api.comptesIndex, req('GET', '/api/comptes', { token: mgrAccess }));
  check('GET /api/comptes en tant que manager → 403', r.status === 403);
  r = await call(api.comptesIndex, req('GET', '/api/comptes', { token: access }));
  check('GET /api/comptes (RH) → 1 compte actif', r.status === 200 && r.data.accounts.length === 1 && r.data.accounts[0].username === MGR_EMAIL && r.data.accounts[0].activated === true);

  // ---------- G. Changement de mot de passe ----------
  console.log('\n[9] Changement de mot de passe');
  r = await call(api.password, req('POST', '/api/auth/password', { token: mgrAccess, body: { current: 'Erreur!12345', new_password: 'Nouveau!2026' } }));
  check('mot de passe actuel incorrect → 400', r.status === 400 && r.data.code === 'bad_current');
  r = await call(api.password, req('POST', '/api/auth/password', { token: mgrAccess, body: { current: MGR_PW, new_password: 'faible' } }));
  check('nouveau mot de passe faible → 400', r.status === 400);
  r = await call(api.password, req('POST', '/api/auth/password', { token: mgrAccess, body: { current: MGR_PW, new_password: 'Nouveau!2026' } }));
  check('changement OK', r.status === 200);
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: MGR_PW } }));
  check('ancien mot de passe plus valide → 401', r.status === 401);
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: 'Nouveau!2026' } }));
  check('nouveau mot de passe valide', r.status === 200);

  // ---------- H. 2FA : statut / régénération / confirmation ----------
  console.log('\n[10] Gestion 2FA en cours de session');
  r = await call(api.twofaStatus, req('GET', '/api/auth/twofa-status', { token: mgrAccess }));
  check('statut 2FA : configurée', r.status === 200 && r.data.configured === true);
  r = await call(api.twofaRegenerate, req('POST', '/api/auth/twofa-regenerate', { token: mgrAccess }));
  check('régénération → nouvelle clé + ticket', r.status === 200 && !!r.data.secret && !!r.data.ticket && r.data.secret !== secret1);
  r = await call(api.twofaConfirm, req('POST', '/api/auth/twofa-confirm', { token: mgrAccess, body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.secret, 0) } }));
  check('confirmation de la nouvelle clé OK', r.status === 200);
  r = await call(api.twofaConfirm, req('POST', '/api/auth/twofa-confirm', { token: mgrAccess, body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.secret, 0) } }));
  check('ticket de confirmation déjà utilisé → 400', r.status === 400);

  // ---------- I. Déconnexion (révocation du refresh) ----------
  console.log('\n[11] Déconnexion');
  r = await call(api.logout, req('POST', '/api/auth/logout', { body: { refresh_token: mgrRefresh } }));
  check('logout OK', r.status === 200);
  r = await call(api.refresh, req('POST', '/api/auth/refresh', { body: { refresh_token: mgrRefresh } }));
  check('refresh révoqué après logout → 401', r.status === 401);

  // ---------- J. Réinitialisation du mot de passe ----------
  console.log('\n[12] Réinitialisation (nouveau lien d\'activation)');
  r = await call(api.comptesReset, req('POST', '/api/comptes/' + encodeURIComponent(MGR_EMAIL) + '/reset', { token: access }));
  check('reset → nouveau lien', r.status === 200 && String(r.data.link).includes('activation='));
  const resetToken = new URL(r.data.link).searchParams.get('activation');
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: 'Nouveau!2026' } }));
  check('compte en attente d\'activation → 403', r.status === 403);
  r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: resetToken, password: 'Reactive!2026' } }));
  check('réactivation OK', r.status === 200);
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: 'Reactive!2026' } }));
  check('login avec le nouveau mot de passe', r.status === 200);

  // ---------- K. Suppression douce ----------
  console.log('\n[13] Suppression douce (réversible)');
  r = await call(api.comptesUsername, req('DELETE', '/api/comptes/' + encodeURIComponent(MGR_EMAIL), { token: access }));
  check('suppression OK', r.status === 200);
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username: MGR_EMAIL, password: 'Reactive!2026' } }));
  check('compte désactivé ne se connecte plus → 401', r.status === 401);
  r = await call(api.comptesIndex, req('GET', '/api/comptes', { token: access }));
  check('compte désactivé masqué de la liste', r.status === 200 && r.data.accounts.length === 0);
  await db`UPDATE comptes SET desactive_le = NULL, password_hash = NULL, activation_token = gen_random_uuid(), activation_token_cree_le = now() WHERE username = ${MGR_EMAIL}`;
  r = await call(api.comptesIndex, req('GET', '/api/comptes', { token: access }));
  check('suppression douce réversible en base', r.data.accounts.length === 1 && r.data.accounts[0].activated === false);

  // ---------- L. Audit ----------
  console.log('\n[14] Journal d\'audit');
  const auditRows = await db`SELECT count(*)::int AS n FROM audit_log`;
  check('audit alimenté (≥ 10 événements)', auditRows[0].n >= 10);
  const auditActions = await db`SELECT DISTINCT action FROM audit_log ORDER BY action`;
  check('actions variées journalisées', auditActions.length >= 6);
} finally {
  await db.end();
  await ep.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 2 : ${passed} réussi(s), ${failed} échec(s).`);
process.exit(failed === 0 ? 0 : 1);
