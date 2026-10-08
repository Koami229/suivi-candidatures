import { json, err, run, readJson, requireAuth, audit, sessionFullName } from '../../src/api/http';
import {
  fetchAllCandidates,
  visibleForRole,
  canStillView,
  currentManagerRound,
  isStageUnlocked,
  infoIssues,
  sanitizeInfo,
  isKnownProjet,
  controleAffectation,
  projetDejaTraite,
} from '../../src/api/candidats';
import { triggerEmail } from '../../src/api/email';
import { sql } from '../../db/client';

const DEC_JS_TO_DB: Record<string, string> = { ok: 'OK', ko: 'KO', mb: 'MB' };
const STAGE_LABELS: Record<string, string> = {
  rh: 'l\'entretien RH',
  m1: 'l\'entretien Manager 1',
  m2: 'l\'entretien Manager 2',
  m3: 'l\'entretien Manager 3',
};

/**
 * GET /api/candidats/:id   — fiche complète + étapes débloquées (pour le modal).
 * PUT /api/candidats/:id   — { identity?, info?, stages? } — règles métier :
 *   - un entretien déjà saisi est verrouillé DÉFINITIVEMENT (409, pour tous, RH y compris) ;
 *   - M2/M3 se débloquent uniquement si l'étape précédente = KO ou MB (jamais OK) ;
 *   - le recruteur ne saisit que l'entretien RH ; un manager uniquement SON tour
 *     sur le candidat qui lui est affecté (projet) ;
 *   - KO/MB d'un manager → retour au pré-vivier + effacement de l'affectation projet ;
 *   - v16 : affectation directe depuis l'entretien RH (stages.rh.projet,
 *     appliquée si décision OK, contrôles anti-doublons) ; en cas de refus,
 *     l'entretien est enregistré et la réponse porte `affectationErreur` ;
 *   - v16 : enregistrement manager refusé (400) si le projet du tour a déjà
 *     été traité sur un autre tour — l'affectation est alors effacée.
 * DELETE /api/candidats/:id — suppression (RH).
 */
export default run(async (req: Request) => {
  const auth = await requireAuth(req);
  if (!auth.ok) return auth.response;
  const role = auth.role;
  const sessionName = sessionFullName(auth.account);
  const managerProjet = role === 'manager' ? (String(auth.account.projet || '') || null) : null;

  // L'identifiant candidat est lu dans l'URL (indépendant du runtime Vercel).
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const i = parts.indexOf('candidats');
  if (i === -1 || i + 1 >= parts.length || !parts[i + 1]) return err('Identifiant manquant.', 400);
  let id: string;
  try {
    id = decodeURIComponent(parts[i + 1]);
  } catch {
    return err('Identifiant invalide.', 400);
  }

  const all = await fetchAllCandidates();
  const c = all.find((x) => x.id === id);

  if (req.method === 'GET') {
    if (!c) return err('Candidat introuvable.', 404);
    if (role === 'recruteur' && !canStillView(c, 'recruteur', null)) return err('Candidat introuvable.', 404);
    if (role === 'manager' && !visibleForRole(c, 'manager', managerProjet)) return err('Candidat introuvable.', 404);
    return json({
      candidat: c,
      // Reprise de isStageUnlocked() de l'app : rh et m1 sont toujours
      // « atteignables » ; m2/m3 se débloquent si l'étape précédente est KO/MB.
      stages: {
        rh: { reachable: true },
        m1: { reachable: true },
        m2: { reachable: isStageUnlocked(c.stages, 'm2') },
        m3: { reachable: isStageUnlocked(c.stages, 'm3') },
      },
      myRound: role === 'manager' ? currentManagerRound(c.stages) : null,
    });
  }

  if (req.method === 'DELETE') {
    if (role !== 'rh') return err('Accès refusé.', 403);
    if (!c) return err('Candidat introuvable.', 404);
    await sql`DELETE FROM candidats WHERE id = ${id}`;
    await audit(auth.username, 'candidat.supprime', 'candidat', id);
    return json({ ok: true });
  }

  if (req.method !== 'PUT') return err('Méthode non autorisée.', 405);
  if (!c) return err('Candidat introuvable.', 404);

  const body = await readJson(req);
  const identity = body.identity && typeof body.identity === 'object' ? (body.identity as Record<string, any>) : null;
  const info = body.info && typeof body.info === 'object' ? (body.info as Record<string, any>) : null;
  const stagesIn = body.stages && typeof body.stages === 'object' ? (body.stages as Record<string, any>) : null;

  // Le manager ne voit qu'un résumé en lecture seule : il ne modifie que
  // l'entretien de SON tour.
  if (role === 'manager' && (identity || info)) {
    return err('Le manager ne peut modifier que son entretien en cours.', 403);
  }

  // ----- Identité -----------------------------------------------------
  let identityErr = '';
  let newIdentity: { nom: string; prenom: string; email: string } | null = null;
  if (identity) {
    const nom = String(identity.nom ?? '').trim();
    const prenom = String(identity.prenom ?? '').trim();
    const email = String(identity.email ?? '').trim();
    if (!nom) identityErr = 'Le nom est obligatoire.';
    if (email && emailErr(email, c)) identityErr = identityErr || "L'email est invalide.";
    if (!identityErr) {
      if (email) {
        const dupe = await sql`SELECT 1 FROM candidats WHERE lower(email) = lower(${email}) AND id <> ${id}`;
        if (dupe.length) identityErr = 'Ce email est déjà utilisé par un autre candidat.';
      }
      if (!identityErr) newIdentity = { nom, prenom, email };
    }
  }

  // ----- Info candidat ------------------------------------------------
  const missing = info ? infoIssues(info) : [];
  if (missing.length) return json({ missing }, 400);

  // ----- Étapes d'entretien -------------------------------------------
  const wantedStages: string[] = stagesIn ? Object.keys(stagesIn) : [];
  const myRound = currentManagerRound(c.stages);
  const planned: Record<string, any> = {};
  let affectationErreur: string | null = null;
  for (const key of wantedStages) {
    if (!STAGE_LABELS[key]) return err('Étape inconnue.', 400);
    const cur = c.stages[key];
    // Verrouillage définitif d'un entretien déjà saisi — même pour le RH.
    if (cur.decision !== 'a_faire') {
      return err(
        `${STAGE_LABELS[key]} est déjà enregistré(e) — cette fiche est verrouillée définitivement.`,
        409
      );
    }
    // Périmètre par rôle. Le RH peut saisir tous les entretiens (ses sections sont
    // toutes affichées dans l'app) ; le recruteur, uniquement l'entretien RH ;
    // le manager, uniquement SON tour sur le candidat qui lui est affecté.
    if (role === 'recruteur' && key !== 'rh') return err('Le recruteur saisit uniquement l\'entretien RH.', 403);
    if (role === 'manager') {
      if (key !== myRound) return err(`Ce tour n'est pas le vôtre actuellement (tour en cours : ${myRound || 'aucun'}).`, 403);
      if (!managerProjet || c.projet !== managerProjet) return err('Ce candidat ne vous est pas affecté.', 403);
    }
    // Déblocage séquentiel (M2 après M1 KO/MB, M3 après M2 KO/MB).
    if ((key === 'm2' || key === 'm3') && !isStageUnlocked(c.stages, key)) {
      return err(`Le tour ${key.toUpperCase()} est verrouillé — il se débloque uniquement si l'étape précédente est KO ou MB.`, 423);
    }
    // Champs obligatoires de l'app.
    const s = (stagesIn ?? {})[key] as Record<string, any>;
    const date = String(s.date ?? '').trim();
    const commentaire = String(s.commentaire ?? '').trim();
    const decision = String(s.decision ?? '').trim();
    if (!date) return err(`La date de ${STAGE_LABELS[key]} est obligatoire.`, 400);
    if (!commentaire) return err(`Le commentaire de ${STAGE_LABELS[key]} est obligatoire.`, 400);
    if (!DEC_JS_TO_DB[decision]) return err('Une décision (OK / KO / MB) est obligatoire.', 400);
    planned[key] = {
      note: s.note === undefined || s.note === null ? '' : String(s.note).trim(),
      date,
      commentaire,
      decision: DEC_JS_TO_DB[decision],
      projet: '',
    };
  }

  // ----- Affectation directe depuis l'entretien RH (v16) -----------------
  // « Affecter au projet / poste correspondant » (facultatif) : appliquée
  // uniquement si la décision est OK — un candidat KO/MB n'est affecté à
  // aucun projet. Les contrôles v16 s'appliquent (projet déjà traité,
  // doublons). En cas de refus, l'entretien est enregistré sans affectation.
  if (planned.rh) {
    const projRh = String((stagesIn as any).rh.projet ?? '').trim();
    if (projRh && !isKnownProjet(projRh)) return err('Projet inconnu.', 400);
    if (projRh && planned.rh.decision === 'OK') {
      const ctrl = controleAffectation(c, projRh, all);
      if (ctrl.ok) planned.rh.projet = projRh;
      else affectationErreur = ctrl.message;
    }
  }

  // ----- Contrôle bloquant du manager (v16) ------------------------------
  // Le tour enregistré doit être rattaché à un projet que le candidat n'a
  // jamais reçu sur un autre tour Manager. Sinon rien n'est enregistré et
  // l'affectation invalide est effacée (retour au pré-vivier).
  if (role === 'manager') {
    const myKey = currentManagerRound(c.stages);
    if (myKey && Object.keys(planned).includes(myKey)) {
      if (!c.projet || projetDejaTraite(c, c.projet, myKey)) {
        const projetRefuse = c.projet;
        if (projetRefuse) await sql`UPDATE candidats SET projet = '' WHERE id = ${id}`;
        return err(
          projetRefuse
            ? `Enregistrement refusé : ce candidat a déjà effectué un entretien pour le projet « ${projetRefuse} ». Un candidat ne peut pas être affecté deux fois au même projet ; il retourne au Pré-vivier pour une nouvelle affectation.`
            : "Enregistrement refusé : ce candidat n'est plus affecté à un projet.",
          400
        );
      }
    }
  }

  // ----- Écriture (transaction sur une connexion réservée du pool) ------
  // postgres.js n'autorise un BEGIN que sur un client à connexion unique
  // (max: 1) ou sur une connexion réservée — le pool de production est à
  // max: 10, d'où `reserve()` / `release()` et begin/commit explicites.
  const reserved: any = await (sql as any).reserve();
  try {
    await reserved.unsafe('begin');
    if (newIdentity) {
      await reserved`UPDATE candidats SET nom = ${newIdentity.nom}, prenom = ${newIdentity.prenom},
        email = ${newIdentity.email} WHERE id = ${id}`;
    }
    if (info) {
      const s = sanitizeInfo(info);
      await reserved`UPDATE candidats SET sexe = ${s.sexe}, age = ${s.age}, niveau_etude = ${s.niveauEtude},
        domaine_etude = ${s.domaineEtude}, residence = ${s.residence}, departement = ${s.departement},
        ville = ${s.ville}, residence_lat = ${s.residenceLat}, residence_lng = ${s.residenceLng},
        experience_concurrents = ${s.experienceConcurrents}, langues = ${s.langues},
        informatique = ${s.informatique} WHERE id = ${id}`;
    }
    let projectCleared = false;
    for (const key of Object.keys(planned)) {
      const s = planned[key];
      const etape = key === 'rh' ? 'RH' : key.toUpperCase();
      // Le projet du tour est figé depuis le compte du manager (comme l'app).
      // Saisi « par procuration » par le RH, il reste vide — le candidat repasse
      // alors par le pré-vivier en cas de KO/MB. L'entretien RH porte éventuel-
      // lement l'affectation choisie par le recruteur (validée ci-dessus).
      const roundProjet = key === 'rh' ? s.projet : role === 'manager' ? c.projet : '';
      await reserved`INSERT INTO entretiens (candidat_id, etape, note, date_entretien, commentaire,
          decision, acteur_nom, projet)
        VALUES (${id}, ${etape}, ${s.note}, ${s.date}, ${s.commentaire}, ${s.decision},
          ${sessionName}, ${roundProjet})
        ON CONFLICT (candidat_id, etape) DO NOTHING`;
      if (key !== 'rh' && (s.decision === 'KO' || s.decision === 'MB')) projectCleared = true;
    }
    if (planned.rh && planned.rh.projet) {
      // Affectation directe depuis l'entretien RH (décision OK, contrôlée).
      await reserved`UPDATE candidats SET projet = ${planned.rh.projet} WHERE id = ${id}`;
    }
    if (projectCleared) {
      // KO/MB manager → retour au pré-vivier, affectation projet effacée
      // (la même personne ne peut plus être re-affectée sur ce projet).
      await reserved`UPDATE candidats SET projet = '' WHERE id = ${id}`;
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

  await audit(auth.username, wantedStages.length ? 'entretien.saisi' : 'candidat.maj', 'candidat', id, {
    stages: Object.keys(planned),
    identity: !!newIdentity,
    info: !!info,
  });

  // La moyenne est recalculée côté client (notes inchangées ici) — on
  // renvoie la fiche fraîche pour que l'UI se resynchronise.
  const fresh = (await fetchAllCandidates()).find((x) => x.id === id);

  // Garde-fou d'intégrité : si la correction (affectation vers un projet déjà
  // traité annulée au chargement) ne s'est pas encore reflétée en base, la
  // persister — cette fiche vient d'être modifiée.
  if (fresh && !fresh.projet) {
    const dbRow = await sql`SELECT projet FROM candidats WHERE id = ${id}`;
    if (dbRow[0] && dbRow[0].projet) {
      await sql`UPDATE candidats SET projet = '' WHERE id = ${id}`;
    }
  }

  // ----- Emails automatiques (étape 5) — APRÈS commit, ne bloquent jamais -
  // Déclencheurs (doc 01 §3.4) : passage à SELECTED (1er OK manager) et
  // entrée en pré-vivier (RH OK). Un seul envoi par TRANSITION — l'entretien
  // étant verrouillé une fois saisi, ces transitions sont irréversibles.
  if (fresh && fresh.statut !== c.statut) {
    if (fresh.statut === 'SELECTED') {
      await triggerEmail({ code: 'SELECTED', candidat: fresh, projet: fresh.projet });
    } else if (fresh.statut === 'PREVIVER') {
      await triggerEmail({ code: 'PREVIVER', candidat: fresh });
    }
  }

  return json({
    ok: true,
    candidat: fresh,
    // L'entretien RH est enregistré ; l'affectation demandée n'a pas pu
    // l'être (contrôles v16) — le front affiche ce message (v16 : alert).
    ...(affectationErreur ? { affectationErreur } : {}),
  });
});

function emailErr(email: string, c: Record<string, any>): boolean {
  if (!email) return false;
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
