/**
 * Constantes métier — reprises À L'IDENTIQUE de l'application existante.
 * Centralisées ici (et non dispersées) : elles seront le socle des
 * validations API. Ce sont des données métier publiques (catalogues),
 * pas des secrets.
 */

/** Seuil d'affichage : moyenne SHL ≥ 80 (sous le seuil : enregistré mais masqué). */
export const SEUIL_SHL = 80;

/** Niveaux d'étude (5). */
export const NIVEAUX = ['BEPC', 'BAC', 'LICENCE', 'MASTER', 'THESE'] as const;

/** Projets (18). */
export const PROJETS = [
  'Samsung',
  'Amazon',
  'Emma',
  'Lydia',
  'Carrefour',
  'Colis Privé',
  'Devialet',
  'Bouygues Telecom',
  'La Poste courrier',
  'La Poste colissimo',
  'Comutitres',
  'Effy',
  'Catalina',
  'Tiime',
  'My Afro',
  'Orange',
  'BUT',
  'HTG',
] as const;

/** 12 départements du Bénin. */
export const DEPARTEMENTS = [
  'Alibori',
  'Atacora',
  'Atlantique',
  'Borgou',
  'Collines',
  'Couffo',
  'Donga',
  'Littoral',
  'Mono',
  'Ouémé',
  'Plateau',
  'Zou',
] as const;

/** Décisions d'entretien. NULL (absence) = « à faire ». */
export const DECISIONS = ['OK', 'KO', 'MB'] as const;

/** Étapes du pipeline : Entretien RH puis jusqu'à 3 tours Manager. */
export const ETAPES = ['RH', 'M1', 'M2', 'M3'] as const;

/** Rôles applicatifs. */
export const ROLES = ['rh', 'recruteur', 'manager'] as const;

/** Compétences linguistiques. */
export const LANGUES = ['Anglais', 'Espagnol', 'Arabe', 'Chinois', 'Allemand', 'Russe', 'Portugais'] as const;

/** Compétences informatiques. */
export const COMPETENCES_INFO = ['Pack Office', 'Excel avancé', 'Outil CRM', 'ERP'] as const;

/** Expériences en relation client chez d'autres concurrents (18). */
export const EXPERIENCES_CONCURRENTS = [
  'VIPP Interstis',
  'AdKontact Bénin',
  'CallConnect Bénin',
  'SIONTEL',
  'Palladium Africa',
  'CRM Consulting',
  'Groupe Ageka Bénin',
  "Digit's Solutions",
  'Groupe Media Contact',
  'Glow Contact Center Benin',
  'Africa Call Center',
  'Call Center Services Bénin',
  'Bénin Call Center',
  'Global Contact Center',
  'E-Call Bénin',
  'Africa Contact Center',
  'Outsourcing Bénin',
  'Contact Center Solutions Bénin',
] as const;

/** Fournisseurs d'email supportés (choix dans Paramètres > Email — aucun n'est privilégié dans le code). */
export const EMAIL_PROVIDERS = ['resend', 'brevo', 'sendgrid'] as const;

/** Codes de déclenchement d'email (templates seedés en base). */
export const EMAIL_TRIGGER_CODES = ['SELECTED', 'PREVIVER', 'AFFECTATION_PROJET'] as const;

/**
 * Statuts calculés (jamais stockés) — mêmes libellés que l'app actuelle.
 * La logique de calcul est portée par la fonction SQL `candidat_statut()`.
 */
export const STATUTS = ['EN_ATTENTE', 'PREVIVER', 'SELECTED', 'REJET'] as const;
