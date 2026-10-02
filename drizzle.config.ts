import { defineConfig } from 'drizzle-kit';

/**
 * Configuration Drizzle Kit.
 * - `db:generate` : génère les migrations SQL futures (0002_*, 0003_*, …) depuis db/schema.ts
 * - `db:migrate`  : applique les migrations générées (nécessite DATABASE_URL)
 * La migration initiale 0001_init.sql est écrite à la main et fait foi (voir migrations/).
 */
export default defineConfig({
  schema: './db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // La vraie valeur vient de l'environnement (Vercel injecte DATABASE_URL automatiquement).
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/suivi_candidatures',
  },
  verbose: true,
  strict: true,
});
