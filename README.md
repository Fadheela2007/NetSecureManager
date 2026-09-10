# NetSecureManager

Plateforme de supervision réseau pour petites et moyennes structures :
découverte automatique du parc, surveillance de la disponibilité, mesure
de la bande passante, alertes et contrôle des accès web.

> Code source consultable. Utilisation soumise à autorisation — voir
> [LICENSE](LICENSE).

---

## Ce que fait la plateforme

**Découverte automatique du parc.** Un balayage de plage réseau identifie
les équipements présents, leur fabricant, leur type et les services
qu'ils exposent. Aucune saisie manuelle préalable n'est nécessaire.

**Identification par quatre sources.** Le nom d'une machine est cherché
successivement en SNMP, par résolution DNS inverse, en NetBIOS et en
mDNS. Un parc où aucun poste n'expose SNMP — le cas courant sous Windows
— reste donc identifiable.

**Supervision continue.** Chaque équipement est interrogé à intervalle
régulier. Les pannes déclenchent une alerte, dédoublonnée : un problème
persistant produit une ligne avec un compteur, jamais cinquante lignes
identiques.

**Bande passante, avec ou sans SNMP.** Le débit est mesuré directement
sur les équipements qui l'exposent. Pour les autres, il est déduit du
port du commutateur auquel ils sont raccordés — et refusé plutôt
qu'approximé lorsque plusieurs machines partagent un port.

**Contrôle des accès web.** Blocage par catégories de sites, appliqué par
un agent pilotant un résolveur DNS, avec vérification réelle de
l'application et fermeture des contournements IPv6.

**Multi-sites.** Un agent installé sur un site distant remonte ses
relevés au serveur central. Chaque utilisateur ne voit que les sites
auxquels il est rattaché.

---

## Architecture

```
backend/     Node.js · Express · MySQL
  src/
    routes/       API REST
    services/     découverte, supervision, notifications, politiques web
    agent/        agent déployé sur les sites distants
  migrations/     évolutions du schéma, dans l'ordre chronologique
  tools/          diagnostic et maintenance
  tests/          tests unitaires (node:test), sans base ni réseau

frontend/    React · Vite · Tailwind
```

---

## Installation

Prérequis : Node.js 18 ou plus, MySQL 8.

```bash
# Base de données
mysql -u root -p -e "CREATE DATABASE netsecuremanager"

# Backend
cd backend
npm install
cp .env.example .env        # renseigner les accès MySQL et JWT_SECRET
node tools/appliquer-migrations.js
node tools/importer-oui.js  # registre des fabricants (sans réseau)
npm start

# Frontend
cd ../frontend
npm install
npm run dev
```

Le premier compte administrateur se crée au premier démarrage, tant que
la table des utilisateurs est vide. Cette route se ferme ensuite
définitivement.

Ce qui précède fait tourner la plateforme **sur le poste de
développement**. Pour l'installer chez un client, voir la section
suivante : `npm run dev` ne convient pas, et l'adresse de l'API doit être
fixée avant de compiler.

---

## Mise en service chez un client

### 1. L'adresse de l'API, avant tout le reste

L'interface est compilée avec l'adresse du serveur **écrite en dur
dedans**. La variable est lue à la compilation, pas au démarrage :
changer l'adresse impose de **recompiler**, pas de redémarrer.

```bash
cd frontend
cp .env.example .env
# VITE_API_URL=https://supervision.societe.fr/api
npm run build
```

Sans cette étape, l'interface compilée appellera `http://localhost:5000`
**depuis le poste de chaque utilisateur** — c'est-à-dire nulle part.
L'écran se charge, rien ne se remplit, et aucun message n'explique
pourquoi. C'est l'erreur d'installation la plus fréquente.

### 2. Déclarer qui a le droit d'appeler l'API

Côté backend, `FRONTEND_URL` liste les adresses autorisées à joindre
l'API depuis un navigateur. Elle doit correspondre à l'adresse réelle de
l'interface, sinon le navigateur bloquera les appels.

```
FRONTEND_URL=https://supervision.societe.fr
```

Laissée vide, seules les adresses locales de développement sont
acceptées et un avertissement s'affiche au démarrage.

### 3. Servir l'interface compilée

`npm run build` produit `frontend/dist/`, un dossier de fichiers
statiques. Il se sert par n'importe quel serveur web. Avec nginx :

```nginx
server {
    listen 80;
    server_name supervision.societe.fr;

    root /opt/netsecuremanager/frontend/dist;
    index index.html;

    # L'interface est une application d'une seule page : toute adresse
    # inconnue doit rendre index.html, sinon un rechargement sur
    # /equipements renvoie une erreur 404.
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **À savoir si vous placez un serveur frontal devant l'API.** La
> limitation des tentatives de connexion compte par adresse IP. Derrière
> un proxy, toutes les requêtes portent la même adresse : la protection
> ne distingue plus les clients. Le réglage `trust proxy` d'Express doit
> alors être ajusté au nombre de proxys réellement présents — ni laissé
> tel quel, ni mis à `true` sans réflexion, ce qui rendrait la protection
> contournable par un en-tête falsifié.

### 4. Faire tourner le backend en service

`npm start` occupe un terminal et s'arrête avec lui. En production, le
backend doit redémarrer seul après une coupure ou un redémarrage du
serveur. Sous Linux, avec systemd :

```ini
# /etc/systemd/system/netsecuremanager.service
[Unit]
Description=NetSecureManager - supervision reseau
After=network.target mysql.service

[Service]
Type=simple
User=netsecure
WorkingDirectory=/opt/netsecuremanager/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=10
# Le .env contient les identifiants de la base et le secret des jetons :
# il n'appartient qu'à ce compte.
Umask=0077

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now netsecuremanager
sudo journalctl -u netsecuremanager -f   # lire le journal
```

Sous Windows, un outil comme NSSM rend le même service.

### 5. Ce qu'il faut avoir vérifié avant de partir

- `node tools/verifier-tout.js` ne rend aucune ligne rouge.
- Le journal du serveur au démarrage n'annonce **aucun site exclu de la
  supervision** ; le cas échéant, le message dit lequel et quoi faire.
- Une sauvegarde de la base est planifiée. La plateforme n'en fait pas :
  `mysqldump` dans une tâche planifiée suffit.
- Le `.env` n'est lisible que par le compte qui exécute le service.

### Ce que la plateforme ne fait pas

À dire au client avant l'installation, pas après :

- **Un seul serveur.** Pas de reprise automatique sur un second : la
  limitation des tentatives de connexion vit en mémoire et ne se partage
  pas.
- **Les sessions ne se révoquent pas immédiatement.** Un compte supprimé
  ou rétrogradé conserve ses droits jusqu'à l'expiration de son jeton,
  soit huit heures au plus.
- **Le blocage web exige trois conditions extérieures au logiciel** :
  dnsmasq installé sur une machine Linux, le DHCP du site qui distribue
  l'agent comme serveur DNS, et des règles anti-contournement sur le
  routeur. Sans la deuxième, rien n'est bloqué ; sans la troisième, tout
  se contourne.
- **Pas de sauvegarde automatique** de la base de données.

---

## Vérifier une installation

```bash
cd backend
node tools/verifier-tout.js
```

Contrôle en une commande la configuration, la structure de la base, la
cohérence des données et les tests unitaires. Il ne remplace pas le
protocole manuel décrit dans `TESTER-LA-PLATEFORME.md` : aucun programme
ne peut vérifier qu'un scan trouve les bonnes machines ou qu'une alerte
part par courriel, car cela dépend du réseau et non du code.

---

## Failles connues des logiciels exposés

Le scan lit la version que chaque service annonce à la connexion —
`OpenSSH 8.2p1`, `Apache 2.4.41`, `MySQL 8.0.32`. Cette commande compare
ces versions à la base publique du NIST et enregistre les failles
publiées :

```bash
cd backend
node tools/importer-failles.js
```

Elle demande un accès à `nvd.nist.gov` : c'est pourquoi elle est séparée
du scan, qui tourne sur le réseau du client et n'a pas toujours internet.
Sans clé d'API, le NVD accepte une requête toutes les six secondes ;
une clé gratuite (`NVD_API_KEY` dans `.env`) ramène ce délai sous la
seconde. Un logiciel absent de `backend/donnees/cpe-produits.json`
n'est pas interrogé — et il est marqué comme tel, jamais comme « sans
faille ».

**Ce que la plateforme affirme, et ce qu'elle n'affirme pas.** Elle
affiche « 3 failles publiées pour cette version, à vérifier ». Elle
n'écrit jamais « cette machine est vulnérable ». Le rapprochement porte
sur la version numérique annoncée : un correctif de distribution corrige
souvent une faille sans changer ce numéro. Chaque ligne porte son numéro
CVE et un lien vers le NVD, pour que la vérification prenne un clic.

Une liste vide n'est jamais rendue sans son motif : *interrogé, rien de
publié*, *logiciel sans correspondance connue*, ou *jamais interrogé*.
Confondre les trois reviendrait à rassurer sans avoir regardé.

---

## Principes de conception

**Une case vide vaut mieux qu'une valeur fausse.** Un équipement dont le
type ne peut être déterminé est marqué « inconnu » plutôt que rangé dans
une catégorie plausible. Un débit qui ne peut être attribué avec
certitude n'est pas affiché.

**Toute valeur déduite dit d'où elle vient.** Les colonnes `type_source`,
`fabricant_source` et `nom_source` enregistrent quelle règle a décidé.
Une classification contestée se diagnostique en lisant une colonne, pas
en relançant un scan.

**Une migration en retard dégrade, ne casse pas.** Les pages centrales
disposent d'une requête de repli : une colonne manquante fait perdre un
tri, jamais l'affichage.

---

## Tests

```bash
cd backend
npm test
```

Les tests ne touchent ni la base ni le réseau : ils vérifient les calculs
et les protocoles sur des données fabriquées. Les encodages binaires —
NetBIOS, mDNS — y sont couverts cas par cas, y compris les réponses
tronquées et les pointeurs de compression circulaires.

---

## Licence

Tous droits réservés. Voir [LICENSE](LICENSE).
