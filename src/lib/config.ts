/**
 * Accès typé aux variables d'environnement.
 *
 * Principe directeur de la migration : AUCUNE valeur sensible (identifiants,
 * mots de passe, clés API, secrets JWT…) n'est codée en dur dans le code source.
 * Tout passe par :
 *  - les variables d'environnement Vercel (DATABASE_URL, JWT_SECRET,
 *    GEOAPIFY_API_KEY, EMAIL_API_KEY_ENC, APP_URL), ou
 *  - la base de données (paramètres email saisis par l'admin, chiffrés).
 */

/** Renvoie la valeur de la variable ou lève une erreur explicite (fail fast). */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return v;
}

/** Renvoie la valeur de la variable ou undefined (variables optionnelles). */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
