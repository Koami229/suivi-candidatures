import { json, err, run, readJson, requireAuth, audit } from '../../src/api/http';
import {
  fetchAllCandidates,
  visibleForRole,
  computeMoyenne,
  newCandidateId,
  sanitizeInfo,
} from '../../src/api/candidats';
import { sql } from '../../db/client';

/**
 * GET /api/candidats?q=…  — liste filtrée par rôle (reprise de visibleForRole)
 *     et recherche sur nom/prénom/email (identique au champ de recherche).
 * POST /api/candidats     — création d'un candidat (RH).
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const role = auth.role;
  const managerProjet = role === 'manager' ? (String(auth.account.projet || null) || null) : null;

  if (req.method === 'GET') {
    const q = (new URL(req.url).searchParams.get('q') || '').trim().toLowerCase();
    const all = await fetchAllCandidates();
    const scoped = all.filter((c) => visibleForRole(c, role, managerProjet));
    const filtered = q
      ? scoped.filter((c) => (c.nom + ' ' + c.prenom + ' ' + c.email).toLowerCase().includes(q))
      : scoped;
    return json({ candidates: filtered, count: filtered.length, total: scoped.length });
  }

  if (req.method === 'POST') {
    if (role !== 'rh') return err('Accès refusé.', 403);
    const body = await readJson(req);
    const nom = String(body.nom || '').trim();
    const prenom = String(body.prenom || '').trim();
    const email = String(body.email || '').trim();
    const notes = Array.isArray(body.notes) ? body.notes.map((n: unknown) => parseFloat(String(n))) : [];
    const n = [notes[0] || 0, notes[1] || 0, notes[2] || 0];
    if (!nom) return err('Le nom est obligatoire.', 400);
    if (!email) return err("L'email est obligatoire.", 400);
    const dupe = await sql`SELECT 1 FROM candidats WHERE lower(email) = lower(${email})`;
    if (dupe.length) return err('Ce candidat existe déjà (email déjà présent).', 409);
    const info = sanitizeInfo((body.info || {}) as Record<string, any>);
    const id = newCandidateId();
    await sql`
      INSERT INTO candidats (id, nom, prenom, email, contact, sexe, age, niveau_etude, domaine_etude,
        residence, departement, ville, residence_lat, residence_lng, experience_concurrents,
        projet, langues, informatique, shl_note_1, shl_note_2, shl_note_3, moyenne_shl)
      VALUES (${id}, ${nom}, ${prenom}, ${email}, ${String(body.contact || '')}, ${info.sexe}, ${info.age},
        ${info.niveauEtude}, ${info.domaineEtude}, ${info.residence}, ${info.departement}, ${info.ville},
        ${info.residenceLat}, ${info.residenceLng}, ${info.experienceConcurrents}, '', ${info.langues},
        ${info.informatique}, ${n[0]}, ${n[1]}, ${n[2]}, ${computeMoyenne(n)})`;
    await audit(auth.username, 'candidat.cree', 'candidat', id);
    return json({ id }, 201);
  }

  return err('Méthode non autorisée.', 405);
});
