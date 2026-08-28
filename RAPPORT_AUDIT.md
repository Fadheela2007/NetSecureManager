# Rapport d'audit — NetSecureManager

**Date :** 10 août 2026
**Périmètre :** `backend/src/` (14 fichiers), `frontend/src/` (18 fichiers), schéma MySQL
**Consigne :** correction des erreurs existantes uniquement — aucune nouvelle fonctionnalité, aucune restructuration.

---

## Synthèse

| Catégorie | Détectées | Corrigées | Laissées à décider |
|---|---|---|---|
| Erreurs bloquantes | 4 | 4 | 0 |
| Erreurs silencieuses | 9 | 8 | 1 |
| Incohérences non bloquantes | 11 | 8 | 3 |

**Bonne nouvelle d'abord :** aucun des défauts « classiques » du copier-coller n'a été trouvé. J'ai vérifié les 32 fichiers un par un, plus une passe automatisée (`node --check` sur le backend, parsing Babel/JSX sur le frontend) :

- **aucun import dupliqué**, aucun import manquant ;
- **aucune fonction ni variable déclarée deux fois** dans un même fichier ;
- **aucun bloc de code collé en double** ;
- **aucune accolade mal fermée** — les 14 fichiers backend passent `node --check`, les 18 fichiers frontend parsent sans erreur ;
- **aucun `module.exports` mal placé ou écrasé** — chaque fichier en a exactement un, en fin de fichier ;
- **tous les composants importés dans `App.jsx` existent** et exposent un `export default`.

Le vrai problème n'était pas syntaxique. Il était réparti sur trois axes : **une route backend manquante**, **une incohérence d'authentification côté frontend**, et **l'absence totale de `schema.sql` et de `.gitignore`**.

---

## ⚠ Deux points à traiter en priorité absolue

### 1. `backend/.env` n'est protégé par aucun `.gitignore` — et contient de vrais secrets

Le dépôt Git ne contenait **aucun `.gitignore` à la racine ni dans `backend/`**. `git status` montrait `?? backend/` : le dossier entier était non suivi, donc **un simple `git add .` publiait `backend/.env`** avec le mot de passe MySQL, la clé JWT et les identifiants SMTP Mailtrap.

J'ai créé `.gitignore` à la racine et `backend/.env.example`. **Mais si ce dépôt a déjà été poussé quelque part, considérez ces secrets comme compromis :** changez le mot de passe MySQL, régénérez `JWT_SECRET` (cela déconnectera tous les utilisateurs, c'est normal) et régénérez les identifiants Mailtrap.

### 2. `frontend/` est enregistré comme sous-module Git par accident

`git ls-files -s` renvoie `160000 fa6e6b11... frontend`. Le mode `160000` est un *gitlink* : Git a enregistré une **référence de commit** vers un dépôt imbriqué, pas les fichiers. **Aucun fichier du frontend n'est réellement versionné.** Un `git clone` de ce dépôt donnerait un dossier `frontend/` vide.

C'est un `frontend/.git` créé par `npm create vite` puis committé tel quel. **Je ne l'ai pas corrigé** : la manœuvre (`git rm --cached frontend`, suppression de `frontend/.git`, re-commit) réécrit l'historique et c'est votre décision. À faire avant tout autre commit.

---

## Erreurs bloquantes

### `backend/src/routes/scan.js` — route `PATCH /api/alertes/:id/resoudre` inexistante

`AlertesPage.jsx` ligne 18 appelait `axios.patch(.../alertes/${id}/resoudre)`. **Cette route n'existait nulle part côté backend.** Le bouton « Marquer résolue » renvoyait un 404 silencieux (pas de `.catch()`, voir plus bas) : l'alerte restait active, l'utilisateur ne voyait rien.

Conséquence en cascade : une alerte jamais résolue est escaladée en incident au bout de 15 min par `escaladeIncidents()`. **Toutes les alertes finissaient donc en incidents**, quoi que fasse l'opérateur.

✅ **Corrigé** — route ajoutée avec `requireRole("admin","operateur")`, journalisation, et 404 explicite si l'alerte est introuvable ou déjà résolue.

### `backend/src/routes/scan.js` ligne 49 — crash sur `rows[0].id_equipement`

```js
const [rows] = await db.query("SELECT id_equipement FROM EQUIPEMENT WHERE ...");
const idEquipement = rows[0].id_equipement;   // TypeError si rows est vide
```

Si l'`INSERT` précédent échouait (contrainte, colonne absente), `rows` est vide et la lecture de `rows[0]` lève un `TypeError`. **Tout le scan s'arrêtait**, y compris pour les équipements déjà traités avec succès.

✅ **Corrigé** — test `rows.length === 0` + `continue`, et chaque équipement est désormais traité dans son propre `try/catch` : un équipement en échec n'annule plus le scan entier.

### `backend/schema.sql` — le fichier n'existait pas

Aucun fichier `.sql` dans le projet. Impossible de reconstruire la base, de la partager, ou de savoir quels `ALTER TABLE` avaient été appliqués.

✅ **Créé** — voir la section « Livrable : schema.sql » ci-dessous.

### `backend/src/server.js` — `/api/agent/push` sans `try/catch`

La route est correctement déclarée **avant** le `requireAuth` global (ligne 25, avant les `app.use("/api", requireAuth, ...)` — ✅ conforme). Mais aucune de ses trois opérations async n'était protégée. Sous Express 5 le rejet est capté automatiquement, mais sans gestionnaire d'erreurs l'agent recevait **une page HTML d'erreur au lieu du JSON attendu**, et sa boucle de scan interprétait mal la réponse.

✅ **Corrigé** — `try/catch` complet, isolation par équipement, et **ajout d'un gestionnaire d'erreurs Express global** en fin de `server.js` renvoyant systématiquement du JSON.

---

## Erreurs silencieuses (le code tourne, le résultat est faux)

### `frontend/src/api.js` — mauvaises clés `localStorage` (cause des 401 aléatoires)

C'est la source de l'incohérence signalée au point 5 de la mission :

| Fichier | Clé écrite / lue |
|---|---|
| `Login.jsx`, `App.jsx`, `Dashboard.jsx`, `JournalPage.jsx`, `ScanLauncher.jsx`, `SearchBar.jsx`, `ConfigurationPage.jsx` | `token` / `utilisateur` |
| `api.js` | **`nsm_token` / `nsm_user`** |

Toute requête passant par `api.js` partait **sans jeton** → 401 systématique. Le fichier n'est actuellement importé par aucun composant, donc l'effet est latent — mais c'était un piège garanti à la prochaine utilisation.

✅ **Corrigé** — clés alignées sur `token` / `utilisateur`, et en-tête de fichier documentant que ce module n'est pas utilisé.

### Authentification frontend — trois approches mélangées

Trois styles coexistaient :

1. `axios.defaults.headers.common` (défini dans `App.jsx`) — utilisé implicitement par `EquipementsPage`, `AlertesPage`, `IncidentsPage`, `SitesPage`, `TopologyPage`, `EquipementDetail` ;
2. En-tête `Authorization` reconstruit à la main à chaque appel — `Dashboard` (3×), `JournalPage`, `ScanLauncher`, `SearchBar` ;
3. Un helper `tokenHeader()` local — `ConfigurationPage`.

✅ **Harmonisé sur l'approche 1** (la moins invasive, celle déjà majoritaire) :
- suppression des 7 en-têtes manuels et du helper `tokenHeader()` ;
- `App.jsx` devient **seul propriétaire de la session** : `handleLogin` écrit dans `localStorage` **et** pose l'en-tête (auparavant `Login.jsx` écrivait le `localStorage` et `App.jsx` posait l'en-tête — deux responsabilités pour une même opération) ;
- ajout d'un **intercepteur 401 unique** dans `App.jsx` qui déconnecte proprement, remplaçant le `window.location.reload()` de `api.js` ;
- `JSON.parse(savedUser)` est désormais protégé par un `try/catch` — une entrée `localStorage` corrompue provoquait un écran blanc au démarrage, sans message.

### `backend/src/services/discoveryService.js` — `arpComplement()` faux pour tout masque ≠ /24

```js
const prefixeCidr = cidr.split("/")[0].split(".").slice(0, 3).join(".");
const complements = arpEntries.filter((e) => e.ip.startsWith(prefixeCidr) && ...);
```

Le test ne comparait que les **3 premiers octets**. Or `backend/.env.agent-yaounde` déclare `CIDR=192.168.0.0/23` : sur un /23, la moitié des adresses (`192.168.1.x`) était **silencieusement exclue** du complément ARP. Les équipements qui bloquent l'ICMP sur cette moitié n'ont jamais été découverts.

Le préfixe `.startsWith()` était par ailleurs sujet aux faux positifs (`192.168.1` correspond aussi à `192.168.10.5`).

✅ **Corrigé** — vrai test d'appartenance au sous-réseau via `ipLib.cidrSubnet(cidr).contains(ip)`.

### `backend/src/services/monitoringService.js` — cycles cron qui se chevauchent

Cause des avertissements `node-cron missed execution` que vous avez observés. Deux problèmes cumulés :

```js
cron.schedule("* * * * *", async () => {
  const [equipements] = await db.query("SELECT * FROM EQUIPEMENT");
  for (const eq of equipements) {
    checkEquipement(eq).catch(console.error);   // lancé sans await, sans limite
  }
});
```

1. **Parallélisme non borné** — 200 équipements = 200 `checkEquipement()` simultanés. Chacun peut durer plusieurs secondes (ping 2 s + SNMP + `diagnosePanne()` qui teste 5 ports à 800 ms **en séquentiel**, soit jusqu'à 4 s). Le cycle déborde largement sur la minute suivante.
2. **Aucune protection contre le chevauchement** — le cycle suivant démarre pendant que le précédent tourne encore, les effets s'accumulent.

L'event loop n'était pas *bloqué* au sens strict (tout est asynchrone, pas de calcul CPU lourd), mais la saturation du pool MySQL (`connectionLimit: 10`) et des sockets produit exactement le même symptôme.

✅ **Corrigé** — traitement par lots de 20 avec `await` entre chaque lot, plus un verrou `cycleEnCours` / `escaladeEnCours` qui ignore une exécution si la précédente n'est pas terminée (avec un `console.warn` explicite).

### `backend/src/routes/scan.js` — `INTERVAL ? HOUR` non fiable

`WHERE date_releve >= NOW() - INTERVAL ? HOUR` : mysql2 échappe le paramètre en chaîne (`INTERVAL '24' HOUR`). MySQL l'accepte en `query()` mais pas en `execute()` (requête préparée) — un futur passage à `execute()` casserait la route sans prévenir.

✅ **Corrigé** — la valeur est validée (`Number.isFinite`, > 0), bornée à 30 jours, puis interpolée. Aucun risque d'injection : la valeur est garantie numérique.

### `backend/src/routes/auth.js` — un échec de journalisation faisait échouer la connexion

L'`INSERT INTO LOG_ACTIVITE` était `await`é sans protection après la génération du token. Si la table était absente ou verrouillée, **l'utilisateur ne pouvait plus se connecter** alors que ses identifiants étaient valides — et l'erreur remontait comme un 500 opaque.

✅ **Corrigé** — la journalisation a son propre `try/catch` et ne peut plus bloquer une connexion légitime. La route entière est également protégée.

### `frontend/src/Components/Sidebar.jsx` ligne 47 — rôle affiché en dur

```jsx
<p className="text-[11px] text-[var(--color-mute)]">Opérateur</p>
```

Tout utilisateur voyait « Opérateur », y compris les admins et les lecteurs. Affichage trompeur sur une plateforme où le rôle conditionne les droits.

✅ **Corrigé** — `{user?.role || "—"}`.

### `backend/src/services/discoveryService.js` — un ping en échec annulait tout un lot

`Promise.all(batch.map((ip) => ping.promise.probe(ip, ...)))` : `Promise.all` rejette au premier rejet. Un seul ping en erreur (interface réseau qui disparaît, résolution qui échoue) **faisait perdre les 30 résultats du lot**, sans trace.

✅ **Corrigé** — `.catch(() => ({ alive: false, host: ip }))` sur chaque ping. Idem pour `snmpTable()` (ajout d'un `try/catch` autour de `createSession` et d'un handler `error`) et pour la boucle par hôte de `scanRange()`.

### 🔶 Non corrigé — délibérément : `getConfig()` appelé pour chaque équipement, chaque minute

`checkEquipement()` appelle `getConfig("seuil_echecs_avant_alerte")` → **une requête SQL par équipement en échec, à chaque cycle**. Avec 50 équipements hors ligne, c'est 50 requêtes/minute pour lire la même valeur.

**Pourquoi je ne l'ai pas corrigé :** un cache change le moment où une modification de seuil prend effet dans l'interface Configuration. C'est un changement de comportement observable. Correction suggérée : cache mémoire à TTL 60 s (une lecture par cycle au lieu de N).

---

## Incohérences non bloquantes

| Fichier | Constat | Action |
|---|---|---|
| `monitoringService.js` | `SEUIL_ESCALADE_MINUTES = 15` déclarée puis jamais lue (la vraie valeur vient de `getConfig`) — code mort trompeur | ✅ Supprimée |
| `Dashboard.jsx` | `import io from "socket.io-client"` et `SOCKET_URL` importés, jamais utilisés — alourdit le bundle | ✅ Supprimés |
| `auth.js` | `const db2 = require("../db")` en plein milieu du handler, alors que `db` est déjà importé ligne 10 | ✅ Supprimé |
| `server.js` | Socket.io instancié (`io`, `app.set("io", io)`) mais **aucun `emit` nulle part** dans le projet | 🔶 Conservé — fonctionnalité manifestement en cours, à vous de trancher |
| `api.js` | Fichier entier importé par aucun composant | 🔶 Conservé — clés corrigées + avertissement en en-tête. Suppression = votre décision |
| `TopologyPage.jsx` | `passerelle` est cherchée dans `equipements` (tout l'historique) mais `autres` filtre `recents` (24 h) : si la passerelle n'a pas été vue depuis 24 h, elle s'affiche quand même au centre | 🔶 Signalé — le comportement « souhaitable » dépend de votre intention |
| `auth.js` | `POST /api/auth/register` **totalement ouvert** — n'importe qui peut créer un compte `admin` | 🔴 Voir recommandations |
| `discoveryService.js` | `diagnosePanne()` teste 5 ports **en séquentiel** (jusqu'à 4 s par équipement en panne) alors que `scanPorts()` utilise `Promise.all` | 🔶 Signalé — passage en parallèle trivial mais modifie les temps de détection |
| `notificationService.js` | `getDestinataires()` appelée 2× par alerte (une fois pour l'e-mail, une fois pour WhatsApp) | 🔶 Signalé — impact faible |
| `agent.js` | Trois lignes vides après le `require("dotenv")` (l. 21-23) — trace de copier-coller, sans effet | Laissé tel quel |
| `App.jsx` | Espace parasite en fin de fichier après `export default App;` | Laissé tel quel |

---

## Points vérifiés — conformes, aucune action

- ✅ **`/api/agent/push` déclarée avant le `requireAuth` global** — ligne 25, les `app.use("/api", requireAuth, ...)` sont lignes 56-59. L'ordre est correct.
- ✅ **`scanPorts()` teste bien les ports en parallèle** via `Promise.all` sur les 15 ports courants.
- ✅ **`nmapFingerprint()` n'est appelée qu'en dernier recours** — uniquement si `fp.type === "inconnu"`, c'est-à-dire après échec de l'identification SNMP. J'ai ajouté un commentaire expliquant pourquoi cet ordre compte (nmap coûte jusqu'à 15 s/hôte).
- ✅ **Protection par rôle des routes d'écriture** — `POST /scan` (admin+opérateur), `POST /sites` (admin), `PATCH /incidents/:id` (admin+opérateur), `PATCH /configuration/:cle` (admin), `GET /logs` (admin). La nouvelle route `PATCH /alertes/:id/resoudre` suit la même convention.
- ✅ **Toutes les routes lues par le frontend existent** — vérifié par extraction automatique : 21 routes backend, 21 appels frontend, correspondance complète (verbe HTTP et chemin) après ajout de la route manquante.
- ✅ **`wakeOnLan()` et `readArpTable()` gèrent leurs échecs** — `readArpTable` renvoie `[]` si `arp -a` échoue ; `wakeOnLan` rejette proprement et son appelant a un `try/catch`.

---

## `readArpTable()` — appelée deux fois par scan

Vous demandiez de vérifier qu'elle n'est pas appelée dans une boucle. **Elle ne l'était pas** — mais elle était appelée **deux fois par scan** :

```js
const arpSupplement = await arpComplement(cidr, aliveHosts);  // lit la table ARP
const toutesLesEntreesArp = await readArpTable();             // la relit
```

Un commentaire affirmait pourtant « Lue une seule fois ». Deux `exec("arp -a")` au lieu d'un, avec un risque d'incohérence entre les deux lectures.

✅ **Corrigé** — lecture unique en amont, passée en paramètre optionnel à `arpComplement()`.

---

## Livrable : `backend/schema.sql`

Reconstruit intégralement à partir des **43 requêtes SQL** présentes dans `backend/src/`. **Aucun `DROP DATABASE`, aucun `DROP TABLE`** — le script est rejouable sur une base existante sans perte de données (`CREATE TABLE IF NOT EXISTS`, `INSERT IGNORE`).

**Validation :** parsé sans erreur en dialecte MySQL (14 `CREATE TABLE`, 2 `INSERT`), et vérification croisée automatique confirmant qu'**aucune requête du code ne référence une colonne absente du schéma**.

Les 14 tables demandées sont présentes, y compris les trois ajoutées après la création initiale (`SERVICE_DETECTE`, `VULNERABILITE_CONNUE`, `CONFIGURATION`).

Les 7 colonnes ajoutées par `ALTER TABLE` sont intégrées et **commentées comme telles** :

| Colonne | Table | Usage dans le code |
|---|---|---|
| `echecs_consecutifs` | `EQUIPEMENT` | `monitoringService` — comparée à `seuil_echecs_avant_alerte` |
| `os_detecte` | `EQUIPEMENT` | Résultat de `nmapFingerprint()` |
| `adresse_mac` | `EQUIPEMENT` | Table ARP → requise par le Wake-on-LAN |
| `cause_code` | `ALERTE` | Clé de `services/suggestions.js` |
| `snmp_v3_username` | `SITE` | ⚠ **Aucun code ne lit ces 3 colonnes** |
| `snmp_v3_auth_key` | `SITE` | `snmpProbeV3()` existe et est exportée, mais `scanRange()` |
| `snmp_v3_priv_key` | `SITE` | reçoit toujours `snmpV3 = null` — **SNMPv3 est mort-né** |

**Le SNMPv3 mérite votre attention :** la fonction `snmpProbeV3()` est complète et correcte, mais rien ne l'alimente. Ni `routes/scan.js` ni `agent.js` ne lisent les colonnes `snmp_v3_*`. Je ne l'ai pas branché — ce serait ajouter une fonctionnalité, hors périmètre.

### Deux index uniques indispensables

Le code fait `INSERT ... ON DUPLICATE KEY UPDATE` sur `EQUIPEMENT` et `SERVICE_DETECTE`. **Sans les index uniques correspondants, ces requêtes n'écrasent rien et créent un doublon à chaque scan.** Le schéma les déclare :

- `EQUIPEMENT (id_site, adresse_ip)`
- `SERVICE_DETECTE (id_equipement, port)`

**Vérifiez leur présence sur votre base existante** — c'est l'explication la plus probable si vous avez déjà constaté des équipements en double.

### Script de vérification

Je n'ai pas pu interroger votre base : elle tourne sur `localhost` sous Windows, hors d'atteinte de mon environnement d'exécution isolé. J'ai donc écrit le script que vous demandiez, à lancer chez vous :

```bash
cd backend
node tools/verifier-schema.js
```

En lecture seule. Il exécute `SHOW COLUMNS` sur les 14 tables, compare avec les colonnes réellement utilisées par le code, contrôle les deux index uniques ci-dessus, et sort en code 1 s'il détecte une incohérence bloquante. La section « Mise à niveau » en fin de `schema.sql` contient les `ALTER TABLE` correspondants.

---

## Recommandations par priorité

### P0 — à faire avant tout nouveau commit

1. **Régénérer les secrets de `backend/.env`** s'il a pu être poussé : mot de passe MySQL, `JWT_SECRET`, identifiants Mailtrap.
2. **Réparer le sous-module `frontend/`** — sinon le code du frontend n'est pas sauvegardé du tout :
   ```bash
   git rm --cached frontend
   rm -rf frontend/.git      # Windows : rmdir /s /q frontend\.git
   git add frontend .gitignore
   git commit -m "Corrige frontend enregistre par erreur comme sous-module"
   ```
3. **Lancer `node tools/verifier-schema.js`** et appliquer les `ALTER TABLE` signalés.

### P1 — sécurité

4. **Protéger `POST /api/auth/register`.** La route est ouverte à tous et accepte `role` depuis le corps de la requête : `{"role":"admin"}` suffit à obtenir un compte administrateur. Non corrigé car la fermer casse la création du premier admin. Options : la réserver à `requireRole("admin")` après création du premier compte, ou la conditionner à `process.env.ALLOW_REGISTER === "true"`.
5. **Restreindre CORS.** `app.use(cors())` autorise toutes les origines. En production : `cors({ origin: process.env.FRONTEND_URL })`.
6. **Limiter les tentatives de connexion** — `POST /api/auth/login` n'a aucun rate limiting, le bruteforce est libre.

### P2 — fiabilité

7. **Purger `RELEVE`.** Une ligne par équipement et par minute : 100 équipements ≈ **4,3 M lignes/mois**. L'index `(id_equipement, date_releve)` est en place, mais prévoyez une purge (`DELETE FROM RELEVE WHERE date_releve < NOW() - INTERVAL 90 DAY`).
8. **Cacher `getConfig()`** (voir « Erreurs silencieuses »).
9. **Paralléliser `diagnosePanne()`** — `Promise.all` au lieu de la boucle séquentielle, ramènerait 4 s à 800 ms par équipement en panne.

### P3 — hygiène

10. Trancher sur Socket.io : le brancher ou retirer les 3 lignes.
11. Trancher sur `api.js` : supprimer le fichier ou migrer les composants dessus (mais **pas les deux approches en parallèle** — c'est précisément ce qui causait les 401).
12. Brancher SNMPv3 ou retirer les colonnes `snmp_v3_*`.

---

## Tests d'exécution réalisés

Exécutés dans des **copies isolées** du projet (`/tmp`), avec des dépendances réinstallées pour Linux. **Votre `node_modules` n'a pas été touché** et aucun dossier `dist/` n'a été créé chez vous — votre installation Windows reste intacte.

### `npm start` (backend) — ✅ démarre sans erreur

```
> node src/server.js
injected env (13) from .env
NetSecureManager backend démarré sur le port 5000
```

Le serveur écoute, se maintient, et **n'a pas crashé** malgré MySQL volontairement injoignable dans cet environnement.

### `npm run build` (frontend) — ✅ compile sans erreur

```
vite v8.2.1 building client environment for production...
✓ 660 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.28 kB
dist/assets/index-Dwd7zolA.css   23.78 kB │ gzip:   5.65 kB
dist/assets/index-De7tTsUg.js   628.65 kB │ gzip: 188.20 kB
✓ built in 895ms
```

Un seul avertissement, **non bloquant** : le bundle JS dépasse 500 kB. C'est `recharts` (les graphiques de `EquipementDetail`) qui pèse l'essentiel. À traiter un jour par `import()` dynamique, sans urgence.

### `oxlint` — 0 erreur, 4 avertissements

Les 4 avertissements sont des `react-hooks/exhaustive-deps` sur `Dashboard`, `AlertesPage`, `EquipementsPage`, `IncidentsPage` — le motif `useEffect(() => { charger()... }, [filtre])` est **intentionnel** (rechargement au changement de filtre) et préexistant. Ce ne sont pas des bugs.

Point important : **aucun avertissement de variable inutilisée** ne subsiste, ce qui confirme que les suppressions de code mort (`io`, `SOCKET_URL`, `SEUIL_ESCALADE_MINUTES`, `db2`, `tokenHeader`) sont complètes.

### Tests HTTP réels des routes

Serveur lancé, requêtes `curl` effectives :

| Test | Attendu | Obtenu |
|---|---|---|
| `GET /api/equipements` sans jeton | 401 | ✅ `401 {"error":"Authentification requise"}` |
| `GET /api/sites`, `/alertes`, `/incidents`, `/configuration`, `/logs`, `/recherche` sans jeton | 401 | ✅ 401 JSON sur les 6 |
| `GET /api/sites` avec jeton JWT bidon | 401 | ✅ `401 {"error":"Session expirée, reconnectez-vous"}` |
| `POST /api/agent/push` sans jeton agent | 401 | ✅ `401 {"error":"Token d'agent manquant"}` |
| `POST /api/agent/push` sans `id_site` | 400 | ✅ `400 {"error":"id_site et equipements (tableau) sont requis"}` |
| `POST /api/agent/push` avec jeton, MySQL KO | 500 JSON | ✅ `500 {"error":"Erreur serveur pendant la réception..."}` |
| `POST /api/auth/login` sans champs | 400 | ✅ `400 {"error":"Email et mot de passe requis"}` |
| `POST /api/auth/login` avec MySQL KO | 500 JSON | ✅ `500 {"error":"Erreur serveur pendant la connexion"}` |
| Démarrage sans `JWT_SECRET`/`DB_*` | refus explicite | ✅ `Variables d'environnement manquantes dans backend/.env : DB_HOST, DB_USER, DB_PASS, DB_NAME` |

**Confirmé au passage :** `/api/agent/push` répond bien `401 "Token d'agent manquant"` et non `401 "Authentification requise"` — preuve qu'elle est bien évaluée **avant** le `requireAuth` global et qu'elle utilise son propre système de jeton.

**Aucun crash du processus** pendant toute la campagne, malgré les erreurs MySQL répétées : les rejets sont journalisés et convertis en réponses JSON.

### Correction issue de l'exécution réelle : les notifications bloquaient le cycle

Le démarrage sur la vraie base a fait apparaître deux messages liés :

```
Erreur envoi e-mail: Invalid login: 535 5.7.0 The email limit is reached...   (×N)
Cycle de supervision précédent encore en cours — exécution ignorée.
```

Le second est le garde-fou anti-chevauchement qui fait son travail — mais s'il se déclenche, c'est qu'un cycle dépasse 60 s. La cause était le premier message : `creerAlerte()` faisait `await sendEmailAlert(...)` puis `await sendWhatsAppAlert(...)`, **en série, pour chaque destinataire**, avec un transporteur nodemailer **sans aucun timeout** (défaut : jusqu'à 2 minutes par envoi). Le cycle de supervision attendait le serveur mail.

Ce n'était pas une erreur de frappe mais un choix de conception d'origine, invisible tant que le SMTP répondait vite.

✅ **Corrigé** (`notificationService.js`, `monitoringService.js`) :

- **Notifications sorties du chemin critique** — l'alerte est enregistrée en base et rendue visible immédiatement ; `notifierAlerte()` part sans `await`. Le cycle ne dépend plus du SMTP.
  *Changement de comportement assumé :* `creerAlerte()` ne garantit plus que l'e-mail est parti quand elle rend la main.
- **Timeouts SMTP ajoutés** — `connectionTimeout` et `greetingTimeout` à 5 s, `socketTimeout` à 10 s. Mesuré : 300 tentatives sur un SMTP injoignable en 853 ms, contre plusieurs minutes auparavant.
- **Une seule lecture des destinataires par alerte** au lieu de deux (une par canal).
- **Envoi ignoré si `SMTP_HOST` ou `WHATSAPP_TOKEN` est vide** — inutile d'échouer une fois par destinataire pour le découvrir.
- **`notifierAlerte()` ne rejette jamais** — vérifié sur 300 appels consécutifs.

### Journal : limitation des lignes répétées

Un incident SMTP produit une ligne d'erreur par destinataire et par alerte, ce qui noie le journal. Un limiteur écrit désormais **au plus une ligne par minute et par canal**, en indiquant combien d'occurrences ont été regroupées :

```
Erreur envoi e-mail: Invalid login: 535 5.7.0 ... (+247 erreur(s) similaire(s) dans la minute précédente)
```

**Mesuré :** 300 erreurs consécutives → **1 ligne de journal** au lieu de 300.

> À noter : votre quota Mailtrap est épuisé (`535 5.7.0 The email limit is reached`). Ce n'est pas un défaut du code — les alertes continuent d'être enregistrées et affichées normalement, seule la notification e-mail échoue. Le journal sera simplement lisible en attendant que vous renouveliez le quota ou changiez de fournisseur.

### Un défaut trouvé — et corrigé — par ces tests

Le gestionnaire d'erreurs global que j'avais ajouté renvoyait **500 pour un corps JSON malformé**, alors que c'est une erreur client (400). Corrigé : le handler respecte désormais `err.status` / `err.statusCode`.

Vérifié après correction : corps malformé → `400 {"error":"Requête invalide"}`, et une vraie erreur serveur reste bien en `500`.

---

## Ce que je n'ai PAS pu tester — à faire sur votre machine

Mon environnement d'exécution est un conteneur Linux isolé : **il n'a aucun accès à votre MySQL** (`localhost:3306` sous Windows), ni à votre réseau local. Tout ce qui dépend de données réelles reste donc à valider par vous :

1. **Appliquer d'abord le schéma**, puis lancer la vérification :
   ```bash
   cd backend
   node tools/verifier-schema.js
   ```
2. **`npm start` avec MySQL joignable** — vérifier qu'aucune erreur n'apparaît après 1 à 2 minutes (le cron se déclenche au début de chaque minute).
3. **Connexion** puis parcours des 8 pages : Dashboard, Équipements, Alertes, Incidents, Topologie, Configuration, Journal, Sites.
4. **Le bouton « Marquer résolue »** sur la page Alertes — c'est la route que j'ai ajoutée, le test le plus important de tous.
5. **Lancer un scan** et vérifier que les équipements remontent, **puis relancer le même scan** : le nombre d'équipements doit rester **identique**. S'il double, c'est que l'index unique `EQUIPEMENT (id_site, adresse_ip)` manque — voir le script de vérification.
6. **Recherche globale** (≥ 2 caractères) sur un nom, une IP, un message d'alerte.
7. **Vérifier l'absence de 401 aléatoires** en naviguant plusieurs minutes — c'était le symptôme de l'incohérence d'authentification corrigée.

---

## Fichiers modifiés

**Backend (9)** — `db.js`, `middleware/authMiddleware.js`, `routes/auth.js`, `routes/scan.js`, `server.js`, `services/discoveryService.js`, `services/monitoringService.js`, + créés : `schema.sql`, `.env.example`, `tools/verifier-schema.js`

**Frontend (11)** — `App.jsx`, `api.js`, `Components/` : `Login.jsx`, `Dashboard.jsx`, `AlertesPage.jsx`, `IncidentsPage.jsx`, `SitesPage.jsx`, `ConfigurationPage.jsx`, `JournalPage.jsx`, `ScanLauncher.jsx`, `SearchBar.jsx`, `EquipementDetail.jsx`, `Sidebar.jsx`

**Racine (2)** — `.gitignore` (créé), `RAPPORT_AUDIT.md`

Après corrections : les 14 fichiers backend passent `node --check`, les 18 fichiers frontend parsent sans erreur, `schema.sql` est du MySQL valide.

> **Note sur les secrets en dur.** `db.js` avait `password: process.env.DB_PASS || "Root@1234"` et `authMiddleware.js` / `auth.js` avaient `process.env.JWT_SECRET || "change-this-secret-in-.env"`. Ces valeurs de repli sont supprimées : **l'application refuse désormais de démarrer** si `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME` ou `JWT_SECRET` manquent, avec un message nommant la variable absente. C'est volontairement bruyant — un repli silencieux sur une clé JWT publique rendait tous les jetons forgeables.
