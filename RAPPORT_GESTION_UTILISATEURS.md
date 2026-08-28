# Interface de gestion des utilisateurs — rapport

**Date :** 10 août 2026

**Vérifications :** backend 17/17 `node --check`, frontend compile en 809 ms (20 fichiers), `oxlint` 0 erreur et aucun nouvel avertissement. Les 4 routes répondent 401 sans jeton. **31 tests de sécurité automatisés, 0 échec.**

**Migration SQL : aucune.** La table `UTILISATEUR` contient déjà tout le nécessaire (`nom`, `email`, `mot_de_passe_hash`, `role`, `id_site`, `telephone_whatsapp`), avec l'unicité sur `email` qui produit le `ER_DUP_ENTRY` attendu.

---

## Réponse à votre question : où était `GET /api/utilisateurs`

Elle était dans **`routes/scan.js`**, ajoutée lors de la session sur l'assignation des incidents. Je l'ai **déplacée dans `routes/utilisateurs.js`** avec le reste du CRUD, en conservant **exactement le même périmètre** (comptes du site + comptes globaux) pour ne pas casser le menu d'assignation d'`IncidentsPage`. Un commentaire dans `scan.js` indique le déplacement.

Un champ a été ajouté à la réponse : **`gerable`** (booléen), calculé côté serveur. Il indique si l'utilisateur courant a le droit de modifier cette ligne. Cela évite que le frontend réimplémente la règle de cloisonnement pour décider quels boutons afficher — le serveur reste seul juge, et revalide de toute façon chaque action.

---

## Les six règles de sécurité — testées, pas seulement codées

J'ai monté un banc de test qui substitue une base en mémoire à `src/db.js` et exerce les routes en HTTP réel. **31 assertions, 0 échec.**

### R3 — Dernier administrateur global : le point le plus délicat

```
=== R3 : dernier administrateur global ===
  OK   suppression du dernier admin global refusée (409)
  OK     message explicite
  OK     le compte existe toujours
  OK   rétrogradation du dernier admin global refusée (409)
  OK   rattachement du dernier admin global à un site refusé (409)
  OK     rôle inchangé en base

=== R3bis : avec DEUX admins globaux, l'opération passe ===
  OK   suppression d'un admin global sur deux autorisée
  OK   ...puis le dernier redevient protégé (409)
```

Trois voies mènent au verrouillage, les trois sont fermées :

1. **Suppression** du dernier admin global
2. **Changement de rôle** (`admin` → `operateur`/`lecteur`)
3. **Rattachement à un site** — plus subtil : le compte reste `admin` mais cesse d'être *global*, et il n'y a plus personne pour administrer la plateforme entière

**Protection contre la concurrence.** La vérification s'exécute dans une **transaction avec `SELECT ... FOR UPDATE`**. Sans cela, deux requêtes simultanées pourraient chacune constater qu'il reste deux admins globaux et les supprimer tous les deux. C'est improbable en usage normal, mais le résultat serait irrécupérable depuis l'interface — ça justifiait le verrou.

**Une découverte pendant les tests.** Mon premier scénario échouait, et l'analyse est instructive : quand il ne reste **qu'un** admin global, personne ne peut le supprimer de toute façon — lui-même est bloqué par R2, un admin rattaché par R4. La règle R3 sur la suppression n'est atteignable que dans un cas précis : **un jeton encore valide dont le compte a été supprimé entre-temps** (le JWT vit 8 h). C'est ce scénario que le test exerce désormais. La règle reste donc utile, mais pas pour la raison qu'on imagine — c'est sur la **rétrogradation** qu'elle protège au quotidien.

### R1 — Le hash ne fuite jamais

```
  OK   GET   : aucun mot_de_passe_hash
  OK   POST  : aucun hash dans la réponse
  OK   PATCH : aucun hash dans la réponse
```

Test renforcé : je vérifie l'absence du nom de colonne **et** de toute chaîne commençant par `$2` (préfixe bcrypt). Aucune requête du fichier ne fait `SELECT *` — toutes les projections sont explicites, y compris la relecture après création.

### R2 — Auto-suppression

```
  OK   suppression de son propre compte refusée (400)
  OK     message explicite
```

Côté interface, le bouton est désactivé avec une infobulle, et la ligne porte la mention « vous ».

### R4 — Cloisonnement

```
  OK   admin site1 ne peut pas supprimer un compte du site 2 (404)
  OK     le compte du site 2 existe toujours
  OK   admin site1 ne peut pas modifier un compte du site 2 (404)
  OK   admin site1 ne peut pas supprimer l'admin global (404)
  OK   admin site1 ne peut pas créer de compte global (403)
  OK   admin site1 ne peut pas créer sur le site 2 (403)
  OK   admin site1 PEUT créer sur son propre site (201)
  OK   admin site1 PEUT supprimer un compte de son site (200)
```

**404 en lecture/modification, 403 en création** — distinction volontaire. Sur une ressource existante, un 403 confirmerait son existence à quelqu'un qui n'a pas à le savoir. Sur une création, il n'y a rien à dissimuler et un message explicite est plus utile.

Un admin rattaché **peut** créer un `admin` pour son propre site : il devient administrateur *de ce site*, conformément à la séparation rôle/portée établie précédemment.

### R5 et R6 — Validations

```
  OK   e-mail invalide refusé (400)
  OK   mot de passe < 8 caractères refusé (400)
  OK   e-mail déjà utilisé -> 409 avec message clair
  OK   rôle invalide refusé (400)
  OK   WhatsApp au mauvais format refusé (400)
  OK   WhatsApp au bon format accepté (201)
```

### Mot de passe : un champ vide ne l'efface pas

```
  OK   hash inchangé quand mot_de_passe est vide
  OK     le nom a bien été modifié
  OK   hash remplacé quand un mot de passe est fourni
```

C'est le piège classique des formulaires de modification. La condition est `if (mot_de_passe)` — une chaîne vide est falsy, la colonne n'est donc pas incluse dans le `UPDATE`. Le frontend n'envoie même pas le champ s'il est vide.

---

## Numéro WhatsApp

Triple rappel du format attendu par l'API Meta :

- **Placeholder** dans le champ : `237691234567`
- **Aide sous le formulaire** : « Format international sans le « + » — ex. 237691234567. Un format incorrect fait échouer l'envoi des alertes sans message d'erreur visible. »
- **Validation serveur** `/^\d{8,15}$/` — refuse `+237 691 23 45 67` avec un message qui rappelle le format

La validation serveur est le vrai garde-fou : c'est elle qui empêche d'enregistrer un numéro qui échouerait silencieusement au moment où une alerte critique doit partir.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Emplacement de `GET /utilisateurs` | Déplacée de `scan.js` vers `utilisateurs.js` | Cohérence du CRUD ; périmètre inchangé pour ne pas casser `IncidentsPage` |
| Champ `gerable` | Ajouté à la réponse | Le frontend ne réimplémente pas la règle de cloisonnement |
| Modification | En place, dans le même formulaire | Cohérent avec `PlagesPage` et `ConfigurationPage` ; évite une fenêtre modale que le projet n'utilise nulle part ailleurs |
| Longueur minimale | 8 caractères | Valeur que vous suggériez ; c'est la seule protection de l'application |
| `id_site` dans la réponse de login | **Ajouté** | Voir l'effet de bord n° 1 ci-dessous |
| Transaction + `FOR UPDATE` | Sur PATCH et DELETE | Le verrouillage de plateforme est irréversible, un check-then-act ne suffisait pas |
| 404 vs 403 | 404 sur ressource existante, 403 sur création | Ne pas révéler l'existence d'un compte hors périmètre |
| Rôles autorisés | `admin`, `operateur`, `lecteur` | Valeurs de l'`ENUM` de la colonne `role` |
| Accès aux routes | `GET` : admin + opérateur — `POST`/`PATCH`/`DELETE` : admin | L'opérateur a besoin de la liste pour assigner un incident, pas de la gérer |

---

## Effets de bord anticipés

### 1. `auth.js` renvoie désormais `id_site` — reconnexion nécessaire

`POST /api/auth/login` ne renvoyait pas `id_site` dans l'objet `utilisateur`. Sans lui, un **admin rattaché à un site voyait à tort l'option « Global — tous les sites »** dans le menu déroulant, et recevait un 403 en validant. Je l'ai ajouté.

**Conséquence :** les sessions déjà ouvertes ont un `localStorage.utilisateur` sans `id_site`. Ces utilisateurs seront traités comme globaux **par l'affichage** jusqu'à leur reconnexion. Le serveur, lui, lit le JWT et refuse correctement — aucune faille, seulement un menu qui propose une option rejetée. **Se déconnecter/reconnecter une fois suffit.**

### 2. La page est visible par tous, mais inerte pour les non-admins

L'entrée « Utilisateurs » apparaît dans le menu pour tout le monde. Un opérateur voit la liste (il y a déjà accès via l'assignation d'incidents) mais **aucun formulaire ni bouton**. Un lecteur reçoit un 403 sur `GET /utilisateurs` et voit un message d'erreur.

*Je n'ai pas masqué l'entrée de menu selon le rôle* — `Sidebar.jsx` n'a aujourd'hui aucune logique de ce type et l'introduire dépasse le périmètre. Dites-le moi si vous préférez.

### 3. Le premier compte reste à créer hors interface

Cette page ne résout pas l'amorçage : il faut déjà un admin pour créer un admin. Le premier compte passe toujours par `POST /api/auth/register` — **route qui est encore ouverte à tous et accepte `role` depuis le corps de la requête.** C'est la faille P0 signalée lors du premier audit et toujours non corrigée. Maintenant que la gestion des comptes existe dans l'interface, **plus rien ne justifie de la laisser ouverte** : c'est le moment de la fermer.

### 4. Supprimer un compte n'invalide pas son jeton

Un JWT reste valide jusqu'à 8 h après suppression du compte. La personne conserve son accès jusqu'à expiration. C'est inhérent aux JWT sans liste de révocation. Pour une révocation immédiate il faudrait vérifier l'existence du compte à chaque requête (une requête SQL par appel) ou tenir une liste noire.

### 5. Suppression et données liées

`INCIDENT.id_utilisateur_assigne` et `LOG_ACTIVITE.id_utilisateur` sont en `ON DELETE SET NULL` : supprimer un compte ne détruit ni les incidents ni le journal, les entrées deviennent simplement anonymes. C'est le comportement souhaitable pour une piste d'audit.

### 6. Changer le site d'un utilisateur change ce qu'il voit

Rattacher un compte global à un site restreint immédiatement sa visibilité (au prochain jeton). L'effet est voulu, mais il peut surprendre : la personne « perd » des données qui n'ont pas disparu.

---

## SQL à exécuter

**Aucune migration nécessaire.** Deux requêtes de contrôle, facultatives :

```sql
USE NetSecureManager;

-- 1. Vérifier qu'il existe bien au moins un administrateur global.
--    Si cette requête renvoie 0 ligne, la protection du « dernier admin »
--    n'a rien à protéger et personne ne peut administrer la plateforme.
SELECT id_utilisateur, nom, email
FROM UTILISATEUR
WHERE role = 'admin' AND id_site IS NULL;

-- 2. Repérer les numéros WhatsApp au mauvais format.
--    Ces comptes ne reçoivent aucune alerte WhatsApp, en silence.
--    Le format attendu : international sans « + » (ex. 237691234567).
SELECT id_utilisateur, nom, email, telephone_whatsapp
FROM UTILISATEUR
WHERE telephone_whatsapp IS NOT NULL
  AND telephone_whatsapp NOT REGEXP '^[0-9]{8,15}$';
```

Si la première requête ne renvoie rien :

```sql
-- Promouvoir un compte existant en administrateur global :
-- UPDATE UTILISATEUR SET role = 'admin', id_site = NULL WHERE email = 'votre@email';
```

---

## Fichiers

**Créés** — `backend/src/routes/utilisateurs.js`, `frontend/src/Components/UtilisateursPage.jsx`

**Modifiés** — `backend/src/server.js` (montage), `backend/src/routes/scan.js` (route déplacée), `backend/src/routes/auth.js` (`id_site` dans la réponse), `frontend/src/App.jsx`, `frontend/src/Components/Sidebar.jsx`

---

## Test manuel suggéré

1. Se connecter en admin global, ouvrir **Utilisateurs**.
2. Créer un compte opérateur rattaché à un site, avec un WhatsApp au format `2376...`.
3. Essayer un mot de passe de 5 caractères → refus explicite.
4. Réutiliser un e-mail existant → « Cet e-mail est déjà utilisé par un autre compte ».
5. Modifier ce compte **en laissant le mot de passe vide** → le reste change, la connexion continue de fonctionner avec l'ancien mot de passe.
6. Essayer de vous rétrograder si vous êtes le seul admin global → refus avec message.
7. Essayer de supprimer votre propre compte → bouton désactivé.
8. Se connecter avec le compte rattaché : le sélecteur de site ne montre que son site, et la page Utilisateurs n'affiche aucun bouton pour les comptes hors périmètre.
