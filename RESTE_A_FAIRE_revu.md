# Reste à faire — relecture après audit du code

Ce document confronte votre synthèse (§5 à §7) au code réellement présent dans `backend/src/` et `frontend/src/`. Il ne remplace pas votre feuille de route : il la corrige sur trois points, et ajoute ce qui manquait.

---

## A. Absent de votre liste — à traiter avant tout le reste

Ces sept points ne figurent nulle part dans votre §5. Trois d'entre eux passent devant toute votre priorité haute.

### A1. 🔴 Le code du frontend n'est pas versionné

`git ls-files -s` renvoie `160000 fa6e6b11... frontend`. Le mode `160000` est un *gitlink* : Git a enregistré une **référence vers un dépôt imbriqué**, pas les fichiers. Un `git clone` de votre dépôt produirait un dossier `frontend/` **vide**.

Cause : un `frontend/.git` créé par `npm create vite`, committé tel quel. Rien à voir avec une exigence fonctionnelle — c'est une perte de travail potentielle. À régler avant le prochain commit.

```bash
git rm --cached frontend
rm -rf frontend/.git        # Windows : rmdir /s /q frontend\.git
git add frontend .gitignore
git commit -m "Corrige frontend enregistre par erreur comme sous-module"
```

### A2. 🔴 N'importe qui peut se créer un compte administrateur

`POST /api/auth/register` n'a **aucune protection** et lit `role` depuis le corps de la requête :

```js
router.post("/register", async (req, res) => {
  const { nom, email, mot_de_passe, role = "admin" } = req.body;
```

Une seule requête HTTP suffit pour obtenir un accès admin :

```bash
curl -X POST http://.../api/auth/register \
  -d '{"nom":"x","email":"x@x.x","mot_de_passe":"x","role":"admin"}'
```

Vous classez « Interface de gestion des utilisateurs » en **priorité moyenne**. La partie *interface* est effectivement moyenne. Mais la faille est **P0** : elle annule entièrement le système de rôles que votre conclusion présente comme « complet et éprouvé ». Tant qu'elle est ouverte, `requireRole` ne protège rien.

Correctif immédiat (5 min) : réserver la route à `requireRole("admin")` une fois le premier compte créé, ou la conditionner à `process.env.ALLOW_REGISTER === "true"`.

### A3. 🔴 Deux index uniques conditionnent la justesse des scans

Le code fait `INSERT ... ON DUPLICATE KEY UPDATE` sur `EQUIPEMENT` et `SERVICE_DETECTE`. **Sans les index uniques correspondants, ces requêtes n'écrasent rien et créent un doublon à chaque scan** — silencieusement.

- `EQUIPEMENT (id_site, adresse_ip)`
- `SERVICE_DETECTE (id_equipement, port)`

À vérifier immédiatement : `node backend/tools/verifier-schema.js`. Test terrain : lancer deux fois le même scan, le nombre d'équipements doit rester identique.

### A4. Rotation des secrets

`backend/.env` n'était protégé par aucun `.gitignore` (créé depuis) et contient le mot de passe MySQL, `JWT_SECRET` et les identifiants Mailtrap. Si le dépôt a été poussé, ces secrets sont compromis. Votre §6 mentionne le remplacement du SMTP mais pas la rotation.

### A5. CORS ouvert à toutes les origines

`app.use(cors())` sans restriction. En production : `cors({ origin: process.env.FRONTEND_URL })`. À ajouter au §6.

### A6. Aucune limitation sur les tentatives de connexion

Vous listez la limitation du débit **des notifications** (§5.1), mais pas celle du **login**. `POST /api/auth/login` accepte un nombre illimité de tentatives : le bruteforce est libre. C'est le point d'entrée le plus exposé de la plateforme.

### A7. Le jeton d'agent circule en clair

Chaque agent distant envoie son `agent_token` en `Bearer` sur `http://`. Votre §6 prévoit HTTPS — je le souligne parce que c'est **bloquant**, pas confortable : sans TLS, un jeton capté sur le réseau permet d'injecter de faux équipements dans la base centrale.

---

## B. Trois corrections à votre classification

### B1. ❌ SNMP v3 n'est pas « développé, en attente de matériel »

Votre §5.4 le classe parmi les fonctionnalités développées non testables faute d'équipement. **Ce n'est pas le cas.** Vérifié :

| Élément | État |
|---|---|
| `snmpProbeV3()` | ✅ écrite, correcte, exportée |
| Appel avec identifiants | ❌ `scanRange({ snmpV3 = null })` — **toujours `null`** |
| Lecture des colonnes `snmp_v3_*` | ❌ aucune requête ne les lit |
| Saisie dans l'interface | ❌ `ScanLauncher` ne propose que la communauté v2c |

Même avec un switch professionnel configuré en v3 sous la main, **vous ne pourriez pas le tester** : rien n'alimente la fonction. Ce n'est pas un problème de matériel mais un chaînon manquant d'environ 30 lignes (lire les colonnes du site → passer l'objet à `scanRange`).

À déplacer de §5.4 vers §5.2.

### B2. ⚠️ Les quatre tables inutilisées ne sont pas un même problème

Vous les regroupez en un seul point §5.1. Elles relèvent en fait de deux situations très différentes :

**Le travail est déjà fait, seule l'écriture manque :**

- **`TYPE_EQUIPEMENT`** — `fingerprint()` dans `discoveryService.js` fait ~40 lignes de détection de constructeur (Cisco, Huawei, Fortinet, HP, Axis, Hikvision…), renvoie `type_detecte`, et `routes/scan.js` **ne l'insère jamais**. La colonne `EQUIPEMENT.id_type_equipement` reste toujours `NULL`. **Le résultat est calculé puis jeté.** Correction : une jointure sur `libelle` dans l'`INSERT`. C'est le meilleur rapport valeur/effort de toute votre liste.
- **`INTERFACE_RESEAU`** — `snmpMetrics()` collecte **toutes** les interfaces, `monitoringService` n'exploite que `metrics.interfaces[0]`. Les autres sont collectées puis jetées. Votre §5.2 « Suivi de l'état des interfaces par port » est donc à moitié fait sans que ce soit visible.

**Rien n'existe :**

- **`NOTIFICATION`** — aucune écriture. Votre §5.2 « Traçabilité des notifications » est à écrire entièrement (mais c'est simple : un `INSERT` dans `notificationService`).
- **`PLAGE_SCAN`** — aucune lecture. Les CIDR sont saisis à la main dans `ScanLauncher` et dans le `.env` de chaque agent. Table à alimenter ou à retirer.

### B3. ⚠️ « Détection des conflits d'IP » est à moitié construite

Classée en priorité **basse** (§5.3). Or `services/suggestions.js` contient déjà les étapes de résolution pour le code `conflit_ip` :

```js
conflit_ip: [
  "Deux équipements semblent utiliser la même adresse IP — vérifier...",
  "Vérifier la plage d'adresses réservées par le serveur DHCP...",
],
```

**Aucun code n'émet jamais ce `cause_code`.** C'est une branche morte : le texte d'aide existe, la détection non. Soit vous branchez la détection (la table ARP, déjà lue à chaque scan, contient tout le nécessaire : une même MAC sur deux IP, ou deux MAC sur une même IP), soit vous retirez l'entrée pour ne pas laisser croire que la fonction existe.

---

## C. Confirmé — votre analyse est juste

Vérifié dans le code, ces points de votre §5.1 sont exacts :

- **Cloisonnement par site absent** — le JWT contient bien `id_site` (`routes/auth.js`), mais **aucune route ne filtre dessus**. `req.user` n'est lu que pour le rôle et la journalisation. Tout utilisateur connecté voit tous les sites. Confirmé par recherche exhaustive.
- **Santé des agents non supervisée** — aucune colonne de type `last_seen` sur `SITE`, aucune trace du dernier push. Un agent qui s'arrête rend son site invisible **sans aucun signal**. C'est le risque le plus sournois de l'architecture multi-sites : l'absence de données ressemble à un réseau sain.
- **Purge de `RELEVE`** — une ligne par équipement et par minute. 100 équipements ≈ **4,3 M lignes/mois**. L'index `(id_equipement, date_releve)` est en place dans le nouveau `schema.sql`, mais la purge reste à écrire.

---

## D. Point déjà traité — à retirer de votre §5.1

**« Limitation du débit d'envoi des notifications, pour éviter la saturation constatée lors des tests. »**

Le diagnostic mérite d'être précisé : la saturation avait **deux causes distinctes**, toutes deux corrigées lors de l'audit.

1. Votre quota Mailtrap était épuisé (`535 5.7.0 The email limit is reached`) — cause externe, pas un défaut du code.
2. `creerAlerte()` faisait `await sendEmailAlert(...)` puis `await sendWhatsAppAlert(...)` **en série, par destinataire**, avec un transporteur nodemailer **sans timeout** (défaut : jusqu'à 2 min par envoi). Le cycle de supervision attendait le serveur mail — d'où les `Cycle de supervision précédent encore en cours`.

Corrigé : notifications sorties du chemin critique, timeouts SMTP (5 s / 5 s / 10 s), journal limité à une ligne par minute et par canal. Mesuré : 300 tentatives sur SMTP injoignable en **853 ms** au lieu de plusieurs minutes ; 300 erreurs → **1 ligne** de journal.

Ce qui reste légitime, en revanche : une **limitation métier** (ne pas renvoyer 40 e-mails quand 40 équipements tombent à cause d'une seule coupure de switch). C'est un besoin différent — de l'agrégation d'alertes, pas du débit technique. À reformuler dans ce sens.

---

## E. Nuance sur votre conclusion

> « Le socle fonctionnel — […] gestion d'incidents […] — est complet et éprouvé. »

Deux réserves factuelles :

1. La route `PATCH /api/alertes/:id/resoudre`, appelée par le bouton « Marquer résolue », **n'existait pas** côté backend jusqu'à l'audit. Elle renvoyait un 404 silencieux : l'alerte restait active et finissait escaladée en incident 15 min plus tard, quoi que fasse l'opérateur. Le cycle de vie d'une alerte n'a donc **jamais pu être parcouru en entier**. Ce n'est plus le cas, mais cela reste à valider en conditions réelles avant de l'écrire comme « éprouvé ».
2. « Gestion des rôles complète » est incompatible avec A2 tant que `register` est ouvert.

Le fond de votre conclusion me paraît juste — le socle est bien là, et l'essentiel du restant relève de l'enrichissement. La distinction entre testé / développé non validé / à faire est effectivement une bonne pratique. Je suggère seulement d'ajouter une quatrième catégorie : **« développé mais non branché »**, où se rangent SNMPv3, le fingerprinting de type, et les interfaces réseau. C'est là que se trouve le meilleur rapport valeur/effort du projet.

---

## Ordre de traitement suggéré

| # | Action | Effort | Catégorie |
|---|---|---|---|
| 1 | Réparer le sous-module `frontend/` (A1) | 5 min | Perte de données |
| 2 | Fermer `POST /register` (A2) | 5 min | Sécurité P0 |
| 3 | Vérifier les deux index uniques (A3) | 5 min | Justesse des données |
| 4 | Roter les secrets si le dépôt a été poussé (A4) | 15 min | Sécurité P0 |
| 5 | Brancher `id_type_equipement` (B2) | 30 min | Valeur immédiate |
| 6 | Filtrage par site (C) | 2-3 h | Cohérence |
| 7 | Purge de `RELEVE` (C) | 1 h | Fiabilité |
| 8 | Santé des agents (C) | 3-4 h | Fiabilité |
| 9 | Brancher SNMPv3 (B1) | ~30 lignes | Complétude |
| 10 | HTTPS + CORS + rate limiting (A5, A6, A7) | déploiement | Production |

Les quatre premiers points prennent **moins d'une heure au total** et retirent les seuls risques réellement graves du projet.
