#!/usr/bin/env node
/**
 * Validation de l'étape 3 (magasin candidats + pipeline + pré-vivier +
 * stats + PV) sur Postgres réel.
 *
 * 1. Bundle les fonctions Vercel (esbuild — ce que fait Vercel au deploy).
 * 2. Monte un Postgres réel embarqué, applique 0001_init.sql.
 * 3. Crée l'admin (bootstrap) + 1 recruteur + 3 managers (via l'API comptes).
 * 4. Parcours complet métier :
 *    - import CSV (dédoublonnage, seuil SHL, détection des colonnes) ;
 *    - import Excel ; création manuelle ;
 *    - listes filtrées par rôle ; recherche ;
 *    - entretien RH (recruteur) → verrouillage définitif (409, même RH) ;
 *    - pré-vivier + affectation (re-affectation projet interdit → 400) ;
 *    - KO/MB manager → retour pré-vivier + projet effacé ; REJET après 3 KO/MB ;
 *    - OK manager → SELECTED (disparaît des listes manager) ;
 *    - périmètre manager (rôle, tour, projet) ;
 *    - statistiques (totaux, décisions, par niveau/statut/ville, période) ;
 *    - PV de synthèse (manager, SON projet, compteurs) ;
 *    - suppression (RH) ; refus de droits (recruteur/manager).
 *
 * Usage : node scripts/validate-step3.mjs
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import XLSX from 'xlsx';

const projectRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epg-step3-'));
const PORT = 55512;
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

// ---------- 1. Bundle des fonctions Vercel ----------
// NB : le bundle vit DANS le projet (et non dans /tmp) afin que Node puisse
// résoudre les dépendances marquées `external` (xlsx, CJS) depuis node_modules.
console.log('\n[1] Bundle des fonctions Vercel (esbuild)');
const bundleOut = path.join(projectRoot, '.validate-bundle', 'api-bundle.mjs');
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

function req(method, p, { body, token, raw } = {}) {
  const headers = {};
  if (body && !raw) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = 'Bearer ' + token;
  return new Request('http://local.test' + p, {
    method,
    headers,
    // `raw` : corps tel quel (FormData multipart — le content-type avec
    // boundary est posé par undici, jamais forcé).
    body: raw ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(fn, r) {
  const res = await fn(r);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---------- Helpers de bootstrap de comptes ----------
async function makeAccount({ username, role, nom, prenom, email, projet, pw }) {
  let r = await call(api.comptesIndex, req('POST', '/api/comptes', {
    token: RH,
    body: { username, role, nom, prenom, email, ...(projet ? { projet } : {}) },
  }));
  if (r.status !== 200) throw new Error('compte refusé : ' + JSON.stringify(r.data));
  const tok = new URL(r.data.link).searchParams.get('activation');
  r = await call(api.activation, req('POST', '/api/auth/activation', { body: { token: tok, password: pw } }));
  if (r.status !== 200) throw new Error('activation refusée : ' + JSON.stringify(r.data));
  r = await call(api.login, req('POST', '/api/auth/login', { body: { username, password: pw } }));
  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.setup.secret, 0) } }));
  if (r.status !== 200) throw new Error('2fa refusée : ' + JSON.stringify(r.data));
  return r.data.access_token;
}

let RH;
try {
  // ---------- 6. Connexion admin ----------
  console.log('\n[4] Connexion + 2FA (admin)');
  let r = await call(api.login, req('POST', '/api/auth/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PW } }));
  r = await call(api.twofa, req('POST', '/api/auth/twofa', { body: { ticket: r.data.ticket, code: api.totpCodeAt(r.data.setup.secret, 0) } }));
  check('admin connecté (RH)', r.status === 200 && r.data.user?.role === 'rh');
  RH = r.data.access_token;

  // ---------- 7. Comptes test ----------
  console.log('\n[5] Comptes test (recruteur + 3 managers)');
  const REC = await makeAccount({ username: 'r@concentrix.com', role: 'recruteur', nom: 'Diallo', prenom: 'Mariam', email: 'r@concentrix.com', pw: 'Recrut!2026' });
  const M1 = await makeAccount({ username: 'm1@concentrix.com', role: 'manager', nom: 'Benali', prenom: 'Karim', email: 'm1@concentrix.com', projet: 'Samsung', pw: 'Manager!2026' });
  const M2 = await makeAccount({ username: 'm2@concentrix.com', role: 'manager', nom: 'Ouazzani', prenom: 'Nabil', email: 'm2@concentrix.com', projet: 'Amazon', pw: 'Manager!2026' });
  const M3 = await makeAccount({ username: 'm3@concentrix.com', role: 'manager', nom: 'Sagbo', prenom: 'Yao', email: 'm3@concentrix.com', projet: 'Lydia', pw: 'Manager!2026' });
  check('4 comptes opérationnels (1 recruteur + 3 managers)', !!REC && !!M1 && !!M2 && !!M3);

  // ---------- 8. Import CSV ----------
  console.log('\n[6] Import CSV (dédoublonnage, seuil SHL)');
  // NB : en-têtes SANS accents (« Prenom », « Residence », « Age ») — la
  // détection de colonnes par mots-clés de l'app d'origine ne reconnait pas
  // « Prénom »/« Résidence » (accent), comme l'app elle-même.
  // Résidences sans virgule : le séparateur CSV est déduit par ligne ; une
  // virgule dans la ligne basculerait toute la ligne en mode « , » (comportement d'origine).
  const CSV = [
    'Nom;Prenom;Email;Contact;Note 1;Note 2;Note 3;Sexe;Niveau;Domaine;Age;Residence',
    'Kossou;Aline;aline.kossou@test.com;01 01 01 01 01;85;90;88;Femme;LICENCE;Commerce;29;Abomey-Calavi',
    'Dossou;Jean;jean.dossou@test.com;02 02 02 02 02;70;75;80;Homme;BAC;;25;Cotonou',
    'Hounkpatin;Marie;marie.hounkpatin@test.com;03 03 03 03 03;82;84;81;Femme;MASTER;Marketing;27;Porto-Novo',
    'Kossou;Aline;aline.kossou@test.com;01 01 01 01 01;85;90;88;Femme;LICENCE;Commerce;29;Abomey-Calavi',
    'Adjallé;Paul;paul.adjalle@test.com;04 04 04 04 04;90;92;91;Homme;THESE;Ingénierie;33;Parakou',
  ].join('\n');
  {
    const fd = new FormData();
    fd.append('file', new File([CSV], 'import.csv', { type: 'text/csv' }));
    r = await call(api.candidatsImport, req('POST', '/api/candidats/import', { token: RH, raw: fd }));
    check('import CSV → 4 ajoutés, 1 doublon, 3 visibles (≥ 80)', r.status === 200 && r.data.added === 4 && r.data.doublons === 1 && r.data.visibles === 3, JSON.stringify(r.data));
  }
  r = await call(api.candidatsImport, req('POST', '/api/candidats/import', { token: REC, raw: new FormData() }));
  check('import refusé en tant que recruteur → 403', r.status === 403);
  {
    const fd = new FormData();
    fd.append('file', new File(['\n'], 'vide.csv', { type: 'text/csv' }));
    r = await call(api.candidatsImport, req('POST', '/api/candidats/import', { token: RH, raw: fd }));
    check('import sans ligne exploitable → 400', r.status === 400 && /aucune ligne exploitable/.test(r.data.message || ''), JSON.stringify(r.data));
  }

  // ---------- 9. Import Excel ----------
  console.log('\n[7] Import Excel');
  {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Nom', 'Prenom', 'Email', 'Contact', 'Note 1', 'Note 2', 'Note 3', 'Sexe', 'Niveau', 'Domaine', 'Age', 'Residence'],
      ['Zinsou', 'Clarisse', 'clarisse.zinsou@test.com', '05 05 05 05 05', '88', '86', '90', 'Femme', 'LICENCE', 'Logistique', '31', 'Cotonou'],
      ['Gnahoré', 'Serge', 'serge.gnahore@test.com', '06 06 06 06 06', '79', '78', '80', 'Homme', 'BAC', '', '28', 'Lokossa'],
      ['Kossou', 'Aline', 'aline.kossou@test.com', '01 01 01 01 01', '85', '90', '88', 'Femme', 'LICENCE', 'Commerce', '29', 'Abomey-Calavi'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Candidats');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fd = new FormData();
    fd.append('file', new File([buf], 'import.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    r = await call(api.candidatsImport, req('POST', '/api/candidats/import', { token: RH, raw: fd }));
    check('import Excel → 2 ajoutés, 1 doublon, 1 visible', r.status === 200 && r.data.added === 2 && r.data.doublons === 1 && r.data.visibles === 1, JSON.stringify(r.data));
  }

  // ---------- 10. Création manuelle ----------
  console.log('\n[8] Création manuelle (RH)');
  r = await call(api.candidatsIndex, req('POST', '/api/candidats', {
    token: RH,
    body: {
      nom: 'Kponou', prenom: 'Yves', email: 'yves.kponou@test.com', contact: '07 07 07 07 07',
      notes: [81, 82, 80],
      info: { sexe: 'Homme', age: '35', niveau: 'MASTER', domaine: 'Finance', residence: 'Bohicon, Atlantique' },
    },
  }));
  check('candidat créé (RH)', r.status === 201 && !!r.data.id);
  r = await call(api.candidatsIndex, req('POST', '/api/candidats', { token: RH, body: { nom: 'X', email: 'aline.kossou@test.com', notes: [80, 80, 80] } }));
  check('email déjà présent → 409', r.status === 409);
  r = await call(api.candidatsIndex, req('POST', '/api/candidats', { token: REC, body: { nom: 'X', email: 'x@t.com', notes: [80, 80, 80] } }));
  check('création refusée en tant que recruteur → 403', r.status === 403);

  // ---------- 11. Listes + sérialisation ----------
  console.log('\n[9] Listes filtrées par rôle + sérialisation');
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: RH }));
  check('liste RH → 5 candidats (seuil SHL appliqué : 7 en base, 2 masqués)', r.status === 200 && r.data.count === 5 && r.data.total === 5, JSON.stringify(r.data.count));
  const al = r.data.candidates.find((c) => c.email === 'aline.kossou@test.com');
  check('sérialisation Aline : notes/moyenne/statut/étapes', al && al.notes.join(',') === '85,90,88' && al.moyenne === 87.7 && al.statut === 'EN_ATTENTE' && al.stages.rh.decision === 'a_faire');
  check('sérialisation Aline : résidence importée (ville simple, département non devinable)', al && al.residence === 'Abomey-Calavi' && al.ville === 'Abomey-Calavi' && al.departement === '' && al.residenceLat === null);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats?q=aline', { token: RH }));
  check('recherche « aline » → 1 candidat', r.data.count === 1 && r.data.candidates[0].email === 'aline.kossou@test.com');
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: REC }));
  check('liste recruteur → 5 (rien n\'a encore été reçu en entretien RH)', r.data.count === 5);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M1 }));
  check('liste manager (Samsung) → 0 (aucune affectation)', r.data.count === 0);

  // ---------- 12. Fiche + déblocages ----------
  console.log('\n[10] Fiche candidat + étapes débloquées');
  r = await call(api.candidatsId, req('GET', '/api/candidats/' + al.id, { token: REC }));
  check('fiche recruteur → 200 + déblocages (rh/m1 atteignables, m2/m3 non)', r.status === 200 && r.data.stages.rh.reachable && r.data.stages.m1.reachable && !r.data.stages.m2.reachable && !r.data.stages.m3.reachable);
  check('fiche recruteur → myRound null', r.data.myRound === null);
  r = await call(api.candidatsId, req('GET', '/api/candidats/' + al.id, { token: M1 }));
  check('fiche manager (non affecté) → 404', r.status === 404);

  // ---------- 13. Entretien RH (recruteur) ----------
  console.log('\n[11] Entretien RH → PRÉ-VIVIER + verrouillage');
  const infoAline = { age: '29', sexe: 'Femme', residence: 'Abomey-Calavi, Atlantique', niveau: 'LICENCE', domaine: 'Commerce' };
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: REC,
    body: {
      identity: { nom: 'Kossou', prenom: 'Aline', email: 'aline.kossou@test.com', contact: '01 01 01 01 01' },
      info: infoAline,
      stages: { rh: { date: '2026-09-15', commentaire: 'Très bon entretien, profil cohérent.', decision: 'ok' } },
    },
  }));
  check('recruteur enregistre l\'entretien RH (OK) → 200', r.status === 200);
  let fresh = r.data.candidat;
  check('statut → PRÉ-VIVIER', fresh.statut === 'PREVIVER');
  check('recruteur figé = « Mariam Diallo »', fresh.stages.rh.recruteur === 'Mariam Diallo' && fresh.stages.rh.date === '2026-09-15');
  check('géo devinée sur la résidence complète (ville + département)', fresh.ville === 'Abomey-Calavi' && fresh.departement === 'Atlantique' && fresh.residence === 'Abomey-Calavi, Atlantique');

  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: REC,
    body: { stages: { rh: { date: '2026-09-16', commentaire: 'Changement', decision: 'ko' } } },
  }));
  check('entretien RH déjà saisi → 409 (recruteur)', r.status === 409);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: RH,
    body: { stages: { rh: { date: '2026-09-16', commentaire: 'Changement', decision: 'ko' } } },
  }));
  check('entretien RH déjà saisi → 409 (même le RH — verrou définitif)', r.status === 409);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, { token: M1, body: { identity: { nom: 'Hack', prenom: '', email: 'x@t.com' } } }));
  check('manager ne modifie pas l\'identité → 403', r.status === 403);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: RH,
    body: { identity: { nom: 'Kossou', prenom: 'Aline', email: 'aline.kossou@test.com', contact: '01 01 01 01 01' } },
  }));
  check('RH modifie l\'identité sans toucher aux étapes → 200', r.status === 200);

  // ---------- 14. Pré-vivier + affectation ----------
  console.log('\n[12] Pré-vivier + affectation projet');
  r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: RH }));
  let it = r.data.items.find((x) => x.candidat.email === 'aline.kossou@test.com');
  check('Aline au pré-vivier (tour m1, rien de traité)', r.data.total === 1 && it && it.round === 'm1' && it.roundIndex === 1 && it.projetsTraites.length === 0, JSON.stringify(r.data));
  r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: M1 }));
  check('pré-vivier refusé au manager → 403', r.status === 403);
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + al.id + '/affecter', { token: RH, body: { projet: 'Samsung' } }));
  check('affectation Samsung → OK', r.status === 200 && r.data.projet === 'Samsung');
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + al.id + '/affecter', { token: RH, body: { projet: 'Inconnu' } }));
  check('projet inconnu → 400', r.status === 400);

  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M1 }));
  check('manager Samsung voit Aline (tour en cours)', r.data.count === 1);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M2 }));
  check('manager Amazon ne voit pas Aline', r.data.count === 0);
  r = await call(api.candidatsId, req('GET', '/api/candidats/' + al.id, { token: M1 }));
  check('fiche manager → myRound m1, m2 encore verrouillé', r.data.myRound === 'm1' && !r.data.stages.m2.reachable);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: M1,
    body: { stages: { m2: { date: '2026-09-18', commentaire: 'x', decision: 'ok' } } },
  }));
  check('manager saisit m2 (pas son tour) → 403', r.status === 403);

  // ---------- 15. OK manager → SELECTED ----------
  console.log('\n[13] OK manager → SELECTED');
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + al.id, {
    token: M1,
    body: { stages: { m1: { date: '2026-09-18', commentaire: 'Très solide, à embaucher.', decision: 'ok' } } },
  }));
  fresh = r.data.candidat;
  check('m1 OK → 200, statut SELECTED', r.status === 200 && fresh.statut === 'SELECTED');
  check('tour m1 : manager + projet figés', fresh.stages.m1.nomManager === 'Karim Benali' && fresh.stages.m1.projet === 'Samsung');
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M1 }));
  check('candidat SELECTED disparaît de la liste du manager', r.data.count === 0);
  r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: RH }));
  check('candidat SELECTED quitte le pré-vivier', !r.data.items.some((x) => x.candidat.email === 'aline.kossou@test.com'));

  // ---------- 16. KO/MB manager → retour pré-vivier + effacement projet ----------
  console.log('\n[14] Marie : KO/MB en cascade → REJET');
  let marie;
  r = await call(api.candidatsIndex, req('GET', '/api/candidats?q=marie', { token: RH }));
  marie = r.data.candidates[0];
  check('Marie trouvée (EN_ATTENTE)', marie && marie.statut === 'EN_ATTENTE');
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + marie.id, {
    token: REC,
    body: {
      identity: { nom: 'Hounkpatin', prenom: 'Marie', email: 'marie.hounkpatin@test.com', contact: '03 03 03 03 03' },
      info: { age: '27', sexe: 'Femme', residence: 'Porto-Novo, Littoral', niveau: 'MASTER', domaine: 'Marketing' },
      stages: { rh: { date: '2026-09-16', commentaire: 'Bonne candidate.', decision: 'ok' } },
    },
  }));
  check('Marie : entretien RH OK → PRÉ-VIVIER', r.status === 200 && r.data.candidat.statut === 'PREVIVER');
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + marie.id + '/affecter', { token: REC, body: { projet: 'Amazon' } }));
  check('Marie affectée à Amazon (par le recruteur) → OK', r.status === 200);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M2 }));
  check('manager Amazon voit Marie (tour m1)', r.data.count === 1);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + marie.id, {
    token: M2,
    body: { stages: { m1: { date: '2026-09-19', commentaire: 'Pas assez convaincant.', decision: 'ko' } } },
  }));
  fresh = r.data.candidat;
  check('m1 KO → retour PRÉ-VIVIER + projet effacé', r.status === 200 && fresh.statut === 'PREVIVER' && fresh.projet === '');
  check('tour m1 KO : projet figé sur le tour (Amazon)', fresh.stages.m1.projet === 'Amazon' && fresh.stages.m1.nomManager === 'Nabil Ouazzani');
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + marie.id + '/affecter', { token: RH, body: { projet: 'Amazon' } }));
  check('re-affectation Amazon (déjà traité) → 400', r.status === 400);
  r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: RH }));
  it = r.data.items.find((x) => x.candidat.email === 'marie.hounkpatin@test.com');
  check('pré-vivier : Marie au tour 2, projets traités [Amazon]', it && it.round === 'm2' && it.roundIndex === 2 && it.projetsTraites.join(',') === 'Amazon');
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + marie.id + '/affecter', { token: RH, body: { projet: 'Samsung' } }));
  check('affectation Samsung (tour 2) → OK', r.status === 200);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M1 }));
  check('manager Samsung voit Marie au tour m2', r.data.count === 1);
  r = await call(api.candidatsId, req('GET', '/api/candidats/' + marie.id, { token: M1 }));
  check('fiche Marie pour Samsung : myRound m2', r.data.myRound === 'm2');
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + marie.id, {
    token: M1,
    body: { stages: { m2: { date: '2026-09-20', commentaire: 'Trop mitigé.', decision: 'mb' } } },
  }));
  fresh = r.data.candidat;
  check('m2 MB → retour PRÉ-VIVIER + projet effacé', r.status === 200 && fresh.statut === 'PREVIVER' && fresh.projet === '');
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + marie.id + '/affecter', { token: RH, body: { projet: 'Samsung' } }));
  check('re-affectation Samsung (déjà traité) → 400', r.status === 400);
  r = await call(api.previvierAffecter, req('POST', '/api/previvier/' + marie.id + '/affecter', { token: RH, body: { projet: 'Lydia' } }));
  check('affectation Lydia (tour 3) → OK', r.status === 200);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M3 }));
  check('manager Lydia voit Marie au tour m3', r.data.count === 1);
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + marie.id, {
    token: M3,
    body: { stages: { m3: { date: '2026-09-21', commentaire: 'Parcours définitif sans OK.', decision: 'ko' } } },
  }));
  fresh = r.data.candidat;
  check('3 tours sans OK → REJET définitif', r.status === 200 && fresh.statut === 'REJET');
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: M3 }));
  check('candidate REJETE disparaît de la liste du manager', r.data.count === 0);
  r = await call(api.previvierIndex, req('GET', '/api/previvier', { token: RH }));
  check('candidat REJETE quitte le pré-vivier', !r.data.items.some((x) => x.candidat.email === 'marie.hounkpatin@test.com'));

  // ---------- 17. RH KO → REJET direct ----------
  console.log('\n[15] Paul : RH KO → REJET');
  let paul;
  r = await call(api.candidatsIndex, req('GET', '/api/candidats?q=paul', { token: RH }));
  paul = r.data.candidates[0];
  r = await call(api.candidatsId, req('PUT', '/api/candidats/' + paul.id, {
    token: REC,
    body: {
      identity: { nom: 'Adjallé', prenom: 'Paul', email: 'paul.adjalle@test.com', contact: '04 04 04 04 04' },
      info: { age: '33', sexe: 'Homme', residence: 'Parakou, Atacora', niveau: 'THESE', domaine: 'Ingénierie' },
      stages: { rh: { date: '2026-09-17', commentaire: 'Inadapté au profil.', decision: 'ko' } },
    },
  }));
  check('RH KO → REJET direct', r.status === 200 && r.data.candidat.statut === 'REJET');

  // ---------- 18. Statistiques ----------
  console.log('\n[16] Statistiques (RH)');
  r = await call(api.stats, req('GET', '/api/stats', { token: RH }));
  const s = r.data;
  check('stats : 7 candidats au total (seuil non filtré)', s.total === 7);
  check('stats : 3 entretiens RH / 4 manager sur la période', s.rhEntretiens === 3 && s.mgrEntretiens === 4);
  check('stats : décisions RH {ok:2, ko:1}', s.rhDecisions.ok === 2 && s.rhDecisions.ko === 1 && s.rhDecisions.mb === 0);
  check('stats : décisions manager {ok:1, ko:2, mb:1}', s.mgrDecisions.ok === 1 && s.mgrDecisions.ko === 2 && s.mgrDecisions.mb === 1);
  check('stats : 4 hommes / 3 femmes', s.hommes === 4 && s.femmes === 3);
  check('stats : moyenne SHL 83.4', s.moyenne === 83.4, String(s.moyenne));
  check('stats : par niveau {BAC:2, LICENCE:2, MASTER:2, THESE:1, BEPC:0}', s.parNiveau.BAC === 2 && s.parNiveau.LICENCE === 2 && s.parNiveau.MASTER === 2 && s.parNiveau.THESE === 1 && s.parNiveau.BEPC === 0);
  check('stats : par statut {SELECTED:1, REJET:2, EN_ATTENTE:4}', s.parStatut.SELECTED === 1 && s.parStatut.PREVIVER === 0 && s.parStatut.REJET === 2 && s.parStatut.EN_ATTENTE === 4);
  r = await call(api.stats, req('GET', '/api/stats?geoloc=oui', { token: RH }));
  check('stats géoloc : 3 reçus en RH, répartition par ville', r.data.totalRecusRh === 3 && r.data.parVille.length === 3 && r.data.parVille.every((v) => v[1] === 1));
  r = await call(api.stats, req('GET', '/api/stats?from=2026-09-20', { token: RH }));
  check('stats période (depuis 2026-09-20) : 0 RH / 2 manager', r.data.rhEntretiens === 0 && r.data.mgrEntretiens === 2);
  r = await call(api.stats, req('GET', '/api/stats?statut=REJET', { token: RH }));
  check('stats filtre statut=REJET → 2 candidats', r.data.total === 2);
  r = await call(api.stats, req('GET', '/api/stats', { token: M1 }));
  check('stats refusées au manager → 403', r.status === 403);

  // ---------- 19. PV de synthèse ----------
  console.log('\n[17] PV de synthèse (managers)');
  r = await call(api.pv, req('GET', '/api/pv', { token: M1 }));
  check('PV manager Samsung : 2 entretiens (Aline OK, Marie MB)', r.data.total === 2 && r.data.ok === 1 && r.data.mb === 1 && r.data.ko === 0, JSON.stringify(r.data));
  check('PV Samsung : lignes triées par date, noms + étapes', r.data.rows[0].candidat === 'Kossou Aline' && r.data.rows[0].etapeLabel === 'Entretien Manager 1' && r.data.rows[1].candidat === 'Hounkpatin Marie' && r.data.rows[1].etapeLabel === 'Entretien Manager 2');
  r = await call(api.pv, req('GET', '/api/pv', { token: M2 }));
  check('PV manager Amazon : 1 entretien (Marie KO)', r.data.total === 1 && r.data.ko === 1);
  r = await call(api.pv, req('GET', '/api/pv', { token: M3 }));
  check('PV manager Lydia : 1 entretien (Marie KO, m3)', r.data.total === 1 && r.data.rows[0].etapeLabel === 'Entretien Manager 3');
  r = await call(api.pv, req('GET', '/api/pv', { token: RH }));
  check('PV refusé au RH → 403', r.status === 403);

  // ---------- 20. Suppression + droits ----------
  console.log('\n[18] Suppression + refus de droits');
  const nEntAvant = await db`SELECT count(*)::int AS n FROM entretiens`;
  check('base : 7 entretiens avant suppression (RH×3 + M1×2 + M2×1 + M3×1)', nEntAvant[0].n === 7);
  r = await call(api.candidatsId, req('DELETE', '/api/candidats/' + marie.id, { token: REC }));
  check('suppression refusée au recruteur → 403', r.status === 403);
  r = await call(api.candidatsId, req('DELETE', '/api/candidats/' + marie.id, { token: RH }));
  check('suppression RH → OK', r.status === 200);
  r = await call(api.candidatsId, req('GET', '/api/candidats/' + marie.id, { token: RH }));
  check('candidat supprimé → 404', r.status === 404);
  r = await call(api.candidatsIndex, req('GET', '/api/candidats', { token: RH }));
  check('liste RH → 4 candidats restants (visibles)', r.data.count === 4);

  // ---------- 21. Cohérence base ----------
  console.log('\n[19] Cohérence en base');
  const nCand = await db`SELECT count(*)::int AS n FROM candidats`;
  check('base : 6 candidats (7 créés − 1 supprimé)', nCand[0].n === 6);
  const nEnt = await db`SELECT count(*)::int AS n FROM entretiens`;
  // Les 4 entretiens de Marie ont été cascade-supprimés avec son candidat
  // (ON DELETE CASCADE) — il reste ceux d'Aline (RH + M1) et de Paul (RH).
  check('base : 3 entretiens restants (les 4 de Marie cascade-supprimés avec son candidat)', nEnt[0].n === 3);
  const lock = await db`SELECT e.etape FROM entretiens e JOIN candidats c ON c.id = e.candidat_id WHERE c.email = 'aline.kossou@test.com' AND e.etape = 'RH'`;
  check('base : entretien RH d\'Aline verrouillé (1 ligne, décision OK)', lock.length === 1 && lock[0].etape === 'RH');
  const auditRows = await db`SELECT count(*)::int AS n FROM audit_log`;
  check('audit alimenté (≥ 15 événements)', auditRows[0].n >= 15);
} finally {
  await db.end();
  await ep.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(projectRoot, '.validate-bundle'), { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} RÉSULTAT ÉTAPE 3 : ${passed} réussi(s), ${failed} échec(s).`);
process.exit(failed === 0 ? 0 : 1);
