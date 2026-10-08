/**
 * Point d'entrée des tests d'intégration : réexporte tous les handlers
 * (testés en les appelant directement avec des objets Request/Response,
 * comme le ferait Vercel) + les helpers TOTP (pour générer les codes).
 * Sert aussi de manifeste pour le serveur de dev local (scripts/dev-server.mjs).
 */
export { default as health } from '../api/health';
export { default as login } from '../api/auth/login';
export { default as twofa } from '../api/auth/twofa';
export { default as refresh } from '../api/auth/refresh';
export { default as logout } from '../api/auth/logout';
export { default as me } from '../api/auth/me';
export { default as activate } from '../api/auth/activate';
export { default as activation } from '../api/auth/activation';
export { default as password } from '../api/auth/password';
export { default as twofaStatus } from '../api/auth/twofa-status';
export { default as twofaRegenerate } from '../api/auth/twofa-regenerate';
export { default as twofaConfirm } from '../api/auth/twofa-confirm';
export { default as comptesIndex } from '../api/comptes/index';
export { default as comptesUsername } from '../api/comptes/[username]';
export { default as comptesReset } from '../api/comptes/[username]/reset';
export { default as candidatsIndex } from '../api/candidats/index';
export { default as candidatsImport } from '../api/candidats/import';
export { default as candidatsId } from '../api/candidats/[id]';
export { default as previvierIndex } from '../api/previvier/index';
export { default as previvierAffecter } from '../api/previvier/[id]/affecter';
export { default as stats } from '../api/stats';
export { default as pv } from '../api/pv';
export { default as parametresEmail } from '../api/parametres/email/index';
export { default as parametresEmailTest } from '../api/parametres/email/test';
export { default as parametresEmailEnvois } from '../api/parametres/email/envois';
export { default as parametresWhatsapp } from '../api/parametres/whatsapp/index';
export { default as parametresWhatsappEnvois } from '../api/parametres/whatsapp/envois';
export { default as forgot } from '../api/auth/forgot';
export { default as geoSearch } from '../api/geo/search';
export { __setGeoFetchForTests, __resetGeoFetchForTests } from '../api/geo/search';
export { default as auditIndex } from '../api/audit/index';
export { default as candidatsPurge } from '../api/candidats/[id]/purger';
export { totpCodeAt, newTotpSecret } from '../src/api/totp';
export {
  triggerEmail,
  renderTriggerEmail,
  formatDateFr,
  sendActivationEmail,
  renderTemplate,
  encryptApiKey,
  decryptApiKey,
  __setEmailFetchForTests,
  __resetEmailFetchForTests,
} from '../src/api/email';
export {
  triggerWhatsApp,
  formatWhatsAppNumber,
  __setWhatsAppFetchForTests,
  __resetWhatsAppFetchForTests,
} from '../src/api/whatsapp';
export {
  SEUIL_SHL,
  NIVEAUX,
  PROJETS,
  DEPARTEMENTS,
  LANGUES,
  COMPETENCES_INFO,
  EXPERIENCES_CONCURRENTS,
} from '../src/lib/constants';
