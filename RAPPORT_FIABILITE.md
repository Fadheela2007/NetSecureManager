# Fiabilité en usage prolongé — rapport

**Date :** 10 août 2026
**Vérifications :** backend 16/16 `node --check`, tous les modules se chargent, serveur démarre. Frontend compile en 1,76 s (661 modules), `oxlint` 0 erreur et aucun nouvel avertissement.

| Point | État |
|---|---|
| 1 — Alerte agent muet | ✅ Implémenté (SQL requis) |
| 2 — Purge de `RELEVE` | ✅ Purge simple implémentée — agrégation écartée, argumenté |
| 3 — Débit des notifications | ✅ Trois protections, testées |
| 4 — Cloisonnement par site | ✅ Implémenté et testé — **change le comportement visible** |

---

## Point 1 — Agent distant muet

### Comment distinguer un site à agent d'un site scanné manuellement

C'est le choix central que vous me demandiez d'expliquer. **J'ai écarté l'ajout d'un drapeau `supervise_par_agent`** au profit d'une règle qui se configure toute seule :

> On ne surveille que les sites dont `dernier_push` **n'est pas NULL**, c'est-à-dire ceux qui ont déjà transmis au moins une fois.

Pourquoi c'est préférable à une case à cocher :

- **Zéro configuration.** Le premier push d'un agent inscrit le site à la surveillance. Aucune action manuelle, aucun oubli possible.
- **Pas de faux positif au démarrage.** Un site créé mais dont l'agent n'est pas encore installé ne déclenche rien — il n'a jamais rien promis.
- **Le site principal est exclu par construction.** Scanné depuis l'interface, il ne pousse jamais, sa colonne reste `NULL`.
- **Pas de désynchronisation.** Un drapeau coché à tort sur un site sans agent produirait une alerte permanente et ininterprétable.

`SITE.agent_token` ne pouvait pas servir de marqueur : `routes/sites.js` en génère un pour **tous** les sites à la création, il ne distingue donc rien.

**Limite assumée :** un agent installé mais qui n'a **jamais** réussi un seul push n'est pas détecté — le site n'a jamais existé aux yeux de la surveillance. C'est un problème d'installation, visible immédiatement au déploiement, pas une panne silencieuse en production.

### Modélisation : l'alerte porte sur un site, pas sur un équipement

Une panne d'agent ne concerne aucune machine en particulier. `ALERTE.id_equipement` devient donc facultatif et une colonne `id_site` est ajoutée (étape 2 de la migration).

**Effet de bord que j'ai dû traiter :** toutes les requêtes faisaient `JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement`. Un `INNER JOIN` aurait fait **disparaître silencieusement** les alertes de site de toutes les listes. J'ai converti en `LEFT JOIN` dans `GET /alertes`, `GET /incidents`, `GET /recherche` et les deux rapports, avec `COALESCE(a.id_site, e.id_site)` pour retrouver le site dans les deux cas.

> ⚠️ Le code et l'étape 2 de la migration vont de pair. Déployer l'un sans l'autre casse l'affichage des alertes.

### Fonctionnement

- `POST /api/agent/push` met à jour `SITE.dernier_push` (protégé par un `.catch()` : si la colonne n'existe pas encore, le push continue de fonctionner).
- Un cron toutes les 5 minutes compare `dernier_push` au seuil. Inutile d'aller plus vite, le seuil se compte en dizaines de minutes.
- **Une seule alerte active par site** : pas de réalerte à chaque passage.
- **Résolution automatique** dès qu'un push repasse sous le seuil.
- Nouveau `cause_code` `agent_muet` dans `suggestions.js`, avec 5 pistes — dont celle-ci, qui est le vrai piège : *« Tant que l'agent est muet, les équipements de ce site affichent leur dernier état connu : ne pas s'y fier pour conclure que le réseau va bien. »*

**Choix fait à votre place :** seuil par défaut à **30 minutes**. L'agent fourni scanne toutes les 2 à 5 minutes ; 30 minutes laissent passer plusieurs cycles ratés (redémarrage, scan long) sans crier au loup. Modifiable depuis la page Configuration.

---

## Point 2 — Purge de `RELEVE`

### Ce qui est en place

- Clé `retention_releves_jours` (défaut **30 jours**), modifiable depuis l'interface.
- Cron **horaire**, à la 20ᵉ minute — décalé pour ne pas tomber en même temps que la supervision (chaque minute) ni que l'escalade (toutes les 5 minutes).
- **Suppression par lots de 5 000 lignes**, plafonnée à 20 lots (100 000 lignes) par passage. Un `DELETE` unique sur une grosse table la verrouille et fait échouer les insertions du cycle de supervision.
- Journalisation du nombre supprimé, avec mention explicite quand le plafond est atteint.
- Verrou `purgeEnCours` contre le chevauchement.

**Choix fait à votre place :** 30 jours de rétention. Les graphiques de `EquipementDetail` couvrent 24 h et la route `/releves` est bornée à 30 jours côté code — conserver au-delà n'alimente aucun écran aujourd'hui.

**Point de performance à ne pas manquer :** la purge filtre sur `date_releve` seule. L'index existant `(id_equipement, date_releve)` **ne sert pas** ici, MySQL parcourrait toute la table à chaque lot. D'où l'index `idx_releve_date` en étape 4.

### Agrégation avant suppression : je ne l'ai pas faite, et voici pourquoi

Vous me demandiez de trancher. **Je recommande de s'en tenir à la purge simple**, pour trois raisons :

1. **Rien ne consommerait les données agrégées.** Il faudrait une table `RELEVE_HORAIRE`, un job d'agrégation, *et* modifier `EquipementDetail` pour lire dans deux sources selon la période demandée. L'écran actuel affiche 24 h — il ne lirait jamais l'agrégat.
2. **Le volume ne le justifie pas encore.** À 30 jours de rétention et 100 équipements, `RELEVE` se stabilise autour de 4,3 M lignes — beaucoup, mais parfaitement tenu par l'index composite. Le problème que vous avez rencontré n'était pas le volume en soi, c'était l'**absence totale de purge**.
3. **C'est irréversible.** Une moyenne horaire écrase les pics. Le pic de latence de 3 secondes à 14 h 07 qui explique un incident disparaît dans une moyenne à 180 ms. Sur un outil de diagnostic réseau, c'est précisément l'information qu'on vient chercher.

**Quand y revenir :** le jour où vous voudrez des tendances sur plusieurs mois (taux de disponibilité annuel, saisonnalité du trafic). À ce moment-là, la bonne approche est d'agréger **en plus** de garder le détail récent, pas à la place — et de porter la rétention détaillée à 7 jours plutôt que 30.

---

## Point 3 — Débit des notifications

Trois protections répondant chacune à un symptôme observé pendant vos tests.

### 1. Regroupement — contre la rafale

Les alertes sont mises en file par site et envoyées **par lot au bout de 20 secondes**. Dix équipements qui tombent ensemble produisent **un** e-mail récapitulatif numéroté, pas dix.

### 2. Plafond de débit — contre `Too many emails per second`

Au plus **10 messages par minute et par canal**, tous destinataires confondus. Fenêtre glissante.

### 3. Coupe-circuit — contre `Too many login attempts`

Après **5 échecs consécutifs** sur un canal, ce canal est **suspendu 15 minutes**. C'est précisément le martèlement d'un serveur qui refuse qui a fait verrouiller votre compte Gmail — continuer à réessayer aggrave le blocage au lieu de le résoudre.

### Vérifié par test

```
=== Coupe-circuit ===
  échec 1..4 -> canal disponible ? true
  Canal email suspendu 15 min après 5 échecs consécutifs.
  échec 5, 6 -> canal disponible ? false

=== Plafond de débit (10/min) ===
  après 12 envois -> disponible ? false   (attendu false)

=== Regroupement ===
  8 notifierAlerte() en 0 ms   (non bloquant, rend la main immédiatement)
  file vidée -> 1 seul récapitulatif
```

**Le « fire and forget » est conservé et même renforcé :** `notifierAlerte()` ne fait plus qu'empiler en mémoire et rendre la main — mesuré à 0 ms pour 8 alertes. L'envoi réel a lieu 20 secondes plus tard, hors du cycle de supervision.

### Sur l'exploitation de `NOTIFICATION`

Vous suggériez de l'utiliser pour éviter de réessayer indéfiniment. **J'ai préféré un compteur en mémoire.** Interroger la table à chaque envoi ajouterait une requête SQL sur le chemin critique pour reconstruire un état que le processus connaît déjà. La table garde tout son rôle d'audit *a posteriori* (« pourquoi Untel n'a rien reçu mardi ? »), qui est ce à quoi elle sert bien.

**Contrepartie assumée :** l'état du coupe-circuit est perdu au redémarrage du backend. Après un redémarrage, le premier lot repart, échoue 5 fois, et la coupure se réarme — soit 5 tentatives inutiles par redémarrage. Négligeable comparé à une requête SQL par envoi.

---

## Point 4 — Cloisonnement par site

**C'est le point qui change le comportement visible.** À lire avant de redémarrer.

### Règle appliquée

| `UTILISATEUR.id_site` | Portée |
|---|---|
| `NULL` | **Global** — voit tous les sites |
| `<n>` | **Rattaché** — ne voit que le site n |

Convention identique à celle déjà utilisée par `notificationService.getDestinataires()`.

La portée vient du **JWT signé par le serveur** — le client ne peut pas la manipuler. Tout le filtrage est fait en SQL côté serveur ; le frontend n'a été touché que pour l'ergonomie.

### Middleware centralisé

Plutôt que de disperser la logique, j'ai créé `middleware/porteeSite.js` — un seul endroit à auditer, et impossible d'oublier un cas de figure :

| Fonction | Rôle |
|---|---|
| `porteeDe(req)` | l'`id_site` de rattachement, ou `null` |
| `clauseSite(req, colonne)` | fragment SQL `(? IS NULL OR colonne = ?)` + params |
| `siteAutorise(req, idSite)` | contrôle avant écriture |
| `verifierAccesEquipement/Alerte/Incident` | contrôle par ressource |

Le motif `(? IS NULL OR colonne = ?)` évite deux requêtes distinctes : quand la portée est `NULL`, la condition est toujours vraie.

### Routes couvertes

**Listes filtrées** — `/equipements`, `/alertes`, `/incidents`, `/recherche` (les 3 sous-requêtes), `/plages`, `/sites`, `/utilisateurs`, `/logs`, `/rapport/pdf`, `/rapport/excel`

**Ressources contrôlées une par une** — `/equipements/:id/services`, `/interfaces`, `/releves`, `/vulnerabilites`, `/reveiller`, `/alertes/:id/resoudre`, `/incidents/:id`, `/incidents/:id/assigner`

**Écritures contrôlées avant action** — `POST /scan`, `POST /plages`, `DELETE /plages/:id`, `POST /sites`

**Choix de sécurité :** hors périmètre, je réponds **404 et non 403**. Un 403 confirmerait l'existence de la ressource à quelqu'un qui n'a pas à le savoir.

### Vérifié par test HTTP avec de vrais JWT

```
  site1  -> scanner le site 2      -> 403 "Vous n'êtes pas autorisé à scanner ce site"
  GLOBAL -> scanner le site 2      -> passe (500 ECONNREFUSED : base absente en test)
  site1  -> créer un site          -> 403 "Seul un administrateur global..."
  GLOBAL -> créer un site          -> passe
  site1  -> plage sur le site 2    -> 403 "Vous n'êtes pas autorisé à agir sur ce site"
```

**L'administrateur global continue de tout voir** — c'est vérifié ci-dessus, pas supposé.

### Effets de bord anticipés

**1. 🔴 Votre compte admin peut se retrouver enfermé.** Si `UTILISATEUR.id_site` est renseigné pour votre compte, vous ne verrez plus qu'un site après redémarrage. **L'étape 5 de la migration affiche qui est rattaché à quoi — à lancer avant de redémarrer.**

**2. Rôle et portée sont deux axes indépendants.** Un `admin` rattaché au site 2 est administrateur *du site 2*, pas de la plateforme. C'est cohérent, mais ce n'est peut-être pas ce que vous aviez en tête en créant les comptes.

**3. Création de site réservée aux admins globaux.** *Choix fait à votre place :* un admin rattaché ne peut plus créer de site — il ne pourrait de toute façon pas le consulter ensuite, ce qui produirait un site orphelin et invisible.

**4. Le sélecteur de site disparaît pour un utilisateur mono-site.** Il est remplacé par le nom du site en texte. Un menu déroulant à une entrée n'apporte rien.

**5. `GET /utilisateurs` inclut les comptes globaux.** Un opérateur du site 2 peut assigner un incident à un administrateur global — c'est voulu, ces comptes interviennent partout.

**6. `GET /logs` filtré par site de l'auteur.** Un admin rattaché voit l'activité des comptes de son site, des comptes globaux, et les actions système (`id_utilisateur NULL`).

**7. Sans données de test multi-sites, le cloisonnement ne se voit pas.** Si tous vos équipements sont sur un seul site, l'application se comportera exactement comme avant. C'est normal — ce n'est pas la preuve que le filtrage ne marche pas.

---

## SQL à exécuter — dans l'ordre

Tout est dans **`backend/migrations/2026-08-10-fiabilite-usage-prolonge.sql`**, commenté.

```sql
USE NetSecureManager;

-- 1. Trace du dernier contact de chaque agent
ALTER TABLE SITE
  ADD COLUMN dernier_push DATETIME NULL DEFAULT NULL AFTER agent_token;

-- 2. Alertes rattachées à un site (pannes d'agent)
--    ⚠ indissociable du code déployé : les JOIN sont devenus des LEFT JOIN
ALTER TABLE ALERTE MODIFY COLUMN id_equipement INT NULL;
ALTER TABLE ALERTE ADD COLUMN id_site INT NULL AFTER id_equipement;
ALTER TABLE ALERTE ADD CONSTRAINT fk_alerte_site
  FOREIGN KEY (id_site) REFERENCES SITE (id_site) ON DELETE CASCADE;
ALTER TABLE ALERTE ADD INDEX idx_alerte_site_type (id_site, type_alerte, statut);

-- 3. Nouvelles clés de configuration (apparaîtront dans l'écran Configuration)
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('seuil_agent_muet_minutes', '30', 'Durée (minutes) sans transmission avant alerte'),
  ('retention_releves_jours',  '30', 'Durée (jours) de conservation des relevés');

-- 4. Index de purge — sans lui, chaque lot parcourt toute la table
--    ⚠ peut prendre plusieurs minutes sur une table volumineuse
ALTER TABLE RELEVE ADD INDEX idx_releve_date (date_releve);
```

### 5. Vérification obligatoire avant redémarrage

```sql
SELECT id_utilisateur, nom, email, role, id_site,
       CASE WHEN id_site IS NULL THEN 'GLOBAL — voit tous les sites'
            ELSE CONCAT('limité au site ', id_site) END AS portee_apres_migration
FROM UTILISATEUR ORDER BY id_site IS NOT NULL, nom;

-- Pour faire d'un compte un administrateur de plateforme :
-- UPDATE UTILISATEUR SET id_site = NULL WHERE email = 'votre@email';
```

### 6. Recommandé — première purge manuelle

```sql
SELECT COUNT(*) AS total,
       SUM(date_releve < NOW() - INTERVAL 30 DAY) AS a_purger,
       MIN(date_releve) AS plus_ancien
FROM RELEVE;

-- À répéter tant que le compte renvoyé vaut 50000 :
DELETE FROM RELEVE WHERE date_releve < NOW() - INTERVAL 30 DAY LIMIT 50000;
```

Ne **pas** faire de `DELETE` sans `LIMIT` : la table resterait verrouillée et le cycle de supervision échouerait à insérer.

---

## Récapitulatif des choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Distinction agent / site manuel | `dernier_push IS NOT NULL` plutôt qu'un drapeau | Auto-configurant, aucun oubli possible |
| Seuil agent muet | 30 min | Absorbe plusieurs cycles ratés sans fausse alerte |
| Rétention des relevés | 30 jours | Aucun écran ne lit au-delà |
| Agrégation avant purge | Écartée | Rien ne la lirait ; écrase les pics utiles au diagnostic |
| Fréquence de purge | Horaire, 20ᵉ minute | Décalée des autres tâches |
| Plafond de purge | 100 000 lignes/heure | Évite de verrouiller la table |
| Fenêtre de regroupement | 20 s | Assez pour grouper une panne groupée, assez court pour rester réactif |
| Plafond d'envoi | 10/min/canal | Sous les limites des fournisseurs courants |
| Coupe-circuit | 5 échecs → 15 min | Évite l'aggravation du blocage |
| État du coupe-circuit | En mémoire, pas en base | Pas de requête SQL sur le chemin critique |
| Réponse hors périmètre | 404, pas 403 | Ne pas révéler l'existence de la ressource |
| Création de site | Admins globaux uniquement | Éviter les sites orphelins |

---

## Fichiers modifiés

**Backend** — `middleware/porteeSite.js` *(créé)*, `services/monitoringService.js`, `services/notificationService.js`, `services/suggestions.js`, `routes/scan.js`, `routes/sites.js`, `routes/plages.js`, `routes/rapports.js`, `server.js`

**Frontend** — `App.jsx` (sélecteur de site)

**Créé** — `backend/migrations/2026-08-10-fiabilite-usage-prolonge.sql`

Les nouvelles clés de configuration apparaîtront **automatiquement** dans la page Configuration : elle affiche tout le contenu de la table, aucune modification n'a été nécessaire.
