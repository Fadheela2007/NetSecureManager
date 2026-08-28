# Alignement de `schema.sql` sur la base réelle

**Date :** 10 août 2026
**Règle appliquée :** la base de données réelle fait foi. Aucune colonne existante n'a été renommée, aucune table de production modifiée.

---

## ⚠ Ce que je n'ai pas pu faire — à lire en premier

Vous me demandiez de **vérifier d'abord par moi-même** via un script `SHOW CREATE TABLE`. **Je n'ai pas pu.** Mon environnement d'exécution est un conteneur Linux isolé ; votre MySQL tourne sur `localhost` sous Windows. Quatre routes tentées, quatre échecs :

```
localhost              -> ECONNREFUSED
127.0.0.1              -> ECONNREFUSED
host.docker.internal   -> EAI_AGAIN
172.17.0.1             -> ENETUNREACH
```

**Conséquence directe :** le `schema.sql` régénéré reproduit **votre tableau de divergences**, que vous qualifiez vous-même d'« aide » et non de source de vérité. Il n'est donc pas encore vérifié contre MySQL.

Pour lever ce doute, j'ai écrit le script que vous demandiez :

```bash
cd backend
node tools/introspecter-base.js
```

Il produit `backend/tools/schema-reel.sql` : la sortie brute de `SHOW CREATE TABLE` pour les 14 tables, plus le détail `SHOW FULL COLUMNS` (types exacts, nullabilité, défauts, valeurs d'ENUM) et le contenu actuel de `CONFIGURATION` et `TYPE_EQUIPEMENT`. **Transmettez-moi ce fichier et je réaligne `schema.sql` à l'identique, sans aucune interprétation.**

En attendant, l'en-tête de `schema.sql` porte cet avertissement, avec la consigne explicite de trancher toute divergence en faveur de `schema-reel.sql`.

---

## Les 17 corrections appliquées

| # | Élément | Ancien (inventé) | Corrigé (base réelle) |
|---|---|---|---|
| 1 | `TYPE_EQUIPEMENT` PK | `id_type_equipement` | `id_type` |
| 2 | `EQUIPEMENT` FK type | `id_type_equipement` | `id_type` |
| 3 | `EQUIPEMENT` clé unique | `uk_equipement_site_ip` | `uniq_ip_site` |
| 4 | `EQUIPEMENT` date création | `date_creation` | `date_ajout` |
| 5 | `EQUIPEMENT` | — | `modele VARCHAR(150)` ajoutée |
| 6 | `SITE` | — | `adresse VARCHAR(255)` ajoutée |
| 7 | `SITE` SNMPv3 | 3 colonnes ici | déplacées vers `PLAGE_SCAN` |
| 8 | `RELEVE` | — | `temperature_c DECIMAL(5,2)` ajoutée |
| 9 | `VULNERABILITE_CONNUE` sévérité | `'elevee'` | `'haute'` |
| 10 | `VULNERABILITE_CONNUE` unique | `uk_vuln_cve_port` | contrainte retirée |
| 11 | `NOTIFICATION` statut | `'envoyee'` | `'envoye'` |
| 12 | `INCIDENT` | — | `id_utilisateur_assigne INT` ajoutée |
| 13 | `INCIDENT` unique | `uk_incident_alerte` | contrainte retirée |
| 14 | `SERVICE_DETECTE` unique | `uk_service_equipement_port` | `uniq_equip_port` |
| 15 | `PLAGE_SCAN` | `libelle`, `dernier_scan` | `snmp_version ENUM`, `actif BOOLEAN`, + 3 colonnes SNMPv3 |
| 16 | `LOG_ACTIVITE.action` | `VARCHAR(60)` | `VARCHAR(200)` |
| 17 | `CONFIGURATION` | 2 entrées | 3 entrées (+ `intervalle_scan_minutes`) |

**Validation :** le fichier parse sans erreur en dialecte MySQL (19 instructions). **Aucun `DROP`** d'aucune sorte. Les 5 anciens noms erronés ont disparu du code SQL actif.

---

## Vérification du code : aucune requête cassée

J'ai passé en revue les 43 requêtes SQL de `backend/src/`. **Aucune ne référence une colonne inexistante.** Détail sur les points sensibles :

| Élément renommé/déplacé | Impact sur le code |
|---|---|
| `id_type_equipement` → `id_type` | ✅ **Aucun** — le code n'écrit jamais cette colonne (voir ci-dessous) |
| `date_creation` → `date_ajout` sur `EQUIPEMENT` | ✅ **Aucun** — `date_creation` n'est utilisée que sur `ALERTE` (alias `a.`, dans `rapports.js`, `scan.js`, `monitoringService.js`). Jamais sur `EQUIPEMENT`. |
| SNMPv3 `SITE` → `PLAGE_SCAN` | ✅ **Aucun** — aucune requête ne lit ces colonnes |
| `'elevee'` → `'haute'` | ✅ **Aucun** — aucune valeur d'ENUM n'est codée en dur. `GET /vulnerabilites` fait `SELECT *`, le frontend affiche `v.severite` tel quel |
| `'envoyee'` → `'envoye'` | ✅ **Aucun** — rien n'écrit dans `NOTIFICATION` |
| `modele`, `adresse`, `temperature_c`, `id_utilisateur_assigne` | ✅ **Aucun** — colonnes jamais lues ni écrites |
| `snmp_version`, `actif` | ✅ **Aucun** — `PLAGE_SCAN` n'est lue nulle part |
| `LOG_ACTIVITE.action` en `VARCHAR(200)` | ✅ **Aucun** — les valeurs insérées sont courtes (`scan_lance`, `incident_modifie`, `alerte_resolue`, `connexion`) |

Autrement dit : **les divergences ne cassaient rien** parce que les colonnes concernées sont précisément celles que le code n'utilise pas. Le `schema.sql` était faux, mais silencieusement.

---

## Constat nouveau : `intervalle_scan_minutes` ne sert à rien

En intégrant la troisième entrée de `CONFIGURATION`, j'ai vérifié son usage. **Aucun code ne la lit.**

```
Clés effectivement lues par getConfig() :
  seuil_echecs_avant_alerte   (monitoringService.js:88)
  seuil_escalade_minutes      (monitoringService.js:130)

Recherche de "intervalle_scan" dans backend/src/ : aucun résultat.
```

Les planifications sont codées en dur :

```js
cron.schedule("* * * * *",   ...)   // supervision      monitoringService.js:164
cron.schedule("*/5 * * * *", ...)   // escalade         monitoringService.js:179
cron.schedule(`*/${SCAN_INTERVAL_MINUTES} * * * *`, ...)  // agent, via son .env
```

**Conséquence utilisateur :** le paramètre s'affiche dans l'écran Configuration, il est modifiable, l'interface confirme « Paramètre mis à jour »… et rien ne change. C'est un réglage fantôme.

Je ne l'ai **pas corrigé** : le brancher implique de recharger dynamiquement une tâche cron, ce qui change le comportement du service. Trois options possibles, à votre choix :

1. Le retirer de la table (le plus honnête si le besoin n'existe pas).
2. Le griser dans l'interface avec une mention « non applicable ».
3. Le brancher réellement : `cron.schedule` relancé au changement, ou lecture de la valeur à chaque cycle avec un compteur.

L'entrée est documentée comme telle dans `schema.sql`.

---

## Rappel — signalés, non corrigés

Ces points restent valables et ne sont pas liés à l'alignement du schéma :

- **`PLAGE_SCAN` n'est lue par aucun code.** Cela prend un relief nouveau maintenant que les identifiants SNMPv3 y résident : la table qui devrait piloter les scans (CIDR, communauté, version SNMP, actif/inactif) est ignorée, et les CIDR sont saisis à la main dans `ScanLauncher` et dans le `.env` de chaque agent. **SNMPv3 ne peut donc pas fonctionner** — non par manque de matériel, mais parce que rien ne lit ses identifiants.
- **`INTERFACE_RESEAU`, `NOTIFICATION`, `TYPE_EQUIPEMENT`** : jamais écrites. Pour `TYPE_EQUIPEMENT`, `fingerprint()` calcule pourtant le type et `routes/scan.js` ne l'insère pas — `EQUIPEMENT.id_type` reste toujours `NULL`.

---

## Contraintes recommandées — à décider, non appliquées

Conformément à votre consigne, ces deux `ALTER TABLE` sont fournies **en commentaire** dans `schema.sql` (section « RECOMMANDATIONS ») et signalées par `verifier-schema.js`.

### 1. `INCIDENT` — unicité de `id_alerte`

`escaladeIncidents()` évite déjà les doublons via `AND id_alerte NOT IN (SELECT id_alerte FROM INCIDENT)`. Cela fonctionne, mais reste vulnérable à une exécution concurrente : deux cycles simultanés peuvent lire la même liste avant d'insérer. Le verrou `escaladeEnCours` ajouté lors de l'audit couvre ce cas **au sein d'un processus** ; une contrainte le couvrirait aussi **entre plusieurs instances** du backend.

```sql
-- Vérifier d'abord l'absence de doublons (l'ALTER échouera sinon) :
SELECT id_alerte, COUNT(*) c FROM INCIDENT GROUP BY id_alerte HAVING c > 1;

-- Si aucun résultat :
-- ALTER TABLE INCIDENT ADD UNIQUE KEY uk_incident_alerte (id_alerte);
```

### 2. `VULNERABILITE_CONNUE` — unicité de `(cve_id, port)`

Sans elle, réexécuter le script d'insertion des CVE duplique chaque ligne, et `GET /api/equipements/:id/vulnerabilites` affiche la même vulnérabilité plusieurs fois.

```sql
-- Vérifier d'abord :
SELECT cve_id, port, COUNT(*) c FROM VULNERABILITE_CONNUE
  GROUP BY cve_id, port HAVING c > 1;

-- Si aucun résultat :
-- ALTER TABLE VULNERABILITE_CONNUE ADD UNIQUE KEY uk_vuln_cve_port (cve_id, port);
```

### Distinction importante

Ces deux contraintes sont **facultatives**. Deux autres, en revanche, sont **indispensables au bon fonctionnement** et doivent exister :

- `EQUIPEMENT (id_site, adresse_ip)` → `uniq_ip_site`
- `SERVICE_DETECTE (id_equipement, port)` → `uniq_equip_port`

Le code fait `INSERT ... ON DUPLICATE KEY UPDATE` dessus. Si elles manquent, **chaque scan duplique les lignes en silence**. `verifier-schema.js` les contrôle et distingue clairement les deux catégories : « index uniques requis » (bloquant) et « contraintes recommandées » (à décider).

---

## Fichiers modifiés

| Fichier | Nature |
|---|---|
| `backend/schema.sql` | Régénéré — 17 corrections, avertissement de vérification en en-tête, `ALTER TABLE` recommandées en commentaire |
| `backend/tools/introspecter-base.js` | **Créé** — `SHOW CREATE TABLE` des 14 tables → `tools/schema-reel.sql` |
| `backend/tools/verifier-schema.js` | Mis à jour — noms réels (`id_type`, `uniq_ip_site`, `uniq_equip_port`), SNMPv3 retiré de `SITE`, nouvelle section « contraintes recommandées » |

Aucun fichier de `backend/src/` n'a été modifié : le code était déjà correct vis-à-vis de la base réelle.

---

## Prochaine étape

```bash
cd backend
node tools/introspecter-base.js     # produit tools/schema-reel.sql
node tools/verifier-schema.js       # contrôle code ↔ base
```

Transmettez-moi `schema-reel.sql` et je réaligne `schema.sql` sur la sortie brute de MySQL, ce qui retirera l'avertissement de son en-tête.
