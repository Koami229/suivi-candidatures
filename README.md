# Suivi des candidatures — Concentrix Bénin (production)

Migration **progressive** de l'application HTML unique (`Suivi_des_candidatures.html`)
vers **Vercel (front statique + Functions) + Postgres partagé**.
Règles métier conservées à l'identique — voir `docs/01-architecture-et-arbitrages.md`.

## Structure du projet

```
suivi-candidatures/
├── public/index.html        # L'application (UI d'origine conservée) — 100 % branchée sur l'API
├── api/
│   ├── health.ts            # GET /api/health — vérifie la connexion Postgres
│   ├── auth/…               # Connexion, 2FA TOTP, JWT (access + refresh), activation, mot de passe
│   ├── comptes/…            # Paramètres > Accès (RH) : création / édition / suppression douce
│   ├── candidats/           # GET/POST liste, GET/PUT/DELETE fiche, POST import, POST purge RGPD
│   ├── previvier/           # GET liste du pré-vivier, POST affectation projet
│   ├── parametres/email/…   # Paramètres > Email (RH) : config + templates, test, journal envois
│   ├── geo/search.ts        # Proxy Geoapify (clé en env, HTTPS forcé, zone Bénin)
│   ├── audit/               # GET journal d'audit « qui a fait quoi » (RH)
│   ├── stats.ts             # GET statistiques (filtres, par niveau/statut/ville, période)
│   └── pv.ts                # GET PV de synthèse (manager, son projet)
├── db/
│   ├── client.ts            # Client Postgres unique (postgres.js) — DATABASE_URL depuis l'env
│   └── schema.ts            # Schéma Drizzle (typage TS) — miroir du SQL canonique
├── migrations/
│   ├── 0001_init.sql        # Schéma SQL CANONIQUE (candidats, entretiens, comptes,
│   │                        #   paramètres email, envois, audit, fonction statut + vue)
│   └── 0002_email_templates.sql  # Formulation du template d'affectation (contenu)
├── src/
│   ├── api/                 # Logique partagée des fonctions (http, jwt, totp, password,
│   │   └── candidats.ts     #   sérialisation candidat, pipeline, import, stats, PV)
│   └── lib/
│       ├── config.ts        # Accès aux variables d'environnement (fail fast)
│       └── constants.ts     # Constantes métier reprises à l'identique (18 projets, seuil 80…)
├── scripts/
│   ├── bootstrap-admin.mjs  # Création du 1er compte admin (identifiants 100 % via env, bcrypt)
│   ├── migrate-front-step2.mjs / step3.mjs  # Migrations front (idempotentes, marqueurs vérifiés)
│   ├── backup-export.mjs    # db:export / db:restore — sauvegarde JSON + restauration
│   └── validate*.mjs        # Suites de validation sur Postgres réel embarqué (voir Scripts)
├── docs/
│   ├── 01-architecture-et-arbitrages.md   # Explication de tous les choix (par étape)
│   ├── 02-durcissement-et-rbgd.md         # Données, sécurité, droits RGPD, sauvegardes, incidents
│   └── 03-deploiement-vercel.md           # Guide de déploiement pas à pas (Vercel + Postgres)
├── package.json
├── tsconfig.json
├── drizzle.config.ts
└── .env.example
```

## Mise en service

1. **Créer le projet Vercel**
   - Git : pousser ce dépôt (GitHub/GitLab) → Vercel → *Add New Project* → importer le dépôt.
   - Framework Preset : **Other** (Vercel sert `public/` en statique et compile `api/` en Functions Node, sans build script).
2. **Créer la base**
   - Vercel Dashboard → projet → **Storage** → **Add Database** → *Vercel Postgres*.
   - `DATABASE_URL` est injectée automatiquement (production + préviews : chaque branche a sa propre base de préview).
   - Alternative : un projet **Neon** direct (même moteur) en collant sa propre `DATABASE_URL` dans Settings → Environment Variables.
3. **Variables d'environnement** (Settings → Environment Variables, production + previews) :
   - `JWT_SECRET` — générer : `openssl rand -base64 48`
   - `APP_URL` — URL publique du projet (liens d'activation)
4. **Appliquer le schéma**
   - `psql "$DATABASE_URL" -f migrations/0001_init.sql`
   - ou Vercel Dashboard → Storage → votre base → **SQL** (coller le contenu du fichier).
5. **Créer le compte administrateur** (aucun identifiant codé nulle part) :
   ```bash
   npm run bootstrap:admin
   ```
   (variables `DATABASE_URL`, `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`,
   `ADMIN_BOOTSTRAP_NOM`, `ADMIN_BOOTSTRAP_PRENOM` — ensuite **retirer** les variables
   `ADMIN_BOOTSTRAP_*` de Vercel.)
6. **Déployer et vérifier** :
   - `https://votre-projet.vercel.app/api/health` → `{"ok": true, "db": "up", …}`
   - `https://votre-projet.vercel.app/` → l'application (écran de connexion ; la 2FA
     sera à configurer à la première connexion de l'admin).

> HTTPS : forcé par défaut par Vercel (redirection http→https sur les domaines
> personnalisés, `*.vercel.app` toujours en HTTPS).

## Scripts

| Script | Rôle |
|---|---|
| `npm run db:generate` | Génère la prochaine migration SQL depuis `db/schema.ts` (après chaque évolution du schéma) |
| `npm run db:migrate` | Applique les migrations générées sur la base pointée par `DATABASE_URL` |
| `npm run db:pull` | Génère `db/schema.ts` depuis la base existante (si schéma modifié à la main) |
| `npm run bootstrap:admin` | Crée/réactive le compte admin (identifiants via env) |
| `npm run dev:local` | Serveur de **démo locale** : sert `public/` + les API sur un port unique ; sans `DATABASE_URL`, démarre un Postgres embarqué temporaire + migration + admin de démo via env |
| `npm run typecheck` | Vérification TypeScript |
| `npm run validate` | **Valide l'étape 1** sur un Postgres réel embarqué : migration, fonction `candidat_statut()`, contraintes, seeds, bootstrap admin (30 tests) + preuve d'équivalence JS↔SQL sur 256 combinaisons de décisions |
| `npm run validate:step2` | **Valide l'étape 2** sur un Postgres réel embarqué : bundle esbuild des fonctions (comme Vercel), puis 47 tests d'intégration des API auth/comptes (login, 2FA, JWT/refresh, activation, rôles, audit) |
| `npm run validate:step3` | **Valide les étapes 3+4** sur un Postgres réel embarqué : 86 tests — import CSV/Excel (dédoublonnage email, seuil SHL), listes filtrées par rôle, fiche + déblocages, entretien RH → PRÉ-VIVIER, verrouillage définitif (409 même pour le RH), pré-vivier + affectation (re-affectation projet interdite), KO/MB → retour pré-vivier + projet effacé, REJET après 3 tours, OK → SELECTED, périmètre manager, statistiques, PV de synthèse, suppression + droits |
| `npm run validate:step5` | **Valide l'étape 5** sur un Postgres réel embarqué : 47 tests — config email (clé chiffrée AES-256-GCM en base, jamais retournée, préservée si vide), templates personnalisés, déclencheurs (PRÉ-VIVIER, affectation, SELECTED) avec rendu des variables, bascule actif, adaptateurs Resend/Brevo/SendGrid (transport simulé, aucun appel réel), échec journalisé sans bloquer la décision, email de test, journal, audit, droits |
| `npm run validate:step6` | **Valide l'étape 6** sur Postgres réel embarqué : 30 tests — proxy Geoapify (auth, validation q, HTTPS forcé, filtre Bénin + français, normalisation, limites 1/6/8, clé en amont et jamais dans la réponse, 502/503 explicites, rôles) + audit front (aucune clé en dur, autocomplétion branchée sur le proxy) |
| `npm run db:export` | **Sauvegarde** : export JSON daté des 7 tables (ordre compatible FK, compteurs, version de schéma) dans `backups/` (hors dépôt) |
| `npm run db:restore -- <fichier>` | **Restauration** sur `DATABASE_URL` : migrations appliquées puis contenu de la cible remplacé par l'export (id des journaux conservés) |
| `npm run validate:step7` | **Valide l'étape 7** sur Postgres réel (dont un **deuxième Postgres** pour la restauration) : 50 tests — audit alimenté (échecs de connexion compris) et sans données personnelles des candidats, consultation + filtres + droits, purge RGPD (confirmation, 403/400/404, cascade, anonymisation du journal email, idempotence, audité), export/restore, audit du front (bouton purge RH, journal d'audit, mentions) |

## État de la migration

| Étape | Contenu | Statut |
|---|---|---|
| 1 | Structure Vercel + Postgres + schéma + health + bootstrap admin | ✅ |
| 2 | Auth serveur : bcrypt, JWT (access + refresh), 2FA TOTP vérifiée côté serveur, API comptes (Paramètres), suppression des comptes démo et de l'aide affichant les mots de passe — front branché sur l'API | ✅ |
| 3 | API candidats : CRUD + import Excel/CSV côté serveur (dédoublonnage email) ; vue « Candidats » branchée sur l'API | ✅ |
| 4 | API pipeline : entretiens RH/M1/M2/M3, verrous et statuts portés côté serveur ; pré-vivier + affectation | ✅ |
| 5 | Paramètres > Email (Resend / Brevo / SendGrid, clé chiffrée en base, templates) + envois automatiques sur changement de statut + journal | ✅ |
| 6 | Geoapify via proxy API (clé en env, HTTPS forcé) + autocomplétion adresse (PV de synthèse et Statistiques déjà livrés avec les étapes 3+4) | ✅ |
| 7 | Durcissement : journal d'audit alimenté + consultation (dont échecs de connexion), purge RGPD, sauvegardes export/restauration, mentions RGPD | ✅ |

**Principe de progression** : chaque étape est additive et l'application reste
fonctionnelle à chaque bascule (UI d'origine conservée, règles métier inchangées).
À l'issue des étapes 2 à 5, **plus aucun état ne vit dans le navigateur** :
comptes, session, candidats, entretiens, pré-vivier, statistiques, PV et
configuration/contenu des emails sont servis par l'API (Postgres). Les emails
automatiques (pré-vivier, affectation projet, SELECTED) partent du serveur via
le fournisseur choisi par l'admin, et l'autocomplétion d'adresse (résidence,
zone Bénin) passe par le proxy `/api/geo/search` (clé Geoapify en env, HTTPS
forcé) — plus aucune clé sensible dans le navigateur.

**La migration est terminée** (7/7). Le durcissement (étape 7) ajoute le
journal d'audit consultable, la purge RGPD, les sauvegardes export/restauration
et les mentions RGPD — voir `docs/02-durcissement-et-rbgd.md`.

## Déploiement Vercel

Guide complet pas à pas : **`docs/03-deploiement-vercel.md`**. En résumé :

1. **Importer** le dépôt GitHub dans Vercel (Framework preset : *Other*).
2. **Vercel Postgres** (Storage → Create) → `DATABASE_URL` injectée automatiquement.
3. **Variables d'env** : `JWT_SECRET`, `EMAIL_API_KEY_ENC`, `APP_URL`,
   `GEOAPIFY_API_KEY` (votre clé, l'ancienne est à révoquer) + les
   `ADMIN_BOOTSTRAP_*` **une seule fois**, puis à retirer.
4. **Initialiser la base** (une fois) : `npx vercel env pull .env
   --environment=production && npm run db:setup && npm run bootstrap:admin`.
5. **Pusher** sur `main` → déploiement automatique. Sauvegardes : PITR Vercel
   + export manuel `npm run db:export`.
