-- =====================================================================
-- 0003 — Notifications v16 :
--   1. Templates EMAILS PAR DÉCISION (remplacent les déclenchements
--      SELECTED / PREVIVER / AFFECTATION_PROJET — politique validée :
--      un email par décision, jamais pour MB).
--   2. Table de configuration WHATSAPP (Cloud API Meta) — jeton chiffré
--      (AES-256-GCM, même clé que la clé email) : jamais en clair.
--   3. Journal des envois WHATSAPP (traçabilité RGPD, anonymisé à la purge).
-- =====================================================================

-- 1. Templates d'emails par décision (textes par défaut de la v16,
--    personnalisables dans Paramètres > Email).
--    Variables disponibles : {{prenom}}, {{candidat}} (nom),
--    {{nom_complet}}, {{etape}} (libellé de l'étape), {{date}} (date de
--    l'entretien, format français).
DELETE FROM templates_email
 WHERE code IN ('SELECTED', 'PREVIVER', 'AFFECTATION_PROJET');

INSERT INTO templates_email (code, libelle, objet, corps) VALUES
(
  'RH_OK', 'Entretien RH concluant (OK)',
  'Bonne nouvelle suite à votre entretien RH',
  E'Bonjour {{nom_complet}},\n\nNous avons le plaisir de vous informer que votre entretien RH du {{date}} est concluant.\nVous serez prochainement invité(e) à un entretien avec un manager.\n\nCordialement.'
),
(
  'RH_KO', 'Entretien RH non concluant (KO)',
  'Suite donnée à votre candidature',
  E'Bonjour {{nom_complet}},\n\nNous vous remercions pour le temps consacré à votre entretien RH du {{date}}. Après étude de votre candidature, nous ne sommes pas en mesure d''y donner une suite favorable.\n\nNous vous souhaitons pleine réussite dans vos recherches.\n\nCordialement.'
),
(
  'M1_KO', '1er entretien Manager non concluant (KO) — invitation au tour suivant',
  'Suite à votre premier entretien Manager',
  E'Bonjour {{nom_complet}},\n\nNous vous remercions pour cet entretien. Cette étape n''est malheureusement pas concluante, mais rassurez-vous : vous recevrez prochainement un nouvel e-mail vous invitant à un autre entretien.\n\nCordialement.'
),
(
  'M2_KO', '2e entretien Manager non concluant (KO) — invitation au dernier tour',
  'Suite à votre deuxième entretien Manager',
  E'Bonjour {{nom_complet}},\n\nNous vous remercions pour cet entretien. Cette étape n''est malheureusement pas concluante, mais rassurez-vous : vous recevrez prochainement un nouvel e-mail vous invitant à un dernier entretien.\n\nCordialement.'
),
(
  'M3_KO', '3e entretien Manager non concluant (KO) — fin du processus',
  'Suite donnée à votre candidature',
  E'Bonjour {{nom_complet}},\n\nNous vous remercions pour votre participation à l''ensemble du processus de recrutement. Après étude, nous ne sommes pas en mesure de donner une suite favorable à votre candidature.\n\nNous vous souhaitons pleine réussite dans vos recherches.\n\nCordialement.'
),
(
  'M_OK', 'Entretien Manager concluant (OK)',
  'Félicitations suite à votre entretien Manager',
  E'Bonjour {{nom_complet}},\n\nNous avons le plaisir de vous informer que votre {{etape}} est concluant.\n\nCordialement.'
),
(
  'ACTIVATION', 'Activation de compte (accès interne — lien de définition du mot de passe)',
  'Activation de votre accès',
  E'Bonjour {{nom_complet}},\n\nUn accès a été créé pour vous sur l''application de suivi des candidatures. Pour définir votre mot de passe, cliquez sur le lien ci-dessous (valable 7 jours) :\n\n{{lien}}\n\nSi vous n''êtes pas à l''origine de cette demande, vous pouvez ignorer cet e-mail.\n\nCordialement.\nConcentrix Bénin — Recrutement'
)
ON CONFLICT (code) DO UPDATE
  SET libelle = EXCLUDED.libelle,
      objet = EXCLUDED.objet,
      corps = EXCLUDED.corps,
      mis_a_jour_le = now();

-- 2. Configuration WhatsApp (Cloud API Meta) — idempotent.
CREATE TABLE IF NOT EXISTS parametres_whatsapp (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  phone_number_id   TEXT NOT NULL DEFAULT '',
  access_token_enc  TEXT,
  template_name     TEXT NOT NULL DEFAULT '',
  template_lang     TEXT NOT NULL DEFAULT 'fr',
  actif             BOOLEAN NOT NULL DEFAULT FALSE,
  mis_a_jour_le     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO parametres_whatsapp (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- 3. Journal des envois WhatsApp (traçabilité ; anonymisé à la purge RGPD).
CREATE TABLE IF NOT EXISTS envois_whatsapp (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidat_id  TEXT REFERENCES candidats(id) ON DELETE SET NULL,
  destinataire TEXT NOT NULL,
  mode         TEXT CHECK (mode IN ('texte', 'modele')),
  statut       TEXT NOT NULL CHECK (statut IN ('envoye', 'echec', 'ignore')),
  detail       TEXT,
  envoye_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_envois_whatsapp_candidat ON envois_whatsapp (candidat_id);
CREATE INDEX IF NOT EXISTS idx_envois_whatsapp_date     ON envois_whatsapp (envoye_le);
