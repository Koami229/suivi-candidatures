#!/usr/bin/env node
/**
 * Bootstrap du compte administrateur RH (production).
 *
 * RÉSOUT LE PROBLÈME DU « PREMIER ADMIN » SANS CODER AUCUN IDENTIFIANT :
 * les identifiants proviennent UNIQUEMENT des variables d'environnement.
 * Le mot de passe est haché (bcrypt, 12 tours) avant d'être écrit en base.
 *
 * Usage :
 *   DATABASE_URL="postgresql://…" \
 *   ADMIN_BOOTSTRAP_EMAIL="rh@concentrix.com" \
 *   ADMIN_BOOTSTRAP_PASSWORD="MotDePasse!Fort" \
 *   ADMIN_BOOTSTRAP_NOM="Doré" ADMIN_BOOTSTRAP_PRENOM="Awa" \
 *   npm run bootstrap:admin
 *
 * Ensuite :
 *   1. retirer ADMIN_BOOTSTRAP_* des variables d'environnement Vercel ;
 *   2. à la première connexion, la double authentification TOTP sera
 *      demandée à configurer (comportement identique à l'app actuelle).
 */
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

const REQUIS = [
  'DATABASE_URL',
  'ADMIN_BOOTSTRAP_EMAIL',
  'ADMIN_BOOTSTRAP_PASSWORD',
  'ADMIN_BOOTSTRAP_NOM',
  'ADMIN_BOOTSTRAP_PRENOM',
];
const manquantes = REQUIS.filter((n) => !process.env[n]);
if (manquantes.length) {
  console.error('✗ Variables d\'environnement manquantes :', manquantes.join(', '));
  process.exit(1);
}

// --- Validation : identifiant @concentrix.com (règle conservée de l'app) ---
const email = process.env.ADMIN_BOOTSTRAP_EMAIL.trim().toLowerCase();
if (!email.endsWith('@concentrix.com')) {
  console.error('✗ L\'identifiant admin doit être une adresse email se terminant par @concentrix.com.');
  process.exit(1);
}

// --- Validation : politique de mot de passe (identique à l'app actuelle) ---
const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD;
const problemes = [];
if (pw.length < 10) problemes.push('au moins 10 caractères');
if (!/[A-Z]/.test(pw)) problemes.push('une lettre majuscule');
if (!/[a-z]/.test(pw)) problemes.push('une lettre minuscule');
if (!/[0-9]/.test(pw)) problemes.push('un chiffre');
if (!/[^A-Za-z0-9]/.test(pw)) problemes.push('un caractère spécial (ex : ! ? @ # % -)');
if (problemes.length) {
  console.error('✗ Mot de passe insuffisant. Il doit contenir :', problemes.join(', '));
  process.exit(1);
}

const hash = await bcrypt.hash(pw, 12);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

try {
  const rows = await sql`
    INSERT INTO comptes (username, role, nom, prenom, email, password_hash)
    VALUES (${email}, 'rh', ${process.env.ADMIN_BOOTSTRAP_NOM.trim()}, ${process.env.ADMIN_BOOTSTRAP_PRENOM.trim()}, ${email}, ${hash})
    ON CONFLICT (username) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      nom = EXCLUDED.nom,
      prenom = EXCLUDED.prenom,
      activation_token = NULL,
      desactive_le = NULL,
      mis_a_jour_le = now()
    RETURNING username, role`;

  console.log(`✓ Compte administrateur prêt : ${rows[0].username} (rôle : ${rows[0].role}).`);
  console.log('→ Première connexion : la double authentification TOTP sera à configurer (clé générée, comme dans l\'app actuelle).');
  console.log('→ Retirez maintenant ADMIN_BOOTSTRAP_* des variables d\'environnement Vercel.');
} catch (err) {
  console.error('✗ Échec du bootstrap :', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await sql.end();
}
