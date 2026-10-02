import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../../db/client';
import { SEUIL_SHL, NIVEAUX, PROJETS, DEPARTEMENTS, LANGUES, COMPETENCES_INFO, EXPERIENCES_CONCURRENTS } from '../lib/constants';

/**
 * Modèle « candidat » de l'API.
 *
 * Le candidat est sérialisé à l'IDENTIQUE de l'objet JS de l'app actuelle
 * (id, nom, prenom, email, contact, sexe, age, niveauEtude, domaineEtude,
 * residence, departement, ville, residenceLat/Lng, experienceConcurrents,
 * projet, langues[], informatique[], notes[], moyenne, stages{rh,m1,m2,m3})
 * + `statut` calculé — ce qui limite au minimum les changements du front.
 */

const DEC_DB_TO_JS: Record<string, string> = { OK: 'ok', KO: 'ko', MB: 'mb' };
const DEC_JS_TO_DB: Record<string, string> = { ok: 'OK', ko: 'KO', mb: 'MB' };
const ETAPES_DB = ['RH', 'M1', 'M2', 'M3'] as const;
const ETAPES_JS: Record<string, string> = { RH: 'rh', M1: 'm1', M2: 'm2', M3: 'm3' };
export const STAGE_LABELS: Record<string, string> = { rh: 'Entretien RH', m1: 'Entretien Manager 1', m2: 'Entretien Manager 2', m3: 'Entretien Manager 3' };

export function emptyStageJs() {
  return { note: '', decision: 'a_faire', commentaire: '', recruteur: '', projet: '', nomManager: '', date: '' };
}

export function computeMoyenne(notes: number[]): number {
  // Mêmes arrondis que l'app JS : Math.round((sum/3) * 10) / 10
  const sum = notes.reduce((a, b) => a + (Number(b) || 0), 0);
  return Math.round((sum / 3) * 10) / 10;
}

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  return s || '';
}

/** Charge tous les candidats + leurs entretiens et les sérialise (forme JS). */
export async function fetchAllCandidates(): Promise<Record<string, any>[]> {
  const cRows = await sql`SELECT * FROM candidats ORDER BY cree_le, id`;
  const eRows = await sql`SELECT * FROM entretiens`;
  const byCandidate: Record<string, any[]> = {};
  for (const e of eRows) {
    (byCandidate[e.candidat_id] = byCandidate[e.candidat_id] || []).push(e);
  }
  return cRows.map((c: any) => serializeCandidate(c, byCandidate[c.id] || []));
}

function serializeCandidate(c: any, eRows: any[]): Record<string, any> {
  const stages: Record<string, any> = { rh: emptyStageJs(), m1: emptyStageJs(), m2: emptyStageJs(), m3: emptyStageJs() };
  for (const e of eRows) {
    const key = ETAPES_JS[e.etape];
    if (!key) continue;
    const isRh = e.etape === 'RH';
    stages[key] = {
      note: e.note ?? '',
      decision: e.decision ? DEC_DB_TO_JS[e.decision] : 'a_faire',
      commentaire: e.commentaire ?? '',
      recruteur: isRh ? e.acteur_nom || '' : '',
      nomManager: isRh ? '' : e.acteur_nom || '',
      projet: e.projet ?? '',
      date: fmtDate(e.date_entretien),
    };
  }
  return {
    id: c.id,
    nom: c.nom,
    prenom: c.prenom,
    email: c.email,
    contact: c.contact ?? '',
    sexe: c.sexe ?? '',
    age: c.age ?? '',
    niveauEtude: c.niveau_etude ?? '',
    domaineEtude: c.domaine_etude ?? '',
    residence: c.residence ?? '',
    departement: c.departement ?? '',
    ville: c.ville ?? '',
    residenceLat: c.residence_lat ?? null,
    residenceLng: c.residence_lng ?? null,
    experienceConcurrents: c.experience_concurrents ?? '',
    projet: c.projet ?? '',
    langues: c.langues || [],
    informatique: c.informatique || [],
    notes: [Number(c.shl_note_1), Number(c.shl_note_2), Number(c.shl_note_3)],
    moyenne: Number(c.moyenne_shl),
    stages,
    statut: statutCode(stages),
  };
}

// ---------------------------------------------------------------------
// Logique pipeline — portée À L'IDENTIQUE de l'app JS (déjà prouvé
// équivalent sur les 256 combinaisons de décisions, étape 1).
// ---------------------------------------------------------------------

/** Reprise de computeStatutCode() / estSortiDefinitivement(). */
export function statutCode(stages: Record<string, any>): string {
  const managerFavorable = ['m1', 'm2', 'm3'].some((k) => stages[k].decision === 'ok');
  if (managerFavorable) return 'SELECTED';
  const tousRealises = ['m1', 'm2', 'm3'].every((k) => stages[k].decision !== 'a_faire');
  const aucunFavorable = !['m1', 'm2', 'm3'].some((k) => stages[k].decision === 'ok');
  if (tousRealises && aucunFavorable) return 'REJET';
  if (stages.rh.decision === 'ok') return 'PREVIVER';
  if (stages.rh.decision === 'ko') return 'REJET';
  return 'EN_ATTENTE';
}

/** Reprise de isStageUnlocked() — déblocage séquentiel des tours manager. */
export function isStageUnlocked(stages: Record<string, any>, key: string): boolean {
  if (key === 'm2') return stages.m1.decision !== 'a_faire' && stages.m1.decision !== 'ok';
  if (key === 'm3') return stages.m2.decision !== 'a_faire' && stages.m2.decision !== 'ok';
  return true;
}

/** Reprise de currentManagerRound(). */
export function currentManagerRound(stages: Record<string, any>): 'm1' | 'm2' | 'm3' | null {
  if (stages.rh.decision !== 'ok') return null;
  for (const k of ['m1', 'm2', 'm3'] as const) {
    const d = stages[k].decision;
    if (d === 'a_faire') return k;
    if (d === 'ok') return null;
  }
  return null;
}

/** Reprise de projetsDejaTraites(). */
export function projetsDejaTraites(stages: Record<string, any>): string[] {
  const vus: string[] = [];
  for (const k of ['m1', 'm2', 'm3']) {
    const d = stages[k];
    if (d.decision !== 'a_faire' && d.projet && !vus.includes(d.projet)) vus.push(d.projet);
  }
  return vus;
}

/** Reprise de passesThreshold(). */
export function passesThreshold(moyenne: number): boolean {
  return moyenne >= SEUIL_SHL;
}

/** Reprise de visibleForRole(). */
export function visibleForRole(c: Record<string, any>, role: string, managerProjet: string | null): boolean {
  if (!passesThreshold(c.moyenne)) return false;
  if (role === 'rh') return true;
  if (role === 'recruteur') return c.stages.rh.decision === 'a_faire';
  if (role === 'manager') {
    if (!managerProjet || c.projet !== managerProjet) return false;
    return currentManagerRound(c.stages) !== null;
  }
  return false;
}

/** Reprise de estDansPrevivier(). */
export function estDansPrevivier(c: Record<string, any>): boolean {
  return passesThreshold(c.moyenne) && c.statut === 'PREVIVER';
}

/**
 * Reprise de canStillView() : le recruteur peut ouvrir une fiche depuis
 * « Candidats » (en attente d'entretien RH) ou depuis le « Pré-vivier »
 * (déjà validés) ; le manager ne doit jamais perdre sa fiche en cours.
 */
export function canStillView(c: Record<string, any>, role: string, managerProjet: string | null): boolean {
  if (role === 'rh') return true;
  if (role === 'recruteur') return c.stages.rh.decision === 'a_faire' || estDansPrevivier(c);
  if (role === 'manager') return visibleForRole(c, role, managerProjet);
  return false;
}

// ---------------------------------------------------------------------
// Reprise des fonctions de géolocalisation textuelle (saisie manuelle /
// import) — l'autocomplétion Geoapify reviendra via un proxy API (clé en
// variable d'environnement), jamais codée en dur.
// ---------------------------------------------------------------------

function stripAccents(s: string): string {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function guessDepartementFromText(text: string): string {
  if (!text) return '';
  const norm = stripAccents(text).toLowerCase();
  for (const d of DEPARTEMENTS) {
    if (norm.includes(stripAccents(d).toLowerCase())) return d;
  }
  return '';
}

export function guessVilleFromText(text: string): string {
  if (!text) return '';
  return String(text).split(',')[0].trim();
}

// ---------------------------------------------------------------------
// Reprise de l'import (processRows de l'app) — correspondance de colonnes
// par mots-clés, notes SHL, dédoublonnage par email.
// ---------------------------------------------------------------------

function splitFullName(full: string): { nom: string; prenom: string } {
  const parts = String(full || '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (parts.length === 0) return { nom: '', prenom: '' };
  if (parts.length === 1) return { nom: parts[0], prenom: '' };
  return { nom: parts[parts.length - 1], prenom: parts.slice(0, -1).join(' ') };
}

export function processRows(
  rows: any[][],
  existingEmails: Set<string>
): { added: Record<string, any>[]; doublons: number } {
  if (rows.length === 0) return { added: [], doublons: 0 };
  const header = rows[0].map((h) => String(h || '').trim().toLowerCase());

  const findNoteCol = (n: number) =>
    header.findIndex((h) => (h.includes('note') || h.includes('score') || h.includes('shl')) && h.includes(String(n)));
  const scoreLikeCols = () => {
    const cols: number[] = [];
    header.forEach((h, i) => {
      if (h.includes('shl') || h.includes('score') || (h.includes('note') && h !== 'note')) cols.push(i);
    });
    return cols;
  };

  const idx = {
    nom: header.findIndex((h) => h.includes('nom') && !h.includes('pren')),
    prenom: header.findIndex((h) => h.includes('pren')),
    fullname: header.findIndex((h) => h === 'candidate name' || h.includes('nom complet') || (h.includes('name') && !h.includes('first') && !h.includes('last'))),
    email: header.findIndex((h) => h.includes('mail')),
    contact: header.findIndex((h) => h.includes('contact') || h.includes('tel') || h.includes('phone')),
    residence: header.findIndex((h) => h.includes('resid') || h.includes('adress')),
    sexe: header.findIndex((h) => h.includes('sexe') || h.includes('genre')),
    niveau: header.findIndex((h) => h.includes('niveau')),
    domaine: header.findIndex((h) => h.includes('domaine')),
    age: header.findIndex((h) => h.includes('age') || h.includes('âge')),
  };
  let n1 = findNoteCol(1);
  let n2 = findNoteCol(2);
  let n3 = findNoteCol(3);
  if (n1 === -1 && n2 === -1 && n3 === -1) {
    const sc = scoreLikeCols();
    n1 = sc[0] !== undefined ? sc[0] : -1;
    n2 = sc[1] !== undefined ? sc[1] : -1;
    n3 = sc[2] !== undefined ? sc[2] : -1;
  }

  const startRow = idx.nom === -1 && idx.fullname === -1 && idx.email === -1 ? 0 : 1;
  const added: Record<string, any>[] = [];
  let doublons = 0;

  for (let i = startRow; i < rows.length; i++) {
    const cols = rows[i];
    if (!cols || (cols.length === 1 && String(cols[0]).trim() === '') || cols.every((v) => String(v ?? '').trim() === '')) continue;

    const emailRaw = String(idx.email !== -1 ? (cols[idx.email] ?? '') : (cols[2] ?? '') || '').trim();
    const emailLower = emailRaw.toLowerCase();
    if (emailLower && existingEmails.has(emailLower)) {
      doublons++;
      continue;
    }

    let nomVal = '';
    let prenomVal = '';
    if (idx.nom !== -1) {
      nomVal = String(cols[idx.nom] || '');
      prenomVal = idx.prenom !== -1 ? String(cols[idx.prenom] || '') : '';
    } else if (idx.fullname !== -1) {
      const split = splitFullName(String(cols[idx.fullname]));
      nomVal = split.nom;
      prenomVal = split.prenom;
    } else {
      nomVal = String(cols[0] || '');
      prenomVal = String(cols[1] || '');
    }

    const v1 = n1 !== -1 ? parseFloat(String(cols[n1])) : parseFloat(String(cols[4] ?? ''));
    const v2 = n2 !== -1 ? parseFloat(String(cols[n2])) : parseFloat(String(cols[5] ?? ''));
    const v3 = n3 !== -1 ? parseFloat(String(cols[n3])) : parseFloat(String(cols[6] ?? ''));
    const notes = [Number.isNaN(v1) ? 0 : v1, Number.isNaN(v2) ? 0 : v2, Number.isNaN(v3) ? 0 : v3];

    const residence = idx.residence !== -1 ? String(cols[idx.residence] || '') : '';
    const c: Record<string, any> = {
      id: 'c_' + randomBytes(4).toString('hex'),
      nom: nomVal,
      prenom: prenomVal,
      email: emailRaw,
      contact: String(idx.contact !== -1 ? cols[idx.contact] : (cols[3] || '') || ''),
      sexe: idx.sexe !== -1 ? String(cols[idx.sexe] || '') : '',
      age: idx.age !== -1 ? String(cols[idx.age] || '') : '',
      niveauEtude: idx.niveau !== -1 ? String(cols[idx.niveau] || '').toUpperCase() : '',
      domaineEtude: idx.domaine !== -1 ? String(cols[idx.domaine] || '') : '',
      residence,
      departement: guessDepartementFromText(residence),
      ville: guessVilleFromText(residence),
      residenceLat: null,
      residenceLng: null,
      experienceConcurrents: '',
      projet: '',
      langues: [],
      informatique: [],
      notes,
      moyenne: computeMoyenne(notes),
    };
    added.push(c);
    if (emailLower) existingEmails.add(emailLower);
  }
  return { added, doublons };
}

// ---------------------------------------------------------------------
// Statistiques — portée de renderStats() (mêmes métriques, mêmes filtres).
// ---------------------------------------------------------------------

function inPeriod(dateStr: string, from: string, to: string): boolean {
  if (!dateStr) return false;
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;
  return true;
}

function countDecisions(arr: string[]): Record<string, number> {
  const o: Record<string, number> = { ok: 0, ko: 0, mb: 0 };
  arr.forEach((v) => {
    if (o[v] !== undefined) o[v]++;
  });
  return o;
}

export async function computeStats(p: {
  from?: string;
  to?: string;
  sexe?: string;
  niveau?: string;
  projet?: string;
  geoloc?: string;
  statut?: string;
}) {
  const all = await fetchAllCandidates();
  const list = all.filter((c) => {
    if (p.sexe && c.sexe !== p.sexe) return false;
    if (p.niveau && c.niveauEtude !== p.niveau) return false;
    if (p.projet && c.projet !== p.projet) return false;
    if (p.statut && c.statut !== p.statut) return false;
    return true;
  });

  const total = list.length;
  const rhDone: string[] = [];
  const mgrDone: string[] = [];
  for (const c of list) {
    if (c.stages.rh.decision !== 'a_faire' && inPeriod(c.stages.rh.date, p.from || '', p.to || '')) {
      rhDone.push(c.stages.rh.decision);
    }
    for (const k of ['m1', 'm2', 'm3']) {
      const d = c.stages[k];
      if (d.decision !== 'a_faire' && inPeriod(d.date, p.from || '', p.to || '')) {
        mgrDone.push(d.decision);
      }
    }
  }
  const rhC = countDecisions(rhDone);
  const mgrC = countDecisions(mgrDone);
  const hommes = list.filter((c) => c.sexe === 'Homme').length;
  const femmes = list.filter((c) => c.sexe === 'Femme').length;
  const moyGlobale = total ? list.reduce((s, c) => s + c.moyenne, 0) / total : 0;

  const niveauCounts: Record<string, number> = {};
  for (const n of NIVEAUX) niveauCounts[n] = 0;
  for (const c of list) {
    if (niveauCounts[c.niveauEtude] !== undefined) niveauCounts[c.niveauEtude]++;
  }
  const statutCounts: Record<string, number> = { SELECTED: 0, PREVIVER: 0, REJET: 0, EN_ATTENTE: 0 };
  for (const c of list) statutCounts[c.statut] = (statutCounts[c.statut] || 0) + 1;

  let parVille: [string, number][] | null = null;
  let totalRecusRh = 0;
  if (p.geoloc === 'oui') {
    const listRecusRh = list.filter((c) => c.stages.rh.decision !== 'a_faire');
    totalRecusRh = listRecusRh.length;
    const villeCounts: Record<string, number> = {};
    let sansVille = 0;
    for (const c of listRecusRh) {
      const v = (c.ville || '').trim();
      if (v) villeCounts[v] = (villeCounts[v] || 0) + 1;
      else sansVille++;
    }
    parVille = Object.keys(villeCounts)
      .map((v) => [v, villeCounts[v]] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    if (sansVille > 0) parVille.push(['Non renseigné', sansVille]);
  }

  return {
    total,
    rhEntretiens: rhDone.length,
    mgrEntretiens: mgrDone.length,
    hommes,
    femmes,
    moyenne: Math.round(moyGlobale * 10) / 10,
    parNiveau: niveauCounts,
    parStatut: statutCounts,
    parVille,
    totalRecusRh,
    rhDecisions: rhC,
    mgrDecisions: mgrC,
  };
}

// ---------------------------------------------------------------------
// PV de synthèse (manager) — portée de collectManagerInterviews().
// ---------------------------------------------------------------------

export async function computePv(managerName: string, projet: string) {
  const all = await fetchAllCandidates();
  const rows: Record<string, any>[] = [];
  for (const c of all) {
    for (const k of ['m1', 'm2', 'm3']) {
      const d = c.stages[k];
      if (d.decision !== 'a_faire' && d.nomManager === managerName && d.projet === projet) {
        rows.push({
          candidat: c.nom + ' ' + c.prenom,
          etapeLabel: STAGE_LABELS[k],
          decision: d.decision,
          date: d.date,
          commentaire: d.commentaire,
          note: d.note,
        });
      }
    }
  }
  rows.sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return da.localeCompare(db);
    return a.candidat.localeCompare(b.candidat);
  });
  return {
    manager: managerName,
    projet,
    dateEdition: new Date().toISOString().slice(0, 10),
    total: rows.length,
    ok: rows.filter((r) => r.decision === 'ok').length,
    ko: rows.filter((r) => r.decision === 'ko').length,
    mb: rows.filter((r) => r.decision === 'mb').length,
    rows,
  };
}

// ---------------------------------------------------------------------
// Helpers d'écriture
// ---------------------------------------------------------------------

export function newCandidateId(): string {
  return 'c_' + randomBytes(4).toString('hex');
}

/** Normalise/valide les valeurs d'« info candidat » (règles de l'app). */
export function sanitizeInfo(info: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  out.sexe = info.sexe === 'Homme' || info.sexe === 'Femme' ? info.sexe : '';
  const age = parseInt(String(info.age ?? ''), 10);
  out.age = Number.isInteger(age) && age >= 18 && age <= 99 ? age : null;
  out.niveauEtude = NIVEAUX.includes(info.niveau) ? info.niveau : '';
  out.domaineEtude = String(info.domaine ?? '').trim();
  out.residence = String(info.residence ?? '').trim();
  out.departement =
    String(info.departement ?? '').trim() || guessDepartementFromText(out.residence);
  out.ville = String(info.ville ?? '').trim() || guessVilleFromText(out.residence);
  const lat = String(info.residenceLat ?? '').trim();
  const lng = String(info.residenceLng ?? '').trim();
  out.residenceLat = lat !== '' && !Number.isNaN(parseFloat(lat)) ? parseFloat(lat) : null;
  out.residenceLng = lng !== '' && !Number.isNaN(parseFloat(lng)) ? parseFloat(lng) : null;
  out.experienceConcurrents = EXPERIENCES_CONCURRENTS.includes(info.experience) ? info.experience : '';
  out.langues = Array.isArray(info.langues)
    ? (info.langues as string[]).filter((l) => (LANGUES as readonly string[]).includes(l))
    : [];
  out.informatique = Array.isArray(info.informatique)
    ? (info.informatique as string[]).filter((x) => (COMPETENCES_INFO as readonly string[]).includes(x))
    : [];
  return out;
}

/** Valide les info au sens de l'app (champs obligatoires de la fiche). */
export function infoIssues(info: Record<string, any>): string[] {
  const missing: string[] = [];
  const ageStr = String(info.age ?? '').trim();
  const ageVal = parseInt(ageStr, 10);
  if (!(ageStr !== '' && !Number.isNaN(ageVal) && ageVal >= 18)) {
    missing.push(ageStr === '' ? 'âge' : 'âge (18 ans minimum)');
  }
  if (!info.sexe) missing.push('sexe');
  if (!String(info.residence ?? '').trim()) missing.push('résidence');
  if (!NIVEAUX.includes(info.niveau)) missing.push('niveau d\'étude');
  const domaineRequired = info.niveau !== 'BAC' && info.niveau !== 'BEPC';
  if (domaineRequired && !String(info.domaine ?? '').trim()) missing.push('domaine d\'étude');
  return missing;
}

export function isKnownProjet(p: string): boolean {
  return PROJETS.includes(p as (typeof PROJETS)[number]);
}

/** Empreinte de contrôle d'intégrité du module (jamais exposée). */
export const _integrity = createHash('sha256').update('candidats-module').digest('hex').slice(0, 8);
