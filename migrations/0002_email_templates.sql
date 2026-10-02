-- 0002 — Templates email : formulation par défaut de AFFECTATION_PROJET
-- ---------------------------------------------------------------------
-- Aucun changement de schéma (les tables sont créées dans 0001).
-- Le template seedé mentionnait « (date : {{date}}) » — or à l'affectation,
-- la date de l'entretien n'est PAS encore connue (c'est le manager qui la
-- planifiera). Formulation corrigée + utilisation de {{etape}}.
-- Le contenu reste 100 % modifiable par l'admin (Paramètres > Email).

UPDATE templates_email
SET corps = E'Bonjour {{prenom}} {{candidat}},\n\nVous avez été affecté au projet {{projet}}. Votre entretien ({{etape}}) est en cours de planification.\n\nCordialement,\nConcentrix Bénin — Recrutement'
WHERE code = 'AFFECTATION_PROJET';
