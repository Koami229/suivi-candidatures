-- =====================================================================
-- Suivi des candidatures — Concentrix Bénin
-- Migration 0001 : schéma initial
-- Cible : Postgres 15+ (Vercel Postgres / Neon)
-- Application : psql "$DATABASE_URL" -f migrations/0001_init.sql
--               (ou Vercel Dashboard → Storage → SQL)
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. CANDIDATS
--    Miroir de l'objet `candidates` de l'app JS, en colonnes normalisées.
--    - moyenne_shl : recalculée par l'API à chaque écriture
--      (même formule que JS : round((n1+n2+n3)/3, 1)).
--    - projet = '' : non affecté (pré-vivier / en attente d'affectation).
--    - email unique (insensible à la casse) : renforce le dédoublonnage
--      de l'import, qui reste géré côté API.
-- ---------------------------------------------------------------------
CREATE TABLE candidats (
  id                     TEXT PRIMARY KEY,          -- généré côté API : 'c_' + 8 caractères aléatoires
  nom                    TEXT NOT NULL,
  prenom                 TEXT NOT NULL,
  email                  TEXT NOT NULL,
  contact                TEXT NOT NULL DEFAULT '',
  sexe                   TEXT NOT NULL DEFAULT '' CHECK (sexe IN ('', 'Homme', 'Femme')),
  age                    INTEGER CHECK (age IS NULL OR (age >= 18 AND age <= 99)),
  niveau_etude           TEXT NOT NULL DEFAULT '' CHECK (niveau_etude = '' OR niveau_etude IN ('BEPC','BAC','LICENCE','MASTER','THESE')),
  domaine_etude          TEXT NOT NULL DEFAULT '',
  residence              TEXT NOT NULL DEFAULT '',
  departement            TEXT NOT NULL DEFAULT '',  -- un des 12 départements du Bénin
  ville                  TEXT NOT NULL DEFAULT '',
  residence_lat          DOUBLE PRECISION,
  residence_lng          DOUBLE PRECISION,
  experience_concurrents TEXT NOT NULL DEFAULT '',
  projet                 TEXT NOT NULL DEFAULT '',
  langues                TEXT[] NOT NULL DEFAULT '{}',
  informatique           TEXT[] NOT NULL DEFAULT '{}',
  shl_note_1             NUMERIC(4,1) NOT NULL DEFAULT 0,
  shl_note_2             NUMERIC(4,1) NOT NULL DEFAULT 0,
  shl_note_3             NUMERIC(4,1) NOT NULL DEFAULT 0,
  moyenne_shl            NUMERIC(4,1) NOT NULL,
  cree_le                TIMESTAMPTZ NOT NULL DEFAULT now(),
  mis_a_jour_le          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Email unique, insensible à la casse (une contrainte UNIQUE de table ne
-- peut porter que sur des colonnes : expression → index unique).
CREATE UNIQUE INDEX uq_candidats_email ON candidats (lower(email));
CREATE INDEX idx_candidats_projet  ON candidats (projet);
CREATE INDEX idx_candidats_moyenne ON candidats (moyenne_shl);

-- ---------------------------------------------------------------------
-- 2. ENTRETIENS (pipeline + historique)
--    Une ligne par (candidat, étape) — reflète c.stages[key] en JS.
--    - decision NULL = « à faire » (a_faire en JS)
--    - Verrou « entretien enregistré = définitif » : appliqué dans l'API
--      (étape 5) — tout UPDATE/DELETE d'une ligne avec decision non NULL
--      est rejeté, y compris pour le rôle RH.
--    - acteur_nom : recruteur (RH) ou manager (Mx), figé à l'enregistrement.
--    - projet : projet du tour (Mx) ; vide pour RH.
-- ---------------------------------------------------------------------
CREATE TABLE entretiens (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidat_id      TEXT NOT NULL REFERENCES candidats(id) ON DELETE CASCADE,
  etape            TEXT NOT NULL CHECK (etape IN ('RH','M1','M2','M3')),
  decision         TEXT CHECK (decision IS NULL OR decision IN ('OK','KO','MB')),
  commentaire      TEXT NOT NULL DEFAULT '',
  date_entretien   DATE,
  acteur_nom       TEXT NOT NULL DEFAULT '',
  projet           TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  cree_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
  mis_a_jour_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_entretiens_candidat_etape UNIQUE (candidat_id, etape)
);
CREATE INDEX idx_entretiens_acteur_projet ON entretiens (acteur_nom, projet);
CREATE INDEX idx_entretiens_date          ON entretiens (date_entretien);

-- ---------------------------------------------------------------------
-- 3. COMPTES
--    - username = identifiant = email @concentrix.com
--    - password_hash NULL = compte créé mais pas encore activé
--      (lien d'activation en attente), comme pass:null en JS.
--    - totp_secret : clé TOTP (base32) ; NULL = 2FA non configurée
--      (elle sera demandée à la première connexion, comme aujourd'hui).
--    - refresh_token_hash / refresh_token_exp : JWT refresh (étape 3).
--    - desactive_le : suppression « douce » par l'admin (l'app actuelle
--      supprime définitivement — à confirmer, cf. doc d'arbitrages).
-- ---------------------------------------------------------------------
CREATE TABLE comptes (
  username                 TEXT PRIMARY KEY,
  role                     TEXT NOT NULL CHECK (role IN ('rh','recruteur','manager')),
  nom                      TEXT NOT NULL,
  prenom                   TEXT NOT NULL,
  email                    TEXT NOT NULL,
  projet                   TEXT,
  password_hash            TEXT,
  activation_token         UUID,
  activation_token_cree_le TIMESTAMPTZ,
  totp_secret              TEXT,
  totp_activee_le          TIMESTAMPTZ,
  refresh_token_hash       TEXT,
  refresh_token_exp        TIMESTAMPTZ,
  last_login_le            TIMESTAMPTZ,
  cree_le                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  mis_a_jour_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
  desactive_le             TIMESTAMPTZ,
  CONSTRAINT chk_comptes_manager_projet CHECK (role <> 'manager' OR projet IS NOT NULL)
);
CREATE INDEX idx_comptes_projet ON comptes (projet) WHERE role = 'manager';

-- ---------------------------------------------------------------------
-- 4. PARAMÈTRES EMAIL (admin RH) — une seule ligne (id = 1)
--    Le fournisseur et la clé API sont des DONNÉES de base de données,
--    jamais codés en dur dans le code. api_key est chiffrée en base
--    (AES-256-GCM, clé de chiffrement en variable d'env EMAIL_API_KEY_ENC).
-- ---------------------------------------------------------------------
CREATE TABLE parametres_email (
  id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fournisseur    TEXT NOT NULL DEFAULT 'resend' CHECK (fournisseur IN ('resend','brevo','sendgrid')),
  api_key        TEXT,                       -- chiffrée ; NULL = non configurée
  sender_email   TEXT,
  sender_name    TEXT NOT NULL DEFAULT '',
  actif          BOOLEAN NOT NULL DEFAULT FALSE,
  mis_a_jour_par TEXT,
  mis_a_jour_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Templates d'emails : le contenu vient de ces lignes, personnalisables
-- par l'admin. Placeholders supportés (étape 7) :
--   {{prenom}} {{candidat}} {{projet}} {{etape}} {{date}} {{score}}
CREATE TABLE templates_email (
  code          TEXT PRIMARY KEY,
  libelle       TEXT NOT NULL,
  objet         TEXT NOT NULL DEFAULT '',
  corps         TEXT NOT NULL DEFAULT '',
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  mis_a_jour_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO parametres_email (id, fournisseur, sender_email, sender_name, actif)
VALUES (1, 'resend', '', '', FALSE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO templates_email (code, libelle, objet, corps) VALUES
(
  'SELECTED', 'Candidat retenu (SELECTED)',
  'Votre candidature — {{projet}}',
  E'Bonjour {{prenom}} {{candidat}},\n\nBonne nouvelle : votre candidature a été retenue pour le projet {{projet}}.\nL''équipe recrutement vous recontactera très prochainement pour organiser la suite.\n\nCordialement,\nConcentrix Bénin — Recrutement'
),
(
  'PREVIVER', 'Candidat en pré-vivier (après entretien RH)',
  'Votre candidature — prochaine étape',
  E'Bonjour {{prenom}} {{candidat}},\n\nVotre entretien avec l''équipe RH s''est bien passé : vous accédez à la prochaine étape du recrutement.\nNous revenons vers vous rapidement pour planifier votre entretien manager.\n\nCordialement,\nConcentrix Bénin — Recrutement'
),
(
  'AFFECTATION_PROJET', 'Affectation à un projet (entretien manager à venir)',
  'Votre candidature — entretien à venir sur {{projet}}',
  E'Bonjour {{prenom}} {{candidat}},\n\nVous avez été affecté au projet {{projet}}. Votre entretien manager est en cours de planification (date : {{date}}).\n\nCordialement,\nConcentrix Bénin — Recrutement'
)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. JOURNAL D'ENVOIS EMAIL
--    Traçabilité (qui/quand/pourquoi) + aide au dépannage + idempotence.
--    statut = 'ignore' : changement de statut détecté mais envoi sauté
--    (configuration inactive, email absent, template désactivé…).
-- ---------------------------------------------------------------------
CREATE TABLE envois_email (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidat_id  TEXT REFERENCES candidats(id) ON DELETE SET NULL,
  code         TEXT NOT NULL,
  destinataire TEXT NOT NULL,
  fournisseur  TEXT,
  statut       TEXT NOT NULL CHECK (statut IN ('envoye','echec','ignore')),
  detail       TEXT,
  envoye_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_envois_candidat ON envois_email (candidat_id);
CREATE INDEX idx_envois_date     ON envois_email (envoye_le);

-- ---------------------------------------------------------------------
-- 6. JOURNAL D'AUDIT
--    Qui a fait quoi (connexions, imports, décisions d'entretiens,
--    modifications de comptes et de paramètres). Alimenté par l'API.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username   TEXT,
  action     TEXT NOT NULL,
  cible_type TEXT,
  cible_id   TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  cree_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_username_date ON audit_log (username, cree_le DESC);

-- ---------------------------------------------------------------------
-- 7. STATUT — fonction SQL (JAMAIS stockée)
--    Reprise à l'identique de computeStatutCode() / estSortiDefinitivement()
--    de l'app JS :
--      1) un manager OK            → SELECTED
--      2) M1, M2 et M3 tous réalisés sans aucun OK → REJET (sortie définitive)
--      3) RH OK                     → PREVIVER
--      4) RH KO                     → REJET
--      5) sinon                     → EN_ATTENTE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION candidat_statut(cid TEXT)
RETURNS TEXT
LANGUAGE sql STABLE
AS $$
  WITH s AS (
    SELECT
      (SELECT e.decision FROM entretiens e WHERE e.candidat_id = cid AND e.etape = 'RH') AS rh,
      (SELECT e.decision FROM entretiens e WHERE e.candidat_id = cid AND e.etape = 'M1') AS m1,
      (SELECT e.decision FROM entretiens e WHERE e.candidat_id = cid AND e.etape = 'M2') AS m2,
      (SELECT e.decision FROM entretiens e WHERE e.candidat_id = cid AND e.etape = 'M3') AS m3
  )
  SELECT CASE
    WHEN s.m1 = 'OK' OR s.m2 = 'OK' OR s.m3 = 'OK' THEN 'SELECTED'
    WHEN s.m1 IS NOT NULL AND s.m2 IS NOT NULL AND s.m3 IS NOT NULL THEN 'REJET'
    WHEN s.rh = 'OK' THEN 'PREVIVER'
    WHEN s.rh = 'KO' THEN 'REJET'
    ELSE 'EN_ATTENTE'
  END
  FROM s;
$$;

-- Vue d'agrégation : statut calculé + visibilité (seuil SHL ≥ 80,
-- repris de passesThreshold() : sous le seuil, enregistré mais masqué).
CREATE OR REPLACE VIEW v_candidats AS
SELECT c.*,
       candidat_statut(c.id)  AS statut,
       (c.moyenne_shl >= 80)  AS visible
FROM candidats c;

COMMIT;
