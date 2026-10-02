/**
 * Politique de mot de passe — IDENTIQUE à celle de l'application actuelle
 * (appliquée côté serveur, qui fait foi).
 */
export function passwordIssues(pw: string): string[] {
  pw = pw || '';
  const issues: string[] = [];
  if (pw.length < 10) issues.push('au moins 10 caractères');
  if (!/[A-Z]/.test(pw)) issues.push('une lettre majuscule');
  if (!/[a-z]/.test(pw)) issues.push('une lettre minuscule');
  if (!/[0-9]/.test(pw)) issues.push('un chiffre');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('un caractère spécial (ex : ! ? @ # % -)');
  return issues;
}
