import postgres, { type Sql } from 'postgres';

/**
 * Client Postgres unique pour toutes les fonctions Vercel (postgres.js).
 *
 * - DATABASE_URL est injectée par Vercel (Vercel Postgres / Neon) — jamais
 *   codée en dur. En local, elle provient du fichier .env (chargé par Vercel CLI
 *   ou par `dotenv` selon l'outillage ; le script bootstrap lit process.env).
 * - `null` si DATABASE_URL est absente : les fonctions renvoient alors une
 *   erreur explicite au lieu d'échouer mystérieusement.
 * - La pooler de Neon/Vercel Postgres gère la concurrence côté serveur ;
 *   max: 10 garde un budget de connexions raisonnable en serverless.
 */
const url = process.env.DATABASE_URL;
const client = url
  ? postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    })
  : null;

/**
 * Client à utiliser dans les fonctions API. Type non-nul ; si DATABASE_URL
 * est absente, toute utilisation lève une erreur explicite (rapportée en
 * 500 par l'enveloppe `run()` des handlers).
 */
export const sql = new Proxy(client as Sql<any>, {
  get(target, prop, receiver) {
    if (!client) throw new Error("DATABASE_URL n'est pas configurée (variable d'environnement Vercel).");
    return Reflect.get(target, prop, receiver);
  },
  apply(target, thisArg, argArray) {
    if (!client) throw new Error("DATABASE_URL n'est pas configurée (variable d'environnement Vercel).");
    return Reflect.apply(target, thisArg, argArray);
  },
}) as Sql<any>;

export function isDbConfigured(): boolean {
  return client !== null;
}
