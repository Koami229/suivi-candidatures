# Déploiement Vercel — guide pas à pas

Application : front statique (`public/`) + fonctions API TypeScript (`api/`).
Aucun framework : Vercel détecte les fonctions et sert le front en zéro config.

## 0. Prérequis

- Un compte Vercel (pro ou gratuit suffisent) relié à GitHub.
- Un compte GitHub (le projet y est pushé — voir README).
- **Révoquer la clé Geoapify d'origine** (divulguée dans l'ancien fichier HTML)
  et en créer une nouvelle sur [geoapify.com](https://geoapify.com).

## 1. Importer le projet dans Vercel

1. Vercel Dashboard → **Add New → Project** → importer le dépôt GitHub
   `suivi-candidatures`.
2. **Framework preset : Other** (rien de plus à configurer).
3. Ne pas toucher au Build/Output : le front est statique (`public/`), les
   fonctions sont auto-détectées dans `api/`.

## 2. Base de données

Vercel Dashboard → **Storage → Vercel Postgres** → **Create Database**
(nom : `suivi`, région de votre choix). La variable `DATABASE_URL` est
injectée **automatiquement**, pour chaque environnement (Preview / Production).

## 3. Variables d'environnement

Vercel Dashboard → Project → **Settings → Environment Variables**.
À définir pour **Production** (et Preview si vous voulez tester sur les
preview deployments) :

| Variable | Valeur | Quand |
|---|---|---|
| `DATABASE_URL` | (automatique via Vercel Postgres) | toujours |
| `JWT_SECRET` | `openssl rand -base64 48` | toujours |
| `EMAIL_API_KEY_ENC` | `openssl rand -hex 32` | toujours (dès qu'une clé email sera enregistrée) |
| `APP_URL` | `https://<votre-domaine>.vercel.app` | toujours |
| `GEOAPIFY_API_KEY` | **votre nouvelle** clé | si l'autocomplétion d'adresse est utilisée |
| `ADMIN_BOOTSTRAP_EMAIL` / `_PASSWORD` / `_NOM` / `_PRENOM` | identifiants du 1er admin | **une seule fois** (étape 4), puis **à retirer** |

Le mot de passe admin doit respecter la politique : 10 caractères minimum,
majuscule, minuscule, chiffre, caractère spécial.

## 4. Initialiser la base (une seule fois)

Les migrations ne s'appliquent pas « magiquement » sur Vercel — elles sont
appliquées une fois, manuellement, sur la base **production** (les preview
deployments partagent la même base si `DATABASE_URL` y pointe dessus ;
sinon répétez l'opération sur chaque base) :

```bash
# Depuis la racine du projet, avec le Vercel CLI (installé : npm i -g vercel)
npx vercel env pull .env --environment=production
npm run db:setup          # applique migrations/0001 + 0002 (idempotent)
npm run bootstrap:admin   # crée le compte RH (identifiants via env)
```

Vérifier en ouvrant l'app : connexion admin → configuration de la 2FA (TOTP).

**Ensuite : RETIRER les variables `ADMIN_BOOTSTRAP_*` de Vercel**
(Production + Preview). Elles ne servent qu'à cette première initialisation.

## 5. Déployer

Push sur `main` → Vercel déploie automatiquement. Premier chargement de la
page : l'admin est prêt.

> Astuce : `vercel --prod` en local (avec `vercel env pull`) permet de tester
> la compilation des fonctions avant le push.

## 6. Sauvegardes (rappel)

- **Principal** : Vercel Postgres gère la rétention des sauvegardes et le PITR
  (Point-In-Time Recovery) — rien à faire.
- **Complément** : export manuel JSON via le CLI
  (`npx vercel env pull .env --environment=production && npm run db:export`),
  fichier à stocker hors du dépôt (`backups/` est gitignorée). Restaurer :
  `npm run db:restore -- backups/<fichier>.json` sur la cible.
- Voir `docs/02-durcissement-et-rbgd.md` §5 pour les détails.

## 7. Checklist post-déploiement

- [ ] `GET /api/health` renvoie `{"ok":true,"db":"up"}`
- [ ] Connexion admin → 2FA configurée → tableau de bord
- [ ] Variables `ADMIN_BOOTSTRAP_*` **retirées** de Vercel
- [ ] Nouvelle clé Geoapify en place (ancienne révoquée)
- [ ] `EMAIL_API_KEY_ENC` définie avant la 1re saisie d'une clé email
- [ ] Paramètres > Email : fournisseur + clé + expéditeur + test envoyé
- [ ] Un export de sauvegarde (`db:export`) réalisé et stocké en lieu sûr

## Dépannage

| Symptôme | Cause probable |
|---|---|
| 500 `DATABASE_URL` | Variable absente dans cet environnement (Production/Preview) |
| 500 `relation … does not exist` | `npm run db:setup` non exécuté sur cette base |
| 401 partout après déploiement | `JWT_SECRET` changé (les sessions existantes sont invalidées — normal, se reconnecter) |
| Emails non envoyés | Fournisseur/clé non configurés dans Paramètres > Email, ou `EMAIL_API_KEY_ENC` manquante |
| Geoapify 503 | `GEOAPIFY_API_KEY` absente ou quota atteint |
