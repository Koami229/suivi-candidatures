#!/usr/bin/env node
/**
 * Initialisation de la base de production (une seule fois).
 *
 * Applique les migrations SQL (migrations/0001_init.sql, 0002_email_templates.sql…)
 * dans une base VIERGE — idempotent : si le schéma existe déjà, rien n'est fait.
 *
 * Usage (localement, ou via Vercel CLI avec `vercel env pull`) :
 *   DATABASE_URL="postgresql://…" npm run db:setup
 *
 * Puis, pour créer le compte administrateur RH (identifiants 100 % via env) :
 *   DATABASE_URL="postgresql://…" \
 *   ADMIN_BOOTSTRAP_EMAIL=… ADMIN_BOOTSTRAP_PASSWORD=… \
 *   ADMIN_BOOTSTRAP_NOM=… ADMIN_BOOTSTRAP_PRENOM=… \
 *   npm run bootstrap:admin
 *
 * Et enfin, RETIRER les variables ADMIN_BOOTSTRAP_* de Vercel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATABASE_URL) {
  console.error('✗ DATABASE_URL absente. Exemple : DATABASE_URL="postgresql://…" npm run db:setup');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'candidats'`;
  if (n > 0) {
    console.log('✓ Le schéma existe déjà (table « candidats » présente) — rien à faire.');
    process.exit(0);
  }

  const migFiles = fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  if (migFiles.length === 0) {
    console.error('✗ Aucune migration trouvée dans /migrations.');
    process.exit(1);
  }
  for (const f of migFiles) {
    await sql.unsafe(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
    console.log(`✓ Migration appliquée : ${f}`);
  }
  console.log('✓ Base initialisée.');
  console.log('→ Étape suivante : créer le compte administrateur (npm run bootstrap:admin, identifiants via variables d\'environnement), puis retirer ADMIN_BOOTSTRAP_* de Vercel.');
} catch (err) {
  console.error('✗ Échec de l\'initialisation :', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
