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
