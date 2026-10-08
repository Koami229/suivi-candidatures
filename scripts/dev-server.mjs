#!/usr/bin/env node
/**
 * Serveur de développement LOCAL (hors production — production = Vercel).
 *
 * Sert `public/` en statique + les fonctions API (bundle esbuild identique
 * aux suites de validation) sur un seul port :
 *   - /            → public/index.html
 *   - /api/*       → les handlers (mêmes Request/Response que Vercel)
 *
 * Mode « zéro infra » : si DATABASE_URL n'est pas définie, il démarre un
 * Postgres réel embarqué (embedded-postgres) dans un dossier temporaire,
 * applique migrations/0001_init.sql et crée le compte admin via le script
 * de production (identifiants via env — jamais codés).
 *
 * Usage :
 *   JWT_SECRET=... npm run dev:local
 *   (optionnel : DATABASE_URL, ADMIN_BOOTSTRAP_EMAIL/PASSWORD/NOM/PRENOM, PORT)
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const PORT = Number(process.env.PORT || 4173);

// ---------- 1. Base de données ------------------------------------------
let embedded = null;
let pgDir = null;
if (!process.env.DATABASE_URL) {
  console.log('[dev] DATABASE_URL absente → démarrage d\'un Postgres embarqué (démo)');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  pgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suivi-dev-pg-'));
  const ep = new EmbeddedPostgres({
    databaseDir: path.join(pgDir, 'pgdata'),
    user: 'dev',
    password: 'dev',
    port: 55520,
    persistent: false,
  });
  await ep.initialise();
  await ep.start();
  await ep.createDatabase('suivi');
  const { default: postgres } = await import('postgres');
  const db = postgres('postgres://dev:dev@127.0.0.1:55520/suivi', { max: 1 });
  // Toutes les migrations, dans l'ordre de leur préfixe numérique.
  const migFiles = fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migFiles) {
    await db.unsafe(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  }
  await db.end();
  process.env.DATABASE_URL = 'postgres://dev:dev@127.0.0.1:55520/suivi';
  embedded = ep;
  console.log('[dev] base prête + migration appliquée');
}
if (!process.env.JWT_SECRET) {
  // Dév uniquement : un secret éphémère est toléré LOCALEMENT (jamais en
  // production — Vercel exige JWT_SECRET explicite, cf. src/lib/config.ts).
  process.env.JWT_SECRET = 'dev-' + randomBytes(32).toString('hex');
}
if (!process.env.EMAIL_API_KEY_ENC) {
  // Idem pour la clé de chiffrement AES-256-GCM des clés API email (64 hex).
  process.env.EMAIL_API_KEY_ENC = randomBytes(32).toString('hex');
}
process.env.APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ---------- 2. Bootstrap admin (script de production, env uniquement) ----
if (!process.env.ADMIN_BOOTSTRAP_EMAIL) {
  process.env.ADMIN_BOOTSTRAP_EMAIL = 'rh@concentrix.com';
  process.env.ADMIN_BOOTSTRAP_PASSWORD = 'Dev!2026Preview';
  process.env.ADMIN_BOOTSTRAP_NOM = 'Doré';
  process.env.ADMIN_BOOTSTRAP_PRENOM = 'Awa';
}
try {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'bootstrap-admin.mjs')], {
    stdio: 'pipe',
    env: process.env,
  });
  console.log(`[dev] admin prêt : ${process.env.ADMIN_BOOTSTRAP_EMAIL} (à configurer 2FA à la 1re connexion)`);
} catch (e) {
  console.warn('[dev] bootstrap admin ignoré :', String(e.stderr || e.message).split('\n')[0]);
}

// ---------- 3. Bundle des fonctions (idéal aux tests) ---------------------
const bundleDir = path.join(root, '.validate-bundle');
fs.mkdirSync(bundleDir, { recursive: true });
const bundleOut = path.join(bundleDir, 'dev-bundle.mjs');
buildSync({
  entryPoints: [path.join(root, 'scripts', 'api-test-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['xlsx'],
  outfile: bundleOut,
  logLevel: 'silent',
});
const api = await import(bundleOut);

// ---------- 4. Routage /api/* --------------------------------------------
const ROUTES = {
  '/api/health': { any: api.health },
  '/api/auth/login': { post: api.login },
  '/api/auth/twofa': { post: api.twofa },
  '/api/auth/refresh': { post: api.refresh },
  '/api/auth/logout': { post: api.logout },
  '/api/auth/me': { get: api.me },
  '/api/auth/activate': { get: api.activate },
  '/api/auth/activation': { post: api.activation },
  '/api/auth/password': { post: api.password },
  '/api/auth/twofa-status': { get: api.twofaStatus },
  '/api/auth/twofa-regenerate': { post: api.twofaRegenerate },
  '/api/auth/twofa-confirm': { post: api.twofaConfirm },
  '/api/auth/forgot': { post: api.forgot },
  '/api/comptes': { get: api.comptesIndex, post: api.comptesIndex },
  '/api/previvier': { get: api.previvierIndex },
  '/api/candidats': { get: api.candidatsIndex, post: api.candidatsIndex },
  '/api/candidats/import': { post: api.candidatsImport },
  '/api/stats': { get: api.stats },
  '/api/pv': { get: api.pv },
  '/api/parametres/email': { get: api.parametresEmail, put: api.parametresEmail },
  '/api/parametres/email/test': { post: api.parametresEmailTest },
  '/api/parametres/email/envois': { get: api.parametresEmailEnvois },
  '/api/parametres/whatsapp': { get: api.parametresWhatsapp, put: api.parametresWhatsapp },
  '/api/parametres/whatsapp/envois': { get: api.parametresWhatsappEnvois },
  '/api/geo/search': { get: api.geoSearch },
  '/api/audit': { get: api.auditIndex },
};
// Récursifs (segment dynamique lu par le handler dans le pathname) :
const DYNAMIC = [
  [/^\/api\/comptes\/[^/]+\/reset$/, 'post', api.comptesReset],
  [/^\/api\/comptes\/[^/]+$/, 'any', api.comptesUsername],
  [/^\/api\/previvier\/[^/]+\/affecter$/, 'post', api.previvierAffecter],
  [/^\/api\/candidats\/[^/]+\/purger$/, 'post', api.candidatsPurge],
  [/^\/api\/candidats\/[^/]+$/, 'any', api.candidatsId],
];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      const method = req.method.toLowerCase();
      let handler = null;
      const exact = ROUTES[p];
      if (exact) handler = exact.any || exact[method];
      else for (const [re, m, fn] of DYNAMIC) {
        if (re.test(p) && (m === 'any' || m === method)) {
          handler = fn;
          break;
        }
      }
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: true, message: 'Route inconnue.' }));
        return;
      }
      const body = await readBody(req);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      const request = new Request(`http://localhost${p}${url.search}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const response = await handler(request);
      const text = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(text);
      return;
    }

    // Statique (public/)
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const abs = path.join(root, 'public', file);
    if (!abs.startsWith(path.join(root, 'public'))) {
      res.writeHead(403);
      res.end('Interdit.');
      return;
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(fs.readFileSync(abs));
    } else {
      // SPA : tout route inconnue → index.html
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
    }
  } catch (e) {
    console.error('[dev]', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: true, message: 'Erreur interne du serveur.' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev] application sur http://localhost:${PORT} (admin : ${process.env.ADMIN_BOOTSTRAP_EMAIL})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      server.close();
      if (embedded) await embedded.stop();
      if (pgDir) fs.rmSync(pgDir, { recursive: true, force: true });
    } finally {
      process.exit(0);
    }
  });
}
