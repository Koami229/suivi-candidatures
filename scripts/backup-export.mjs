#!/usr/bin/env node
/**
 * Sauvegarde / restauration de la base « Suivi des candidatures ».
 *
 * Étape 7 — durcissement. Complète la protection native de Vercel Postgres
 * (PITR / rétention gérés par Vercel) : export manuel daté, et restauration
 * sur une base vide (par exemple après une erreur).
 *
 *   npm run db:export                        → backups/suivi-<date>.json
 *   npm run db:restore -- backups/xxx.json   → restaure sur DATABASE_URL
 *                                             (migrations appliquées, contenu
 *                                             de la cible REMPLACÉ par l'export)
 *
 * CONFIDENTIAL : le fichier contient les mots de passe (bcrypt), les clés
 * 2FA, la clé API email (chiffrée) et les données des candidats. À stocker
 * dans un endroit sécurisé (même niveau de protection que la base).
 */
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const [mode, fileArg] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ DATABASE_URL manquante (variable d\'environnement).');
  process.exit(1);
}
// Ordre compatible aux clés étrangères (aussi l'ordre de restauration).
const TABLES = ['templates_email', 'parametres_email', 'comptes', 'candidats', 'entretiens', 'envois_email', 'audit_log'];

function iso(v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}
function serialize(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(iso) : iso(v)])));
}

const db = postgres(url, { max: 1 });

try {
  if (mode === 'restore') {
    // ---------- Restauration (cible : base vide ou réinitialisée) ----------
    if (!fileArg) {
      console.error('Usage : npm run db:restore -- <fichier.json>');
      process.exit(1);
    }
    const abs = path.isAbsolute(fileArg) ? fileArg : path.join(projectRoot, fileArg);
    if (!fs.existsSync(abs)) {
      console.error('✗ Fichier introuvable : ' + abs);
      process.exit(1);
    }
    const payload = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (!payload.tables || payload.schema !== 'suivi-candidatures/0002') {
      console.error('✗ Fichier de sauvegarde non reconnu (schéma ' + (payload.schema || '?') + ').');
      process.exit(1);
    }
    console.log('Restauration depuis ' + path.relative(projectRoot, abs) + '…');
    console.log('  — migrations appliquées sur la cible…');
    const migDir = path.join(projectRoot, 'migrations');
    for (const f of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      await db.unsafe(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }
    // Remplacement du contenu de la cible : vidage dans l'ordre inverse des
    // clés étrangères (base vide ⇒ sans effet ; base sale ⇒ réinitialisation
    // propre, sans doublons sur les seeds).
    for (const t of [...TABLES].reverse()) {
      await db.unsafe(`DELETE FROM ${t}`);
    }
    // Colonnes IDENTITY (GENERATED ALWAYS) : il faut OVERRIDING SYSTEM VALUE
    // pour réinsérer les id d'origine (traçabilité des journaux conservée).
    const IDENTITY = new Set(['envois_email', 'audit_log']);
    for (const t of TABLES) {
      const rows = payload.tables[t] || [];
      for (const r of rows) {
        const cols = Object.keys(r);
        const vals = cols.map((c) => r[c]);
        const ph = cols.map((_, i) => `$${i + 1}`);
        const override = IDENTITY.has(t) ? ' OVERRIDING SYSTEM VALUE' : '';
        await db.unsafe(`INSERT INTO ${t} (${cols.join(', ')})${override} VALUES (${ph.join(', ')})`, vals);
      }
      console.log(`   ${t.padEnd(18)} ${rows.length} ligne(s)`);
    }
    console.log('✓ Restauration terminée (export du ' + payload.exported_at + ').');
    process.exit(0);
  }

  // ---------- Export ----------
  console.log('Export de la base…');
  const out = {};
  const counts = {};
  for (const t of TABLES) {
    const rows = await db.unsafe(`SELECT * FROM ${t}`);
    out[t] = serialize(rows);
    counts[t] = rows.length;
  }
  const payload = {
    exported_at: new Date().toISOString(),
    schema: 'suivi-candidatures/0002',
    counts,
    tables: out,
  };
  const dir = path.join(projectRoot, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `suivi-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  const sizeKo = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`✓ Sauvegarde écrite : ${path.relative(projectRoot, file)} (${sizeKo} Ko)`);
  for (const t of TABLES) console.log(`   ${t.padEnd(18)} ${counts[t]}`);
  console.log('\n⚠ Confidential (mots de passe, 2FA, données candidats) : stocker dans un lieu sécurisé.');
  process.exit(0);
} finally {
  await db.end();
}
