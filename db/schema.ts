import {
  pgTable,
  text,
  integer,
  numeric,
  doublePrecision,
  timestamp,
  date,
  uuid,
  bigint,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Schéma Drizzle — miroir TypeScript du SQL canonique (migrations/0001_init.sql).
 * Le SQL fait foi pour la structure de la base ; ce fichier fournit le
 * typage côté TypeScript pour les requêtes des fonctions Vercel
 * (drizzle-orm + client postgres.js).
 */

export const candidats = pgTable('candidats', {
  id: text('id').primaryKey(),
  nom: text('nom').notNull(),
  prenom: text('prenom').notNull(),
  email: text('email').notNull(),
  contact: text('contact').notNull().default(''),
  sexe: text('sexe').notNull().default(''),
  age: integer('age'),
  niveauEtude: text('niveau_etude').notNull().default(''),
  domaineEtude: text('domaine_etude').notNull().default(''),
  residence: text('residence').notNull().default(''),
  departement: text('departement').notNull().default(''),
  ville: text('ville').notNull().default(''),
  residenceLat: doublePrecision('residence_lat'),
  residenceLng: doublePrecision('residence_lng'),
  experienceConcurrents: text('experience_concurrents').notNull().default(''),
  projet: text('projet').notNull().default(''),
  langues: text('langues').array().notNull().default(sql`'{}'`),
  informatique: text('informatique').array().notNull().default(sql`'{}'`),
  shlNote1: numeric('shl_note_1', { precision: 4, scale: 1 }).notNull().default('0'),
  shlNote2: numeric('shl_note_2', { precision: 4, scale: 1 }).notNull().default('0'),
  shlNote3: numeric('shl_note_3', { precision: 4, scale: 1 }).notNull().default('0'),
  moyenneShl: numeric('moyenne_shl', { precision: 4, scale: 1 }).notNull(),
  creeLe: timestamp('cree_le', { withTimezone: true }).notNull().defaultNow(),
  misAJourLe: timestamp('mis_a_jour_le', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_candidats_email').on(sql`lower(${t.email})`),
  index('idx_candidats_projet').on(t.projet),
  index('idx_candidats_moyenne').on(t.moyenneShl),
]);

export const entretiens = pgTable('entretiens', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  candidatId: text('candidat_id')
    .notNull()
    .references(() => candidats.id, { onDelete: 'cascade' }),
  etape: text('etape').notNull(),
  decision: text('decision'),
  commentaire: text('commentaire').notNull().default(''),
  dateEntretien: date('date_entretien'),
  acteurNom: text('acteur_nom').notNull().default(''),
  projet: text('projet').notNull().default(''),
  note: text('note').notNull().default(''),
  creeLe: timestamp('cree_le', { withTimezone: true }).notNull().defaultNow(),
  misAJourLe: timestamp('mis_a_jour_le', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_entretiens_candidat_etape').on(t.candidatId, t.etape),
  index('idx_entretiens_acteur_projet').on(t.acteurNom, t.projet),
  index('idx_entretiens_date').on(t.dateEntretien),
]);

export const comptes = pgTable('comptes', {
  username: text('username').primaryKey(),
  role: text('role').notNull(),
  nom: text('nom').notNull(),
  prenom: text('prenom').notNull(),
  email: text('email').notNull(),
  projet: text('projet'),
  passwordHash: text('password_hash'),
  activationToken: uuid('activation_token'),
  activationTokenCreeLe: timestamp('activation_token_cree_le', { withTimezone: true }),
  totpSecret: text('totp_secret'),
  totpActiveeLe: timestamp('totp_activee_le', { withTimezone: true }),
  refreshTokenHash: text('refresh_token_hash'),
  refreshTokenExp: timestamp('refresh_token_exp', { withTimezone: true }),
  lastLoginLe: timestamp('last_login_le', { withTimezone: true }),
  creeLe: timestamp('cree_le', { withTimezone: true }).notNull().defaultNow(),
  misAJourLe: timestamp('mis_a_jour_le', { withTimezone: true }).notNull().defaultNow(),
  desactiveLe: timestamp('desactive_le', { withTimezone: true }),
}, (t) => [
  index('idx_comptes_projet').on(t.projet),
]);

export const parametresEmail = pgTable('parametres_email', {
  id: integer('id').primaryKey().default(1),
  fournisseur: text('fournisseur').notNull().default('resend'),
  apiKey: text('api_key'),
  senderEmail: text('sender_email'),
  senderName: text('sender_name').notNull().default(''),
  actif: boolean('actif').notNull().default(false),
  misAJourPar: text('mis_a_jour_par'),
  misAJourLe: timestamp('mis_a_jour_le', { withTimezone: true }).notNull().defaultNow(),
});

export const templatesEmail = pgTable('templates_email', {
  code: text('code').primaryKey(),
  libelle: text('libelle').notNull(),
  objet: text('objet').notNull().default(''),
  corps: text('corps').notNull().default(''),
  actif: boolean('actif').notNull().default(true),
  misAJourLe: timestamp('mis_a_jour_le', { withTimezone: true }).notNull().defaultNow(),
});

export const envoisEmail = pgTable('envois_email', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  candidatId: text('candidat_id').references(() => candidats.id, { onDelete: 'set null' }),
  code: text('code').notNull(),
  destinataire: text('destinataire').notNull(),
  fournisseur: text('fournisseur'),
  statut: text('statut').notNull(),
  detail: text('detail'),
  envoyeLe: timestamp('envoye_le', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_envois_candidat').on(t.candidatId),
  index('idx_envois_date').on(t.envoyeLe),
]);

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  username: text('username'),
  action: text('action').notNull(),
  cibleType: text('cible_type'),
  cibleId: text('cible_id'),
  detail: jsonb('detail').notNull().default({}),
  creeLe: timestamp('cree_le', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_audit_username_date').on(t.username, t.creeLe),
]);

// ---- Types inférés pour l'API ----
export type Candidat = typeof candidats.$inferSelect;
export type NouveauCandidat = typeof candidats.$inferInsert;
export type Entretien = typeof entretiens.$inferSelect;
export type NouvelEntretien = typeof entretiens.$inferInsert;
export type Compte = typeof comptes.$inferSelect;
export type NouveauCompte = typeof comptes.$inferInsert;
export type ParametresEmail = typeof parametresEmail.$inferSelect;
export type TemplateEmail = typeof templatesEmail.$inferSelect;
export type EnvoiEmail = typeof envoisEmail.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
