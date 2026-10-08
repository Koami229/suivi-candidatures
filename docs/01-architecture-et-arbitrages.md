# Étape 1 — Architecture et arbitrages

Ce document explique **chaque choix** de l'étape 1 (structure Vercel, base de
données, schéma) et les points à valider avant l'étape 2.

---

## 1. Structure du projet : statique + `api/`, sans framework

**Choix** : le projet Vercel est un dépôt « Other » : `public/` (statique) +
`api/*.ts` (Vercel Functions Node) + `db/` et `src/lib/` (code partagé).

**Pourquoi pas Next.js (ou autre framework) ?**
- Le front existant est une **page HTML autonome en JS vanilla ES5**. Envelopper
  cette page dans Next.js obligerait à la convertir en page React/Server Component,
  ce qui trahirait la contrainte « conserver l'interface actuelle, avancer
  module par module ».
- Avec `public/` + `api/`, le HTML existant est **déployé tel quel** (une seule
  copie dans `public/`), et chaque module JS (comptes, candidats, entretiens…)
  sera branché sur `fetch('/api/…')` **un par un**, sans toucher à la mise en page,
  au mode sombre ni au responsive/safe-area.
- Coût de ce choix : pas de rendu serveur pour le front — inutile ici, l'UI est
  100 % client et les données viennent de l'API.

**Conséquence pratique** : aucune étape de build, pas de framework à maintenir ;
Vercel installe les dépendances et compile les fonctions TypeScript automatiquement.

## 2. Base de données : Vercel Postgres (moteur Neon)

**Choix** : **Vercel Postgres**, créé depuis le dashboard du projet Vercel.

**Pourquoi**
- **Zéro friction d'intégration** : `DATABASE_URL` injectée automatiquement dans
  les fonctions ; pas de client à configurer, pas d'infra à gérer.
- **Bases de préview par branche** : chaque PR a sa propre base — idéal pour la
  migration progressive (on teste l'API sans toucher aux données de production).
- **Pooler intégré** (Neon) : adapté aux fonctions serverless (beaucoup de
  connexions courtes), sans configurer pgbouncer.
- **Taille** : les données (candidats, comptes, historique) pèsent quelques Mo —
  largement dans les offres d'entrée de gamme.
- **Sortie possible sans lock-in** : c'est du Postgres standard ; le schéma est du
  SQL portable. Si besoin de davantage de contrôle (branching CLI, pooling
  sur mesure), on passe à un projet **Neon direct** en changeant seulement
  `DATABASE_URL` — même moteur, même SQL.

**Choix de client/ORM** : `postgres.js` (client léger, pensé serverless, sans
démon) + **Drizzle ORM** pour le typage TS et les futures migrations
(`drizzle-kit generate` produit du SQL lisible, applicable partout).
Alternatives écartées : Prisma (moteur plus lourd, configuration serverless plus
délicate), `pg` brut (pas de typage), Prisma+`binary` (surcoût sans bénéfice à
cette échelle). La migration initiale est **écrite à la main** (`0001_init.sql`)
pour rester totalement maîtresse de la structure ; les évolutions suivantes
passeront par `drizzle-kit`.

## 3. Schéma de base de données — table par table

### 3.1 `candidats`
- Miroir direct de l'objet JS : chaque champ devient une colonne
  (`notes[]` → `shl_note_1/2/3`, `langues[]`/`informatique[]` → tableaux `TEXT[]`,
  `residenceLat/Lng` → `DOUBLE PRECISION`, etc.).
- `id` en `TEXT` (`'c_' + 8 caractères`), même format que l'app JS → aucune
  compatibilité à prévoir lors de l'import des données existantes.
- `moyenne_shl` : **recalculée par l'API** à chaque écriture, avec la même formule
  que le JS (`round((n1+n2+n3)/3, 1)`). (Une colonne `GENERATED` serait possible ;
  recalcul côté API garde la formule JS à l'identique et laisse l'import contrôler
  le calcul.)
- `email` **unique** (insensible à la casse) : le dédoublonnage de l'import reste
  géré par l'API (comptage des doublons ignorés, comme aujourd'hui), mais la base
  devient la garantie ultime.
- `projet = ''` signifie « non affecté » (fidèle au JS) ; `CHECK` sur `sexe`,
  `niveau_etude`, `age` pour rejeter les valeurs hors catalogue dès la base.

### 3.2 `entretiens` (le « historique »)
- **Une ligne par (candidat, étape)** : `UNIQUE (candidat_id, etape)` reflète
  qu'un candidat a au plus une décision par étape.
- `decision NULL` = « à faire » (l'`a_faire` du JS) ; `OK`/`KO`/`MB` sinon.
- `acteur_nom` fige le recruteur (RH) ou le manager (Mx) **à l'enregistrement**
  (règle actuelle : le nom de la personne qui enregistre est capturé).
- `projet` par tour (vide pour RH) : indispensable à la règle « un même projet ne
  peut pas être réaffecté » et au PV de synthèse (requête par `acteur_nom` +
  `projet`).
- **Le verrou « entretien enregistré = définitif, y compris pour l'admin » sera
  appliqué dans l'API** (étape 4) : tout UPDATE/DELETE d'une ligne dont
  `decision` est non NULL est rejeté. On peut y ajouter un trigger Postgres
  (défense en profondeur) — décision ouverte (§6, point 3).
- Normaliser ici (plutôt qu'un JSON de stages dans `candidats`) rend gratuites
  les requêtes des Statistiques (par étape, période, manager) et du PV, et
  l'historique devient naturellement auditabile.

### 3.3 `comptes`
- `username` (PK) = identifiant = email `@concentrix.com`.
- `password_hash` (bcrypt 12 tours) **remplace le mot de passe en clair** ;
  `NULL` = compte pas encore activé (fidèle à `pass:null`), avec
  `activation_token` + date de création (l'expiration du lien sera gérée à l'étape 2).
- `totp_secret` (base32, nullable) : 2FA **vérifiée côté serveur** à l'étape 2 ;
  `NULL` = à configurer à la première connexion, comme aujourd'hui.
- `refresh_token_hash`/`refresh_token_exp` : JWT access court + refresh stocké
  **haché** (révocable).
- `projet` : obligatoire si `role='manager'` — **contrainte dans la base**
  (`CHECK (role <> 'manager' OR projet IS NOT NULL)`), plus fiable que la UI.
- `desactive_le` : **suppression douce** (voir §6 point 2 — changement de
  comportement par rapport à la suppression définitive actuelle).

### 3.4 `parametres_email` + `templates_email`
- **Une seule ligne** (`id = 1`) : fournisseur (`resend`/`brevo`/`sendgrid` —
  `CHECK`), `api_key`, expéditeur, bascule globale `actif`.
- **Le fournisseur et la clé sont des données, jamais du code** : la fonction
  d'envoi (étape 5) lit la ligne, déchiffre la clé, et appelle l'API du
  fournisseur choisi. Changer de fournisseur = changer la ligne, pas le code.
- `api_key` **chiffrée en base** (AES-256-GCM) avec une clé venue de l'env
  (`EMAIL_API_KEY_ENC`) : l'admin colle sa clé dans l'écran Paramètres, elle
  n'existe jamais en clair dans la base ni dans le code.
- `templates_email` : `code` = déclencheur (`SELECTED`, `PREVIVER`,
  `AFFECTATION_PROJET`, extensible), `objet` + `corps` avec placeholders
  (`{{prenom}}`, `{{candidat}}`, `{{projet}}`, `{{etape}}`, `{{date}}`,
  `{{score}}`). Le contenu des emails vient **uniquement** de ces lignes.
- **Correspondance demandée → templates seedés** :
  | Déclencheur demandé | Template |
  |---|---|
  | Passage à **SELECTED** (tout OK manager) | `SELECTED` |
  | **RH OK** → entrée en pré-vivier | `PREVIVER` |
  | Affectation à un projet (candidat passe à l'étape manager suivante) | `AFFECTATION_PROJET` |

  ⚠️ **Point d'interprétation** : votre cahier des charges mentionne
  « M1/M2 OK → étape suivante ». Or, règle métier actuelle **inchangée**, un OK
  manager **clôt** le parcours (SELECTED) — il n'y a pas d'« étape suivante »
  après un OK manager. L'email « M1/M2 OK » déclenchera donc le template
  `SELECTED`. Si vous voulez un email distinct pour ce cas, on ajoute un code
  dédié (ex. `MANAGER_OK` qui remplace `SELECTED` quand l'OK vient de M1/M2) —
  à trancher avant l'étape 5.

### 3.5 `envois_email`
Journal de **chaque** envoi (candidat, template, destinataire, fournisseur,
statut `envoye`/`echec`/`ignore`, détail, date). Sert au dépannage
(« pourquoi pas d'email ? »), à l'idempotence (pas de double envoi) et
permettra des statistiques d'activité.

### 3.6 `audit_log`
Journal « qui a fait quoi » (connexion, import, décision d'entretien, modification
de compte/paramètres). Ajouté maintenant car il est trivial à inclure dans le
schéma mais douloureux à rétro-fiter ; l'API l'alimentera à partir de l'étape 2.

### 3.7 `candidat_statut()` + `v_candidats`
- Le statut **n'est jamais stocké** (règle « calculé, jamais saisi ») : il est
  une **fonction SQL** répliquant à l'identique `computeStatutCode()`
  (SELECTED → REJET-sortie-définitive → PREVIVER → REJET-RH-KO → EN_ATTENTE).
  Avantage : une seule implémentation de la règle, utilisée par les API, les
  Statistiques et toute future requête ; impossible d'avoir un statut stocké
  périmé.
- La vue `v_candidats` ajoute `statut` et `visible` (moyenne ≥ 80), reprenant
  `passesThreshold()` — les listes « masquées sous le seuil » deviennent une
  simple condition SQL.

## 4. Sécurité (ce qui est déjà en place à l'étape 1)

| Sujet | Choix |
|---|---|
| Base | `DATABASE_URL` uniquement via l'env Vercel ; HTTPS forcé par défaut |
| 1er admin | Script `bootstrap-admin.mjs` : identifiants 100 % en variables d'env, politique de mot de passe identique à l'app, bcrypt 12 tours, **aucun** identifiant dans le code ; variables `ADMIN_BOOTSTRAP_*` à retirer après usage |
| Clé Geoapify | Sera une variable d'env (`GEOAPIFY_API_KEY`) appelée via un proxy API (étape 6). **La clé présente dans l'ancien HTML doit être révoquée dès maintenant** (elle est considérée divulguée). |
| Clés email | Saisies par l'admin dans l'UI, **chiffrées** (AES-GCM) avant stockage en base |
| Comptes démo | Seront supprimés du front et de toute référence (étape 2) ; plus aucune aide affichant des mots de passe |

## 5. Ce que l'étape 1 ne change PAS dans l'application

- Aucune règle métier (seuil 80, pipeline, verrous, statuts, KO/MB → pré-vivier).
- Aucune interface : l'app HTML actuelle continue de fonctionner en `localStorage`
  sur le poste qui l'utilise ; le déploiement Vercel sert une page placeholder
  tant que le front n'est pas branché (étape suivante).

## 6. Points à valider avant l'étape 2

1. **Base** : Vercel Postgres (recommandé, zéro config) ou projet Neon direct ?
2. **Suppression des comptes** : suppression **douce** (`desactive_le`, révocable,
   recommandée en production) au lieu de la suppression définitive actuelle ?
3. **Verrou des entretiens** : application côté API (recommandée, testable) et/ou
   trigger Postgres (défense en profondeur, bloque aussi tout contournement) ?
4. **Templates email** : la correspondance du §3.4 est-elle bonne, en particulier
   « M1/M2 OK → email `SELECTED` » ? Faut-il un code distinct `MANAGER_OK` ?
5. **Admin initial** : l'identifiant que vous voulez pour le bootstrap
   (email @concentrix.com) — à ne communiquer qu'en variable d'env, jamais dans
   le dépôt.

## 7. Plan des étapes suivantes (rappel)

| # | Étape | Livrable principal |
|---|---|---|
| 2 | Auth serveur | `/api/auth/login` (bcrypt), `/api/auth/twofa`, `/api/auth/activate` (lien), JWT access + refresh, middleware de session ; front : écran de connexion branché sur l'API, comptes démo et aide supprimés |
| 3 | API candidats | `/api/candidats` (liste filtrée/seuil, fiche, corrections), `/api/candidats/import` (Excel/CSV côté serveur, dédoublonnage) ; front : vue Candidats sur l'API |
| 4 | API pipeline | `/api/entretiens` (règles de déblocage, verrous, statuts recalculés), `/api/previvier/affecter` ; front : modale + pré-vivier sur l'API |
| 5 | Email | Écran Paramètres > Email (3 fournisseurs, clé chiffrée, templates éditables) ; envois auto sur changement de statut ; journal |
| 6 | Modules restants | Proxy Geoapify (clé en env), autocomplétion, PV de synthèse, Statistiques — sur données de base |
| 7 | Durcissement | Audit log, sauvegardes, expiration des liens d'activation, RGPD |

## 8. Comment le front basculera progressivement (sans casser)

Le HTML actuel sera découpé en **une couche d'accès aux données**
(`dataLayer` : `loadCandidates()`, `saveCandidates()`, `loadAccounts()`, …)
avec deux implémentations :
- `LocalData` (localStorage — actuelle),
- `ApiData` (fetch `/api/…` — nouvelle).

Une bascule unique (variable d'env du front / paramètre d'URL) choisit
l'implémentation **par module** : on branche d'abord les comptes (étape 2),
puis les candidats (étape 3), puis les entretiens (étape 4). À chaque étape,
l'app reste fonctionnelle, et en cas de problème on repasse le module en mode
local. C'est ce qui garantit « fonctionnel à chaque étape plutôt que tout casser ».

## 9. Étape 2 livrée — Authentification serveur

### 9.1 Architecture de l'authentification

| Élément | Choix |
|---|---|
| Mot de passe | **bcrypt** (coût 12), hashé côté serveur ; jamais de mot de passe en clair ni dans le code. `password_hash NULL` = compte en attente d'activation |
| Session | **JWT HS256** (node:crypto, zéro dépendance) : access 15 min + refresh opaque 7 jours **stocké haché (SHA-256) en base** → révocable ; **rotation** à chaque refresh (un refresh = un seul usage) |
| 2FA | **TOTP RFC 6238** (SHA-1, 6 chiffres, 30 s, ±1 pas) **vérifié côté serveur** ; le front ne calcule plus rien (plus de dépendance à Web Crypto → le contournement `file://`/HTTP de l'app actuelle est supprimé) |
| Première connexion | Clé TOTP générée par le serveur, retournée dans un **ticket signé (10 min)** ; la clé n'est enregistrée que si le code de confirmation est valide (identique au flux actuel) |
| Activation | Lien `?activation=<uuid>` (validité 7 j, un seul usage) ; la personne définit son propre mot de passe (politique appliquée côté serveur) |
| Rôles | `requireAuth(req, roles)` : Bearer → vérif JWT → compte actif → filtre de rôle (les routes `/api/comptes` exigent `rh`) |
| Audit | Chaque événement sensible (login, 2FA, activation, création/modification/suppression de compte, changement de mot de passe) écrit dans `audit_log` |

Routes : `POST /api/auth/login`, `POST /api/auth/twofa`, `POST /api/auth/refresh`,
`POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/activate`,
`POST /api/auth/activation`, `POST /api/auth/password`,
`GET /api/auth/twofa-status`, `POST /api/auth/twofa-regenerate`,
`POST /api/auth/twofa-confirm`, `GET|POST /api/comptes`,
`GET|PUT|DELETE /api/comptes/:username`, `POST /api/comptes/:username/reset`.

### 9.2 Front adapté (interface inchangée)

- `public/index.html` = l'app originale branchée sur l'API (21 remplacements
  documentés dans `scripts/migrate-front-step2.mjs`, reproductibles depuis le
  fichier d'origine).
- Session : `sc_session_v1` dans localStorage = `{access, refresh}` ; `apiFetch()`
  renouvelle automatiquement sur 401.
- **Comptes de démonstration supprimés** (DEFAULT_ACCOUNTS) ; l'aide de connexion
  ne contient plus aucun identifiant ni mot de passe ; plus de
  `recrutement_comptes_v1` / `recrutement_session_v7`.
- Vues concernées : connexion, 2FA, activation, modale « Mot de passe et double
  authentification », Paramètres (liste/création/modification/suppression/
  réinitialisation des accès). Les vues Candidats / Pré-vivier / Statistiques
  restent sur localStorage jusqu'aux étapes 3-4 (l'app fonctionne en parallèle).
- Mise en page, mode sombre, safe-area : inchangés.

### 9.3 Décisions notables

- **bcryptjs 3.x** (et non 2.4.3) : la 2.4.3 est cassée par les bundlers ESM
  (détection de `node:crypto` défaillante → « Neither WebCryptoAPI nor a crypto
  module is available »). La 3.x est bundler-safe (vérifié par esbuild, qui
  compile aussi les fonctions pour les tests ; Vercel utilise webpack — les
  deux fonctionnent avec la 3.x).
- **Refresh tokens opaques hachés** plutôt que JWT longs : révocables (logout,
  réinitialisation, suppression de compte) sans état serveur supplémentaire.
- **Tickets courts signés** pour la 2FA (pré-auth à la connexion, réinitialisation
  de clé) : sans table d'état, TTL 10 min, non réutilisables.
- **Suppression douce** des comptes (`desactive_le`) : validée ; réversible en
  base (testé), masquée partout côté API.

### 9.4 Validation

`npm run validate:step2` — **47 tests, 0 échec**, sur Postgres réel :
bundle esbuild des 14 fonctions, bootstrap admin via le script de production,
login (bonne/mauvaise auth), 2FA première configuration + vérification +
code erroné, `/me` (valide/invalide/absent), rotation du refresh, création de
compte (manager sans projet refusé, doublon refusé, lien d'activation),
activation (lien valide/invalide/forcé/déjà utilisé, mot de passe faible
refusé), connexion manager (rôle + projet), contrôle de rôle (manager → 403
sur `/api/comptes`), changement de mot de passe, gestion 2FA (statut,
régénération, confirmation, ticket usagé), logout (révocation), réinitialisation
(nouveau lien, réactivation), suppression douce (réversibilité), audit (≥ 10
événements). `npm run validate` (étape 1) : toujours 30/30 — aucune régression.

## 10. Étapes 3+4 livrées — Magasin candidats + pipeline + pré-vivier + stats + PV

### 10.1 Périmètre (décision de regroupement)

L'étape 3 (candidats : CRUD + import) **absorbe l'étape 4** (pipeline des
entretiens + pré-vivier) : la fiche candidat, le pré-vivier, les statistiques et
le PV de synthèse lisent **le même store**. Basculer les candidats sur l'API
rendait la bascule du pipeline inévitable dans le même pas (sinon le front
aurait deux sources de données). Le PV et les statistiques, initialement
prévus plus tard, sont donc livrés ici — ils ne peuvent exister que sur des
données de base.

### 10.2 Routes

| Route | Rôle | Fonction |
|---|---|---|
| `GET /api/candidats?q=` | les 3 | Liste **filtrée par rôle** (seuil SHL, périmètre recruteur/manager) + recherche nom/prénom/email |
| `POST /api/candidats` | RH | Création manuelle (email unique) |
| `POST /api/candidats/import` | RH | Import Excel/CSV **multipart**, traité côté serveur |
| `GET /api/candidats/:id` | les 3 | Fiche + étapes débloquées + tour du manager (`myRound`) ; périmètre vérifié (404 sinon) |
| `PUT /api/candidats/:id` | les 3 | `{identity?, info?, stages?}` — règles métier appliquées (voir 10.4) |
| `DELETE /api/candidats/:id` | RH | Suppression (entretiens en cascade) |
| `GET /api/previvier` | RH, recruteur | Items `{candidat, round, roundIndex, projetsTraites}` |
| `POST /api/previvier/:id/affecter` | RH, recruteur | `{projet}` — refus 400 si projet déjà traité ou pas de tour en attente |
| `GET /api/stats?from&to&sexe&niveau&projet&geoloc&statut` | RH | Métriques (le seuil SHL **n'est pas** un filtre : la liste complète compte) |
| `GET /api/pv` | manager | Entretiens finalisés menés par **son** nom de session sur **son** projet, triés date→candidat |

### 10.3 Sérialisation

Le candidat est sérialisé **à l'identique de l'objet JS de l'app** (`nom, prenom,
email, contact, sexe, age, niveauEtude, domaineEtude, residence, departement,
ville, residenceLat/Lng, experienceConcurrents, projet, langues[], informatique[],
notes[], moyenne, stages{rh,m1,m2,m3}`) + `statut` calculé (`EN_ATTENTE /
PREVIVER / SELECTED / REJET`). Décision SQL NULL → `a_faire` ; `RH` → champ
`recruteur`, `Mx` → champ `nomManager` ; dates `YYYY-MM-DD`. Le front a donc
besoin de quasi aucun changement de structure (cf. 10.6).

### 10.4 Règles métier portées côté serveur (inchangées)

| Règle | Application API |
|---|---|
| Seuil SHL ≥ 80 affiché | `visibleForRole()` : sous le seuil = enregistré mais masqué (tous rôles) |
| Verrou définitif d'un entretien saisi | `PUT` sur une étape déjà décidée → **409 pour tous, RH y compris** |
| Déblocage séquentiel | M2 seulement si M1 = KO/MB ; M3 seulement si M2 = KO/MB (jamais après OK) |
| Seul l'OK clôt le parcours | Un `ok` manager → `SELECTED`, disparaît des listes manager |
| 3 tours KO/MB sans OK | `REJET` définitif |
| KO/MB manager → retour pré-vivier | `candidats.projet` effacé ; le projet du tour reste figé sur l'entretien |
| Re-affectation sur un projet déjà traité | `POST /api/previvier/:id/affecter` → **400** |
| Périmètre manager | Uniquement `myRound` sur le candidat **affecté à son projet** (403 sinon) |
| Périmètre recruteur | Entretien RH + affectations seulement (403 sur les étapes managers) |
| Dédoublonnage import par email | Contre la base ET au sein du fichier (insensible à la casse) |

### 10.5 Fidélité à l'app d'origine (comportements conservés, même les quirks)

- **Import** : port exact de `processRows` — détection des colonnes par
  mots-clés (`findNoteCol`, `scoreLikeCols`, « nom complet »), notes par défaut
  colonnes 4-6, moyenne `Math.round((s/3)*10)/10`. Conséquences d'origine
  conservées : les en-têtes accentués (« Prénom », « Résidence ») ne sont pas
  reconnus (`indexOf('pren')`/`'resid'`), et un séparateur est déduit **par
  ligne** (`,` présent dans la ligne → toute la ligne est découpée en `,`).
- **Saisie par procuration** : le RH peut saisir un entretien manager (ses
  sections sont toutes affichées) ; dans ce cas le projet du tour reste **vide**
  (comme l'app — seul le compte manager fige le projet), et un KO/MB le ramène
  au pré-vivier.
- **Garde de lecture** : le recruteur ne peut ouvrir que ce qu'il peut atteindre
  (en attente RH ou pré-vivier) — l'app avait la fonction `canStillView` ;
  l'API l'applique sur `GET /:id` (404 sinon).
- **Moyenne** : recalculée au même endroit (import/création) ; jamais éditable
  dans la fiche.

### 10.6 Front (interface inchangée)

`scripts/migrate-front-step3.mjs` — 18 remplacements à marqueurs vérifiés
(2 423 → 1 981 lignes, syntaxe du script inline re-vérifiée) :

- **Supprimés** : bloc Geoapify (clé en dur `GEOAPIFY_API_KEY` — jamais
  re-codée ; l'autocomplétion reviendra via proxy à l'étape 6), store
  localStorage candidats (`var candidates`, `sampleData`, `load/saveCandidates`,
  normalizers), pipeline local (statuts, visibilité, déblocages),
  `processRows/splitLine`, `wireResidenceMap`, CDN XLSX, CSS autocomplétion.
- **Branchés sur l'API** : liste (GET, recherche débouncée 200 ms), pré-vivier
  (GET + POST affecter), import (POST multipart, message d'alerte identique),
  fiche (GET — déblocages calculés serveur), enregistrement modal
  (PUT — validation client conservée, verrous côté serveur), statistiques (GET),
  PV (GET — même rendu, `dateEdition` fourni par l'API).
- **Conservés** : `STAGES`, `STATUT_LABELS` (lit `c.statut`), `SEUIL`, catalogues,
  `escapeHtml`, `todayStr`, tout le DOM/CSS des vues.
- La saisie « Adresse de résidence » reste possible (saisie manuelle) ;
  département/ville sont devinés côté serveur (`sanitizeInfo`).

### 10.7 Décisions notables

- **Transactions postgres.js sur pool `max: 10`** : postgres.js refuse un
  `BEGIN` sur un pool multi-connexions (`UNSAFE_TRANSACTION`) ; les écritures
  multi-statements (PUT fiche, import) passent par une **connexion réservée**
  (`await sql.reserve()` → `begin`/`commit`/`rollback` → `release()`).
- **`xlsx` (SheetJS 0.18.5) côté serveur** : l'import Excel n'a plus besoin du
  CDN dans le navigateur ; en test, `xlsx` est marqué `external` du bundle
  esbuild (CJS, `require('stream')` dynamique) et résolu depuis `node_modules`.
- **Segment d'URL lu dans le pathname** (pas `ctx.params`) : même code sur
  Vercel (Edge/Node) et dans les tests, indépendamment du runtime.
- **Nom de session** (« Prénom Nom ») figé dans `entretiens.acteur_nom` à
  l'enregistrement : identique à l'app (le PV de synthèse s'appuie dessus).
- **`audit_log` alimenté** : import, création, modification, entretien saisi,
  affectation, suppression.

### 10.8 Validation

`npm run validate:step3` — **86 tests, 0 échec**, sur Postgres réel :
bundle esbuild (15 fonctions), bootstrap admin + 4 comptes (recruteur, 3
managers de projets distincts), import CSV (4/1 doublon/3 visibles, refus
rôle, fichier vide), import Excel (2/1/1), création (201/409/403), listes par
rôle + recherche + sérialisation (notes, moyenne, statuts, geo), fiche +
déblocages + 404 de périmètre, entretien RH (200, recruteur figé, geo dévignée,
**409 au re-PUT recruteur et RH**, 403 manager sur identité), pré-vivier (403
manager, affectation OK/400 projet inconnu), flux manager (visible selon
projet+tour, 403 mauvais tour, OK → SELECTED + sortie des listes, KO/MB →
retour pré-vivier + projet effacé + re-affectation interdite 400, cascade
3 tours → REJET), RH KO → REJET, statistiques (totaux, décisions, niveaux,
statuts, geoloc, période, filtre statut, 403), PV (3 managers, tri, compteurs,
403 RH), suppression (403 recruteur, cascade des entretiens, 404), cohérence
base + audit (≥ 15 événements).
Régressions : `validate:step2` toujours 47/47, `validate` toujours 30/30,
`typecheck` OK.

## 11. Étape 5 livrée — Emails automatiques (Paramètres > Email)

### 11.1 Architecture

| Élément | Choix |
|---|---|
| Fournisseur | **Donnée, pas du code** : la ligne `parametres_email` (id = 1) porte `fournisseur` (`resend` / `brevo` / `sendgrid` — `CHECK` en base), la clé, l'expéditeur et la bascule `actif`. Changer de fournisseur = changer la ligne, pas le code. Les trois fournisseurs sont de simples adaptateurs (`src/api/email.ts`) : aucune API tierce n'est privilégiée ni codée en dur comme « celle de la prod » |
| Clé API | **Chiffrée AES-256-GCM en base** (format `v1:<iv>:<tag>:<ciphertext>`) avec une clé venue de l'env `EMAIL_API_KEY_ENC` (64 hexadécimaux, ou n'importe quelle chaîne normalisée par SHA-256 — documenté). La clé n'existe **jamais en clair** dans la base, le code ni les réponses d'API (l'API renvoie uniquement `has_key`) |
| Contenu | **Uniquement** les lignes `templates_email` (objet + corps, variables `{{prenom}}`, `{{candidat}}`, `{{projet}}`, `{{etape}}`, `{{date}}`, `{{score}}`) — personnalisables dans Paramètres > Email ; une variable inconnue se substitue par une chaîne vide |
| Déclencheurs | `PREVIVER` (RH OK → entrée en pré-vivier), `AFFECTATION_PROJET` (affectation → entretien manager à venir), `SELECTED` (1er OK manager) — cf. §3.4. Un seul envoi par **transition** de statut (les entretiens étant verrouillés, ces transitions sont irréversibles) ; l'affectation envoie un email par action |
| Robustesse | `triggerEmail()` **ne lève jamais** : chaque tentative est journalisée dans `envois_email` (`envoye` / `echec` / `ignore` + détail). Un échec fournisseur ou une config incomplète **ne bloque ni ne refuse la décision métier** (l'UI en est informée par le journal, jamais par un blocage) |
| Email de test | `POST /api/parametres/email/test` — vérifie fournisseur + clé + expéditeur sans attendre un changement de statut (ne requiert pas la bascule `actif`) |

Routes : `GET|PUT /api/parametres/email` (RH), `POST /api/parametres/email/test` (RH),
`GET /api/parametres/email/envois` (RH, 100 derniers) — tout le reste : 403.
`PUT` : mise à jour partielle ; `api_key` vide/absente = **conserver** la clé
existante ; `remove_api_key: true` = l'effacer. `libelle` des templates en
lecture seule (identifiant du déclencheur).

### 11.2 Migration 0002

Aucun changement de schéma — une seule correction de **contenu** : le template
`AFFECTATION_PROJET` seedé mentionnait « (date : {{date}}) » alors qu'à
l'affectation la date de l'entretien est inconnue (planifiée ensuite par le
manager). `migrations/0002_email_templates.sql` le reformule avec `{{etape}}`.

### 11.3 Front (interface cohérente, rien d'autre changé)

`public/index.html` : nouvelle section « **Emails automatiques** » dans
Paramètres (visible RH uniquement, comme le reste de la vue) :

- fournisseur (Resend / Brevo / SendGrid), clé API (champ masqué, « laisser vide
  pour conserver la clé actuelle »), email + nom de l'expéditeur, bascule
  « Envoi automatique activé » ;
- **templates** : objet + corps éditables par déclencheur, variables documentées ;
- **email de test** (adresse libre) ;
- **journal des envois** (date, candidat, email, destinataire, fournisseur,
  statut Envoyé/Échec/Ignoré, détail au survol).

Tous les échanges passent par l'API (aucune clé ne transite ni ne reste dans le
navigateur au-delà de la saisie).

### 11.4 Décisions notables

- **Envoi après commit, jamais en transaction** : l'appel fournisseur (latence
  réseau) ne retient pas la connexion de la transaction de décision ; le
  journal est écrit dans tous les cas (échec inclus).
- **Seam de test explicite** (`__setEmailFetchForTests`) : la suite de
  validation remplace la couche HTTP des adaptateurs — aucune requête réelle ne
  part vers Resend/Brevo/SendGrid pendant les tests ; le bundle de production
  n'utilise jamais ce point d'entrée.
- **Interprétation validée** (§3.4 ⚠️) : l'OK d'un manager clôt le parcours, il
  n'y a pas d'« étape suivante » après OK manager → le template `SELECTED`
  couvre ce cas (pas de code `MANAGER_OK`).
- La suppression d'un candidat met `candidat_id NULL` dans le journal
  (`ON DELETE SET NULL`) : l'historique des envois survit.

### 11.5 Validation

`npm run validate:step5` — **47 tests, 0 échec** sur Postgres réel :
défauts de config, droits (403 manager / 401 anonyme), chiffrement de la clé
(format `v1:…`, jamais en clair, round-trip AES-256-GCM, préservation si
vide/absente, suppression explicite), validation (fournisseur inconnu 400,
expéditeur invalide 400, template inconnu 400), template `SELECTED`
personnalisé réellement servi au candidat, parcours complet (RH OK → email
`PREVIVER` Brevo ; affectation Samsung → email `AFFECTATION_PROJET` avec projet
+ étape ; OK manager → `SELECTED` au template admin, moyenne rendue), journal
(3 envois, ordre, candidat nommé, aucun `{{…}}` résiduel, MAJ info sans
transition = aucun email), bascule `actif` désactivée → « ignoré » (cause
lisible), clé absente → « ignoré », adaptateurs Resend (Bearer) et SendGrid
(personalizations) vérifiés, échec fournisseur → décision conservée + « échec »
journalisé, email de test (envoyé / 400 / 403 / 502), audit (`parametres.email.*`),
8 appels transport simulés au total (0 appel réel).
Régressions : `validate` 30/30, `validate:step2` 47/47, `validate:step3` 86/86,
`typecheck` OK.

## 12. Étape 6 livrée — Geoapify via proxy API + autocomplétion

### 12.1 Architecture

| Élément | Choix |
|---|---|
| Clé | **Env Vercel uniquement** (`GEOAPIFY_API_KEY`) — jamais dans le code, jamais dans le navigateur, jamais dans une réponse. **L'ancienne clé présente dans le fichier HTML d'origine est considérée comme divulguée et doit être révoquée** sur le dashboard Geoapify avant de créer la nouvelle |
| Endpoint | `GET /api/geo/search?q=<texte>&limit=<1-8>` (défaut 6, plafond 8, minimum 1) — `q` entre 2 et 120 caractères |
| Amont | `https://api.geoapify.com/v1/geocode/autocomplete` — **HTTPS forcé** (l'URL amont est littéralement en https, rien d'autre n'est tenté), `filter=countrycode:bj` + `lang=fr` (zone Bénin, comme l'app d'origine) |
| Réponse | Seuls les champs consommés par le front sont renvoyés : `{ results: [{ formatted, city, state, county, lat, lon }] }` (les autres champs Geoapify, dont tout identifiant, sont jetés) |
| Rôle | Tout compte authentifié (l'interface de saisie de la résidence n'est éditable que par le RH ; le proxy reste utilisable par tout compte interne — pas de donnée sensible exposée) |
| Dégradation | Clé absente → **503 explicite** ; amont KO/réseau → **502 explicite** ; JSON amont invalide → 200 + liste vide. Dans tous les cas le **front retombe sur la saisie manuelle** (toujours fonctionnelle) avec un hint sous le champ |

### 12.2 Front (interface d'origine restaurée, transport changé)

Le port de l'autocomplétion d'origine est **à l'identique** (debounce 300 ms,
liste sous le champ, clic → remplissage résidence + département + ville +
lat/lng, fermeture au clic extérieur, hint d'erreur) : CSS
`.geoapify-suggestions*` + `.residence-hint` restaurés, `wireResidenceMap()`
rebranché sur chaque ouverture de fiche, helpers d'extraction
(département depuis `state`/`county`/texte, ville depuis `city`/`county`/1er
segment) inchangés. Seule différence : `geoapifyAutocomplete()` ne fetch plus
l'API Geoapify directement — il appelle `/api/geo/search` via `apiFetch`
(session + refresh automatique). Aucune clé, aucun `apiKey=` dans
`public/index.html` (vérifié par la suite de tests sur tout le dépôt).

### 12.3 Décisions notables

- **Proxy minimal, pas de cache** : l'autocomplétion fait au plus quelques
  requêtes par saisie ; un cache (lat/lng → adresse) sera un éventuel
  raffinement, pas une exigence.
- **1 seul appel amont par recherche** (pas de double fetch), vérifié au test.
- La clé divulguée de l'origine **n'apparaît nulle part** dans le dépôt —
  le script de validation la cherche par concaténation de fragments (le
  littéral complet ne figure pas dans le script de test lui-même).

### 12.4 Validation

`npm run validate:step6` — **30 tests, 0 échec** sur Postgres réel :
401 non authentifié, 400 (q trop courte/trop longue), 405 POST, 200 +
normalisation (champs exacts, coordonnées numériques), URL amont
(https + countrycode:bj + lang=fr + text), clé présente en amont et **absente
de la réponse**, 1 seul appel amont, limites (3 / 8 plafond / 1 minimum),
rôle manager accepté, amont 401 → 502, 500 → 502, réseau coupé → 502
« inaccessible », JSON invalide → 200 vide (gracieux), clé absente → 503 avec
mention de l'env, clé restaurée → 200 ; audit front (aucune clé en dur,
autocomplétion + CSS restaurés) et audit du dépôt (clé divulguée absente
partout, hors `node_modules`).
Régressions : `validate` 30/30, `validate:step2` 47/47, `validate:step3` 86/86,
`validate:step5` 47/47, `typecheck` OK.

## 13. Étape 7 livrée — Durcissement (audit, purge RGPD, sauvegardes, mentions)

Détails complets dans **`docs/02-durcissement-et-rbgd.md`** (inventaire des
données, mesures, droits, procédures d'incident). En résumé :

- **Audit exhaustif + consultation** : `login.echec` ajouté (échecs de
  connexion audités avec motif — détection brute-force ; réponse identique
  quelle que soit la cause d'échec). Nouvelle route `GET /api/audit` (RH) avec
  filtres `username` / `action` (préfixe) / `q` (recherche libre incluant
  l'action) / `limit`, et section « Journal d'audit » dans Paramètres.
  Garanties testées : le journal ne contient **aucune donnée personnelle des
  candidats** (noms/emails absents).
- **Purge RGPD** : `POST /api/candidats/:id/purger` (RH, double protection :
  rôle + `confirmation` = identifiant exact). Effet irréversible : candidat +
  entretiens (cascade), journal emails **anonymisé** (`candidat_id` NULL,
  destinataire « [purge RGPD] »), ligne d'audit `candidat.purge_rgpd`. Bouton
  « Purger (RGPD) » dans la fiche (RH, double confirmation).
- **Sauvegardes** : `npm run db:export` (export JSON daté des 7 tables,
  `backups/` gitignorée) + `npm run db:restore -- <fichier>` (migrations +
  remplacement du contenu de la cible, id des journaux conservés via
  `OVERRIDING SYSTEM VALUE`). Complète le PITR natif de Vercel Postgres.
- **Mentions RGPD** : écran de connexion (brève) + section « Données
  personnelles (RGPD) » de Paramètres (responsable, finalité, durée, droits,
  mesures) + doc `docs/02-durcissement-et-rbgd.md`.

**Validation** : `npm run validate:step7` — 50 tests, 0 échec (dont
restauration réelle sur un deuxième Postgres). Régressions : toutes les suites
vertes — `validate` 30/30, `validate:step2` 47/47, `validate:step3` 86/86,
`validate:step5` 47/47, `validate:step6` 30/30, `typecheck` OK.

**La migration est terminée** : les 7 étapes sont livrées, l'application est
100 % servie par l'API (Postgres), aucune donnée sensible n'est dans le
navigateur, et chaque étape est re-productible (scripts de migration du front +
suites de validation).

## 14. Mise à jour v16 — Étape 8 livrée : règles métier

La version 16 de l'app d'origine (fichier unique) a été intégrée à la
migration. Étape 8 : les **règles métier** de la v16, portées côté serveur.

### Changements
- **Langues : 7 options** (Anglais, Espagnol, Arabe, Chinois, Allemand,
  Russe, Portugais) — `src/lib/constants.ts` + front.
- **Affectation — contrôles anti-doublons** (nouveau, `src/api/candidats.ts`) :
  - `cleIdentite` / `fichesDoublons` : même personne = même email **ou** même
    nom+prénom (comparaison tolérante `normProjet`) ;
  - une même personne n'est affectée qu'à **un seul projet** à la fois ;
  - jamais re-affectée à un projet **déjà traité** (tous tours confondus) ;
  - appliqués sur `POST /api/previvier/:id/affecter` **et** sur l'affectation
    directe depuis l'entretien RH.
- **Affectation directe depuis l'entretien RH** : le champ « Affecter au
  projet / poste correspondant » (facultatif) est appliqué **uniquement si la
  décision est OK**. En cas de refus (contrôles), l'entretien est enregistré
  et la réponse porte `affectationErreur` (alerte au front, non bloquant).
  KO → champ vidé et verrouillé côté UI.
- **Contrôle bloquant du manager** : enregistrement refusé (400) si le projet
  du tour a déjà été traité sur un autre tour — l'affectation est effacée
  (retour au pré-vivier). En pratique, le 403 « non affecté » précède ce cas
  grâce au garde-fou ci-dessous ; le contrôle reste en double sécurité.
- **Visibilité manager** : un candidat **déjà reçu** sur le projet du manager
  disparaît de sa liste (`visibleForRole` + `projetDejaTraite`).
- **Garde-fou d'intégrité** (`garantirAffectationUnique`) : toute affectation
  pointant vers un projet déjà traité (données legacy/importées) est annulée
  au chargement, puis **persistée** à la prochaine modification réussie de la
  fiche. **Nuance assumée par rapport à la v16** : le projet d'un candidat
  déjà **SÉLECTIONNÉ** (OK sur ce projet) n'est PAS effacé — dans la v16,
  l'implémentation brute du garde-fou avait cet effet de bord (l'affectation
  y est le résultat du parcours, pas une convocation en attente).
- **Historique des entretiens** (front, existant) : l'affectation RH n'est
  plus rappelée dans l'historique de l'étape RH (fix v16).

**Validation** : `npm run validate:step8` — 59 tests, 0 échec (langues,
affectation RH OK/KO/doublons, pré-vivier renforcé, refus manager, visibilité,
garde-fou + persistance, SELECTED conserve son projet, audit du front).
Régressions : toutes les suites vertes (30/30 · 47/47 · 86/86 · 47/47 ·
30/30 · 50/50) + typecheck.
