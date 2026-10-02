import * as XLSX from 'xlsx';
import { json, err, run, requireAuth, audit } from '../../src/api/http';
import { fetchAllCandidates, processRows, computeMoyenne, sanitizeInfo, passesThreshold } from '../../src/api/candidats';
import { sql } from '../../db/client';

/**
 * POST /api/candidats/import  (RH) — multipart/form-data, champ `file`.
 *
 * Import Excel/CSV traité CÔTE SERVEUR, logique identique à l'app :
 * - détection du séparateur CSV (; ou ,), en-têtes par mots-clés,
 *   notes SHL 1-3 (ou colonnes « score »), « nom complet » → nom/prénom ;
 * - moyenne recalculée (même formule que l'app) ;
 * - dédoublonnage par email (contre la base ET au sein du fichier).
 */

function splitLine(line: string): string[] {
  const sep = line.indexOf(';') !== -1 && line.indexOf(',') === -1 ? ';' : ',';
  return line.split(sep).map((s) => s.trim().replace(/^"|"$/g, ''));
}

function parseCsv(text: string): string[][] {
  return String(text)
    .split(/\r\n|\n/)
    .filter((l) => l.trim() !== '')
    .map(splitLine);
}

export default run(async (req: Request) => {
  if (req.method !== 'POST') return err('Méthode non autorisée.', 405);
  const auth = await requireAuth(req, ['rh']);
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err('Envoi invalide (multipart/form-data attendu avec le champ « file »).', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return err('Aucun fichier reçu (champ « file »).', 400);
  }

  const isExcel = /\.(xlsx?)$/i.test(file.name);
  let rows: any[][];
  try {
    if (isExcel) {
      const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    } else {
      rows = parseCsv(await file.text());
    }
  } catch {
    return err('Import impossible : vérifiez le format du fichier (Excel/CSV).', 400);
  }

  // Emails déjà présents en base (dédoublonnage conservé de l'app).
  const existing = new Set<string>();
  const all = await fetchAllCandidates();
  for (const c of all) if (c.email) existing.add(c.email.toLowerCase());

  const { added, doublons } = processRows(rows as any[][], existing);
  if (added.length === 0 && doublons === 0) {
    return err('Import impossible : aucune ligne exploitable dans le fichier (colonnes attendues : nom du candidat, téléphone, email, 3 notes SHL).', 400);
  }

  // Transaction sur une connexion réservée (postgres.js : un BEGIN n'est
  // autorisé que sur max: 1 ou une connexion réservée — le pool de
  // production est à max: 10).
  const reserved: any = await (sql as any).reserve();
  try {
    await reserved.unsafe('begin');
    for (const c of added) {
      const info = sanitizeInfo({
        sexe: c.sexe,
        age: c.age,
        niveau: c.niveauEtude,
        domaine: c.domaineEtude,
        residence: c.residence,
        departement: c.departement,
        ville: c.ville,
        residenceLat: c.residenceLat ?? '',
        residenceLng: c.residenceLng ?? '',
        experience: '',
        langues: [],
        informatique: [],
      });
      await reserved`
        INSERT INTO candidats (id, nom, prenom, email, contact, sexe, age, niveau_etude, domaine_etude,
          residence, departement, ville, residence_lat, residence_lng, experience_concurrents,
          projet, langues, informatique, shl_note_1, shl_note_2, shl_note_3, moyenne_shl)
        VALUES (${c.id}, ${c.nom}, ${c.prenom}, ${c.email}, ${c.contact}, ${info.sexe}, ${info.age},
          ${info.niveauEtude}, ${info.domaineEtude}, ${info.residence}, ${info.departement}, ${info.ville},
          ${info.residenceLat}, ${info.residenceLng}, ${info.experienceConcurrents}, '', ${info.langues},
          ${info.informatique}, ${c.notes[0]}, ${c.notes[1]}, ${c.notes[2]}, ${computeMoyenne(c.notes)})`;
    }
    await reserved.unsafe('commit');
  } catch (e) {
    try {
      await reserved.unsafe('rollback');
    } catch {
      // connexion déjà fermée — rien à faire
    }
    throw e;
  } finally {
    reserved.release();
  }

  const visibles = added.filter((c) => passesThreshold(c.moyenne)).length;
  await audit(auth.username, 'candidat.import', undefined, undefined, { added: added.length, doublons, visibles });
  return json({ added: added.length, visibles, doublons });
});
