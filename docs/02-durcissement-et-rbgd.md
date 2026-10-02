# Étape 7 — Durcissement et RGPD

Document de référence : inventaire des données, mesures de sécurité, droits des
personnes, purge RGPD, sauvegardes/restauration.

## 1. Inventaire des données traitées

| Donnée | Où | Qui la saisit | Durée de conservation |
|---|---|---|---|
| Candidats (identité, contact, profil, résidence, scores SHL) | `candidats` | RH (saisie ou import Excel/CSV) | Jusqu'à la fin du processus de recrutement ; purge RGPD sur demande |
| Décisions d'entretiens (RH/M1/M2/M3) | `entretiens` | RH, recruteur, managers | Idem (supprimée en cascade avec le candidat) |
| Journal des emails (destinataire, statut, détail) | `envois_email` | Système | Idem — **anonymisé** à la purge (destinataire → « [purge RGPD] », `candidat_id` → NULL) |
| Comptes internes (identifiant, nom/prénom, email contact, mot de passe **haché**, clé 2FA) | `comptes` | Admin RH | Vie du compte (suppression douce réversible) |
| Configuration email (fournisseur, clé **chiffrée**, expéditeur, templates) | `parametres_email`, `templates_email` | Admin RH | Vie de l'application |
| Journal d'audit (« qui a fait quoi ») | `audit_log` | Système | Conservé comme trace opérationnelle ; **ne contient aucune donnée personnelle des candidats** |

Les clés sensibles (JWT, clé de chiffrement des clés email, clé Geoapify) ne
vivent que dans les **variables d'environnement Vercel** — jamais dans le code,
la base (sauf la clé email, chiffrée AES-256-GCM) ni le navigateur.

## 2. Mesures de sécurité

- **Comptes** : individuels, politique de mot de passe appliquée côté serveur,
  hachage **bcrypt (coût 12)**, suppression douce (réversible en base, masquée
  partout).
- **2FA obligatoire** (TOTP RFC 6238) vérifiée côté serveur ; aucune dépendance
  au Web Crypto du navigateur.
- **Sessions** : JWT d'accès 15 min + refresh opaque 7 jours **haché en base**,
  rotation à chaque usage, révocable (logout, réinitialisation, suppression de
  compte).
- **Rôles et périmètres** vérifiés côté serveur sur chaque route (RH / recruteur
  / manager — un manager ne voit que les candidats de son projet à son tour).
- **Règles métier verrouillées côté serveur** : entretien saisi = définitif
  (409 pour tous, RH y compris), déblocage séquentiel, re-affectation projet
  interdite…
- **Clés API email chiffrées en base** (AES-256-GCM, clé en env) ; jamais
  retournées par l'API (`has_key` seulement).
- **Geoapify** : proxy serveur, clé en env, HTTPS forcé, réponse normalisée
  (jamais de clé dans la réponse).
- **Aucune donnée sensible dans le navigateur** (plus aucun store
  localStorage métier ; plus aucune clé API).
- **Journal d'audit** alimenté par toutes les opérations sensibles, dont les
  **échecs de connexion** (`login.echec` avec motif : détection de sondage /
  brute-force) — réponse identique pour compte inconnu, désactivé et mauvais
  mot de passe (aucune information discriminante).
- **Erreurs** : 500 neutre, jamais de stack leakée (`run()`).
- **Hébergement** : base de données managée Vercel Postgres (PITR/rétention
  gérés par Vercel), accès par identifiants.

## 3. Droits des personnes (RGPD)

| Droit | Exécution |
|---|---|
| **Accès / rectification** | L'administrateur RH consulte et modifie directement dans l'outil (fiche candidat, Paramètres). |
| **Effacement** | **Purge RGPD** : bouton « Purger (RGPD) » de la fiche candidat (RH, double confirmation + identifiant renvoyé en `confirmation`). Effet irréversible : fiche + entretiens supprimés, traces d'emails anonymisées, ligne d'audit `candidat.purge_rgpd` (sans données personnelles). API : `POST /api/candidats/:id/purger`. |
| **Information** | Mention sur l'écran de connexion + section « Données personnelles (RGPD) » de Paramètres (ci-dessous, résumée). |

Résumé des mentions affichées : responsable du traitement = Concentrix Bénin
(service recrutement) ; finalité = gestion du processus de recrutement
(aucune décision entièrement automatisée) ; durée = fin du processus, purge RGPD
au-delà ; droits à adresser à l'administrateur RH.

## 4. Journal d'audit — consultation

- **API** : `GET /api/audit?username=&action=&q=&limit=` (RH uniquement).
  - `username` exact ; `action` par préfixe (`login`, `candidat`, …) ;
    `q` recherche libre (utilisateur, **action**, cible, détail) ; `limit` 1-500.
- **UI** : Paramètres > « Journal d'audit » — filtres (utilisateur, action,
  recherche libre) + table des 100 événements les plus récents.
- **Actions consignées** (exhaustif) : `login.*` (dont `login.echec`),
  `logout`, `compte.*` (création, modification, suppression, réinitialisation,
  activation, 2FA), `candidat.cree / .maj / .import / .affecte / .supprime /
  .purge_rgpd`, `entretien.saisi`, `parametres.email.maj / .test`.
- **Simplicité d'usage** : `detail` JSONB borné (métadonnées uniquement :
  nombre d'items ajoutés, étapes saisies, projet affecté, compteurs de purge…).

## 5. Sauvegardes et restauration

**Deux niveaux :**

1. **Native** : Vercel Postgres (rétention + PITR gérés par Vercel) — rien à
   configurer dans le code.
2. **Manuelle** : export JSON daté de toutes les tables.

```bash
# Export (fichier backups/suivi-<date>.json)
npm run db:export

# Restauration sur DATABASE_URL (migrations appliquées,
# contenu de la cible REMPLACÉ par l'export — base vide ou réinitialisation)
npm run db:restore -- backups/suivi-<date>.json
```

- L'export contient les 7 tables (ordre compatible aux clés étrangères), les
  compteurs, et la version de schéma (`suivi-candidatures/0002`).
- Les id des journaux (`envois_email`, `audit_log`) sont **conservés**
  (`OVERRIDING SYSTEM VALUE`) — traçabilité intacte.
- **Confidentialité** : le fichier contient mots de passe (hachés), clés 2FA,
  clé email chiffrée et données candidats → à stocker avec la même rigueur que
  la base (hors dépôt, `backups/` est dans `.gitignore`).
- **Fréquence recommandée** : hebdomadaire minimum + avant toute modification
  structurante ; l'export prend quelques secondes (base de recrutement, taille
  modeste).

## 6. Procédures d'incident (rappel)

| Incident | Action |
|---|---|
| Clé Geoapify suspectée divulguée | Révoquer sur le dashboard, remplacer l'env `GEOAPIFY_API_KEY` (l'ancienne clé du fichier HTML d'origine **doit** être considérée comme divulguée). |
| Clé email (fournisseur) suspectée divulguée | La révoquer chez le fournisseur, puis Paramètres > Email : ressaisir la clé (l'ancienne est écrasée, chiffrée). |
| Compte interne compromis | Paramètres > accès : « Supprimer » (désactivation immédiate, réversible) ; la révocation des refresh rend la session inutilisable. |
| Base corrompue / erreur | `npm run db:restore -- <dernier export>` (ou PITR Vercel) ; vérifier ensuite `npm run validate:step7` sur un clone. |

## 7. Validation

`npm run validate:step7` — **50 tests, 0 échec** sur Postgres réel (dont un
**deuxième Postgres** pour la restauration) : audit alimenté et sans données
personnelles, échecs de connexion audités, consultation + filtres + droits,
purge RGPD complète (confirmation, 403/400/404, cascade, anonymisation,
idempotence, audité), export (compteurs, tables, clé non exposée), restauration
(compteurs sur les 7 tables, contenu, hachés intacts), audit du front.
