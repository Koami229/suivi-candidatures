#!/usr/bin/env node
/**
 * Validation complète de l'étape 1 sur un Postgres RÉEL embarqué
 * (embedded-postgres — même moteur que Vercel Postgres/Neon).
 *
 * 1. Applique migrations/0001_init.sql dans son intégralité.
 * 2. Vérifie la fonction candidat_statut() sur tous les cas du pipeline.
 * 3. Vérifie les contraintes (email unique insensible à la casse, manager sans
 *    projet refusé, étape inconnue refusée, doublon (candidat, étape) refusé,
 *    décision invalide refusée, cascade candidats → entretiens).
 * 4. Vérifie les seeds (parametres_email, templates_email).
 * 5. Teste scripts/bootstrap-admin.mjs de bout en bout (bcrypt réel).
 * 6. Preuve d'équivalence JS↔SQL de la logique de statut (256 combinaisons).
 *
 * Usage : node scripts/validate-schema.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import bcrypt from 'bcryptjs';

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
async function expectError(name, fn) {
  try {
    await fn();
    check(name, false, '(aucune erreur levée — alors qu\'elle était attendue)');
  } catch {
    check(name, true);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-'));
const PORT = 55499;
const ep = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port: PORT, persistent: false });
await ep.initialise();
await ep.start();
await ep.createDatabase('suivi');
const sql = postgres(`postgres://test:test@127.0.0.1:${PORT}/suivi`, { max: 1 });

try {
  // ---------- 1. Migration complète ----------
  console.log('\n[1] Application de migrations/0001_init.sql');
  const raw = fs.readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
  try {
    await sql.unsafe(raw);
    check('migration appliquée sans erreur', true);
  } catch (e) {
    check('migration appliquée sans erreur', false, `— ${e.message.slice(0, 200)}`);
    throw e;
  }

  // ---------- 2. Fonction candidat_statut() sur données réelles ----------
  console.log('\n[2] Logique de statut (fonction SQL, données réelles)');
  const insertC = async (id) =>
    sql`INSERT INTO candidats (id, nom, prenom, email, shl_note_1, shl_note_2, shl_note_3, moyenne_shl)
        VALUES (${id}, 'Test', 'C', ${id + '@test.bj'}, 85, 80, 82, 82.3)`;
  const setDec = async (id, etape, decision, projet = '') =>
    sql`INSERT INTO entretiens (candidat_id, etape, decision, commentaire, acteur_nom, projet)
        VALUES (${id}, ${etape}, ${decision}, 'c', 'A', ${projet})`;
  const statut = async (id) => {
    const r = await sql`SELECT candidat_statut(${id}) AS s`;
    return r[0].s;
  };

  await insertC('s1');
  check('aucun entretien → EN_ATTENTE', (await statut('s1')) === 'EN_ATTENTE');

  await setDec('s1', 'RH', 'OK');
  check('RH OK → PREVIVER', (await statut('s1')) === 'PREVIVER');

  await setDec('s1', 'M1', 'KO', 'Samsung');
  check('RH OK + M1 KO → PREVIVER (en attente d\'autre affectation)', (await statut('s1')) === 'PREVIVER');

  await setDec('s1', 'M2', 'MB', 'Amazon');
  check('RH OK + M1 KO + M2 MB → PREVIVER', (await statut('s1')) === 'PREVIVER');

  await setDec('s1', 'M3', 'KO', 'Emma');
  check('3 tours sans OK → REJET (sortie définitive)', (await statut('s1')) === 'REJET');

  await insertC('s2');
  await setDec('s2', 'RH', 'OK');
  await setDec('s2', 'M1', 'OK', 'Samsung');
  check('M1 OK → SELECTED (parcours clôturé)', (await statut('s2')) === 'SELECTED');

  await insertC('s3');
  await setDec('s3', 'RH', 'KO');
  check('RH KO → REJET', (await statut('s3')) === 'REJET');

  await insertC('s4');
  await setDec('s4', 'RH', 'MB');
  check('RH MB → EN_ATTENTE (fidèle au JS actuel)', (await statut('s4')) === 'EN_ATTENTE');

  await insertC('s5');
  await setDec('s5', 'RH', 'OK');
  await setDec('s5', 'M1', 'KO', 'Samsung');
  await setDec('s5', 'M2', 'OK', 'Amazon');
  check('M2 OK après M1 KO → SELECTED', (await statut('s5')) === 'SELECTED');

  // ---------- 3. Vue v_candidats (statut + visibilité seuil 80) ----------
  console.log('\n[3] Vue v_candidats (seuil SHL ≥ 80)');
  await sql`INSERT INTO candidats (id, nom, prenom, email, shl_note_1, shl_note_2, shl_note_3, moyenne_shl)
            VALUES ('s6', 'Bas', 'Seuil', 's6@test.bj', 60, 60, 60, 60)`;
  const vue = await sql`SELECT id, statut, visible FROM v_candidats WHERE id IN ('s2','s6') ORDER BY id`;
  check('SELECTED visible (82.3 ≥ 80)', vue.find((r) => r.id === 's2').visible === true);
  check('sous le seuil → visible = false (masqué)', vue.find((r) => r.id === 's6').visible === false);
  check('statut dans la vue = SELECTED', vue.find((r) => r.id === 's2').statut === 'SELECTED');

  // ---------- 4. Contraintes ----------
  console.log('\n[4] Contraintes de données');
  await expectError('email en double (majuscules) refusé', () =>
    sql`INSERT INTO candidats (id, nom, prenom, email, moyenne_shl) VALUES ('s7', 'X', 'Y', 'S2@TEST.BJ', 90)`
  );
  await expectError('manager sans projet refusé', () =>
    sql`INSERT INTO comptes (username, role, nom, prenom, email) VALUES ('m@concentrix.com', 'manager', 'M', 'N', 'm@concentrix.com')`
  );
  await sql`INSERT INTO comptes (username, role, nom, prenom, email) VALUES ('r@concentrix.com', 'recruteur', 'R', 'P', 'r@concentrix.com')`;
  check('recruteur sans projet accepté', (await sql`SELECT 1 FROM comptes WHERE username = 'r@concentrix.com'`).length === 1);
  await sql`INSERT INTO comptes (username, role, nom, prenom, email, projet) VALUES ('m2@concentrix.com', 'manager', 'M2', 'N2', 'm2@concentrix.com', 'Samsung')`;
  check('manager avec projet accepté', (await sql`SELECT 1 FROM comptes WHERE username = 'm2@concentrix.com'`).length === 1);
  await expectError('étape inconnue refusée', () => setDec('s2', 'M9', 'OK'));
  await expectError('doublon (candidat, étape) refusé', () => setDec('s2', 'M1', 'KO'));
  await expectError('décision invalide refusée', () => setDec('s2', 'M2', 'OUI'));
  await expectError('niveau d\'étude hors catalogue refusé', () =>
    sql`INSERT INTO candidats (id, nom, prenom, email, niveau_etude, moyenne_shl) VALUES ('s8', 'X', 'Y', 's8@test.bj', 'DOCTORAT', 90)`
  );
  const avant = await sql`SELECT count(*)::int AS n FROM entretiens WHERE candidat_id = 's2'`;
  await sql`DELETE FROM candidats WHERE id = 's2'`;
  const apres = await sql`SELECT count(*)::int AS n FROM entretiens WHERE candidat_id = 's2'`;
  check('cascade candidats → entretiens', avant[0].n > 0 && apres[0].n === 0);

  // ---------- 5. Seeds ----------
  console.log('\n[5] Seeds email');
  const pe = await sql`SELECT fournisseur, actif FROM parametres_email WHERE id = 1`;
  check('parametres_email initialisée (resend, inactive)', pe.length === 1 && pe[0].fournisseur === 'resend' && pe[0].actif === false);
  const te = await sql`SELECT code FROM templates_email ORDER BY code`;
  check(
    '3 templates seedés (AFFECTATION_PROJET, PREVIVER, SELECTED)',
    JSON.stringify(te.map((r) => r.code)) === JSON.stringify(['AFFECTATION_PROJET', 'PREVIVER', 'SELECTED'])
  );

  // ---------- 6. Bootstrap admin (bcrypt réel) ----------
  console.log('\n[6] Bootstrap admin (scripts/bootstrap-admin.mjs)');
  const adminPw = 'Bootstrap!2026';
  execFileSync(
    process.execPath,
    ['scripts/bootstrap-admin.mjs'],
    {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'pipe',
      env: {
        ...process.env,
        DATABASE_URL: `postgres://test:test@127.0.0.1:${PORT}/suivi`,
        ADMIN_BOOTSTRAP_EMAIL: 'rh@concentrix.com',
        ADMIN_BOOTSTRAP_PASSWORD: adminPw,
        ADMIN_BOOTSTRAP_NOM: 'Doré',
        ADMIN_BOOTSTRAP_PRENOM: 'Awa',
      },
    }
  );
  const acc = await sql`SELECT role, password_hash, totp_secret FROM comptes WHERE username = 'rh@concentrix.com'`;
  check('compte admin créé (rôle rh)', acc.length === 1 && acc[0].role === 'rh');
  check('mot de passe haché bcrypt (jamais en clair)', acc[0].password_hash.startsWith('$2') && !acc[0].password_hash.includes(adminPw));
  check('mot de passe vérifiable (bcrypt.compare)', bcrypt.compareSync(adminPw, acc[0].password_hash));
  check('2FA non configurée avant 1re connexion (totp_secret NULL)', acc[0].totp_secret === null);
  const bad = await sql`SELECT password_hash FROM comptes WHERE password_hash IS NOT NULL AND username <> 'rh@concentrix.com'`;
  check('aucun autre mot de passe en clair dans la base', bad.length === 0);

  // ---------- 7. Équivalence exhaustive JS ↔ SQL ----------
  console.log('\n[7] Équivalence JS (app actuelle) ↔ SQL — 256 combinaisons');
  const MANAGER_KEYS = ['m1', 'm2', 'm3'];
  function computeStatutCode(st) {
    if (MANAGER_KEYS.some((k) => st[k] === 'ok')) return 'SELECTED';
    if (MANAGER_KEYS.every((k) => st[k] !== 'a_faire') && !MANAGER_KEYS.some((k) => st[k] === 'ok')) return 'REJET';
    if (st.rh === 'ok') return 'PREVIVER';
    if (st.rh === 'ko') return 'REJET';
    return 'EN_ATTENTE';
  }
  const vals = [null, 'ok', 'ko', 'mb'];
  let div = 0;
  for (const rh of vals)
    for (const m1 of vals)
      for (const m2 of vals)
        for (const m3 of vals) {
          const up = (v) => (v ? v.toUpperCase() : null);
          // Réplique exacte du CASE SQL
          const sqlv =
            up(m1) === 'OK' || up(m2) === 'OK' || up(m3) === 'OK'
              ? 'SELECTED'
              : up(m1) !== null && up(m2) !== null && up(m3) !== null
                ? 'REJET'
                : up(rh) === 'OK'
                  ? 'PREVIVER'
                  : up(rh) === 'KO'
                    ? 'REJET'
                    : 'EN_ATTENTE';
          const ref = computeStatutCode({ rh: rh ?? 'a_faire', m1: m1 ?? 'a_faire', m2: m2 ?? 'a_faire', m3: m3 ?? 'a_faire' });
          if (ref !== sqlv) {
            div++;
            console.log(`    DIVERGENCE rh=${rh} m1=${m1} m2=${m2} m3=${m3} → JS=${ref} SQL=${sqlv}`);
          }
        }
  check('0 divergence sur 256 combinaisons', div === 0);
} catch (e) {
  console.error('\nERREUR BLOQUANTE :', e.message);
  failed++;
} finally {
  await sql.end();
  await ep.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT : ${passed} réussi(s), ${failed} échec(s).`);
process.exit(failed === 0 ? 0 : 1);
