# Identification du fabricant par adresse MAC (OUI)

**Date :** 17 août 2026

**Vérifications :** backend 24/24 `node --check`, serveur démarre, frontend compile en 881 ms, `oxlint` 0 erreur. **57 tests automatisés, 0 échec**, dont 8 sur de vraies adresses MAC vérifiées contre le registre IEEE.

---

## Le résultat, d'abord

Simulation sur la structure exacte de votre parc — 163 équipements, 6 en SNMP, 157 avec MAC :

```
     avant (SNMP seul) :   6 identifiés
     après (avec OUI)  : 157 identifiés sur 163
```

Les 6 restants sont ceux sans adresse MAC. Votre MAC de test `a4-34-d9` donne **Intel Corporate**.

---

## La source du registre : une table en base

Vos deux critères — fonctionner sans Internet, et se mettre à jour sans redéployer — éliminent trois options sur quatre.

| Option | Sans Internet | Sans redéployer |
|---|---|---|
| API en ligne à la demande | ❌ | ✓ |
| Bibliothèque npm | ✓ | ❌ *(npm update + livraison)* |
| Fichier embarqué seul | ✓ | ❌ |
| **Table en base** | ✓ | ✓ |

**Retenu : table `OUI_FABRICANT`, alimentée par un script.** Un administrateur peut même la corriger en SQL.

### Ce que je livre concrètement

Une **graine** `backend/data/oui-ieee.json.gz` : le registre IEEE complet, **53 559 entrées en 517 Ko compressés**. C'est peu pour un dépôt, et cela couvre tout le registre plutôt qu'une liste réduite forcément incomplète.

> J'avais d'abord tenté une liste réduite aux fabricants courants. Elle échouait sur votre propre cas : Intel possède des centaines de blocs OUI, et `A434D9` n'était pas dans les huit premiers retenus. Sans données de fréquence réelle, une liste curée écarte précisément les blocs les plus utilisés. D'où le registre complet.

**Provenance :** extrait du registre public MA-L de l'IEEE via le paquet `oui-data` (BSD-2-Clause), utilisé **uniquement pour produire le fichier**. Ce n'est pas une dépendance du projet — `package.json` est inchangé. Les données elles-mêmes sont publiques.

### Trois façons de mettre à jour, sans redéployer

```bash
cd backend
node tools/importer-oui.js                        # graine embarquée, aucun réseau
node tools/importer-oui.js --fichier oui.csv      # fichier récupéré ailleurs
node tools/importer-oui.js --telecharger          # depuis l'IEEE, si le serveur a Internet
```

Import idempotent : le relancer met à jour et complète, sans jamais supprimer.

**Et si l'import n'a pas encore été fait ?** Le service retombe sur la graine lue depuis le disque. La fonctionnalité marche donc dès le premier démarrage. `GET /api/oui/etat` indique laquelle des deux sources est active.

---

## Priorité des sources : SNMP > OUI > nmap

C'est le point qui demandait le plus de justification, et **je place l'OUI avant nmap**.

**SNMP en premier** : l'équipement se décrit lui-même, c'est le constructeur réel de la machine.

**OUI avant nmap** — parce que le « fabricant » déduit par nmap n'en est pas un. `fabricantFromOsString()` renvoie « Microsoft », « Linux », « Apple » à partir du système détecté. Or **« Linux » n'est pas un fabricant**, et « Microsoft » désigne l'éditeur de l'OS, pas le constructeur du matériel. L'OUI donne un vrai constructeur : Dell, Intel, Hewlett-Packard.

L'information de nmap n'est pas perdue : elle vit déjà dans `os_detecte`, qui est sa place légitime.

```
  OK   SNMP Cisco + carte Intel -> Cisco (SNMP gagne)
  OK   nmap dit « Linux », OUI dit Intel -> Intel (OUI gagne)
  OK   OUI inconnu -> repli sur nmap
```

**Limite assumée, et c'est votre exemple :** l'OUI identifie la **carte** réseau. Un serveur Dell avec une carte Intel remontera « Intel ». D'où le champ `fabricant_source`, qui permet à l'interface de nuancer.

---

## Adresses MAC aléatoires

Le deuxième bit de poids faible du premier octet (masque `0x02`) distingue une adresse attribuée par l'IEEE d'une adresse choisie localement. Quand il vaut 1 — deuxième caractère hexadécimal à **2, 6, A ou E** — l'adresse ne correspond à **aucun** fabricant réel.

Le registre n'est même pas consulté : la réponse serait trompeuse. L'équipement est marqué `fabricant_source = 'mac_aleatoire'` et l'interface affiche « MAC aléatoire » avec l'explication en infobulle.

```
  OK   a2:34:d9:… -> détectée aléatoire      OK   a4:34:d9:… -> normale
  OK   a6:34:d9:… -> détectée aléatoire      OK   00:50:56:… -> normale
  OK   aa:34:d9:… -> détectée aléatoire      OK   b8:27:eb:… -> normale
  OK   ae:34:d9:… -> détectée aléatoire      OK   3c:5a:b4:… -> normale
  OK   02:00:00:… -> détectée aléatoire
```

Le marquage explicite évite aussi de réexaminer ces équipements à chaque rattrapage : « pas identifiable » n'est pas « pas encore regardé ».

**À savoir :** certains hyperviseurs utilisent aussi des adresses localement administrées pour leurs machines virtuelles. Elles seront donc marquées « aléatoires », ce qui est techniquement exact même si l'origine diffère.

---

## Format des adresses

Normalisation avant comparaison, tous formats absorbés :

```
  OK   Windows / table ARP  a4-34-d9-1f-22-03  -> A434D9
  OK   Linux                A4:34:D9:1F:22:03  -> A434D9
  OK   Cisco                a434.d91f.2203     -> A434D9
  OK   brut                 A434D91F2203       -> A434D9
  OK   OUI seul             a4:34:d9           -> A434D9
```

Entrée trop courte, `null` ou non textuelle → `null`, sans erreur.

---

## Affichage : discret, mais présent

Un composant `Fabricant` affiche la provenance sans alourdir :

| Provenance | Affichage |
|---|---|
| SNMP | `Cisco` — rien à signaler, c'est la source la plus fiable |
| OUI | `Intel Corporate · carte réseau` |
| nmap | `Microsoft · d'après l'OS` |
| MAC aléatoire | `MAC aléatoire` |

**Parti pris :** un point médian et un mot en gris, pas de badge coloré. Sur 150 équipements, un marqueur voyant sur presque chaque ligne deviendrait du bruit. L'infobulle porte l'explication complète pour qui la cherche — *« Désigne le fabricant de la carte réseau, qui peut différer de celui de l'équipement »*.

---

## Enrichissement du type

Implémenté, mais **uniquement pour les constructeurs mono-produit** : Axis, Hikvision, Dahua et Mobotix ne font que des caméras ; Zebra, Brother, Lexmark et Kyocera que des imprimantes ; Yealink, Grandstream, Snom et Polycom que de la téléphonie.

```
  OK   Axis                       -> camera
  OK   Raspberry Pi               -> serveur
  OK   Intel — trop générique     -> aucun
  OK   Cisco — routeurs ET switches ET téléphonie -> aucun
  OK   mais SNMP dit routeur/switch -> non écrasé
```

L'enrichissement ne s'applique que si le type est `inconnu` ou `detecte_nmap` : il ne contredit jamais une détection plus sûre.

**Votre piste HP + port 9100, non implémentée.** Elle est bonne, mais elle bute sur l'ordre du scan : le type est écrit dans `EQUIPEMENT` **avant** que `scanPorts()` ne s'exécute. L'exploiter demanderait une mise à jour supplémentaire après le scan des ports. C'est faisable, mais cela change la séquence du scan — je préfère vous le signaler plutôt que de le faire de mon propre chef.

---

## Le défaut que vous aviez repéré : confirmé et corrigé

Le type restait « Inconnu » malgré une détection nmap réussie. La cause est à la ligne 358 de `discoveryService.js` :

```js
fp = { type: nmapResult.type_detecte || "detecte_nmap", ... };
```

`nmapResult.type_detecte` vient de la ligne « Device type » de nmap : `general purpose`, `WAP`, `print server`… Ces chaînes **n'existent pas** dans `TYPE_EQUIPEMENT`. `getIdType()` ne trouvait aucune correspondance et retombait sur `inconnu`.

Le repli `"detecte_nmap"` n'était atteint que dans le cas plus rare où nmap ne donne **aucune** ligne « Device type » — d'où l'impression que le type n'était jamais enregistré.

**Corrigé** par une table de traduction du vocabulaire nmap vers celui du projet, avec repli sur `detecte_nmap` pour toute valeur non reconnue :

```
  OK   nmap « general purpose      » -> serveur
  OK   nmap « printer              » -> imprimante
  OK   nmap « switch               » -> routeur/switch
  OK   nmap « WAP                  » -> routeur/switch
  OK   nmap « firewall             » -> pare-feu
  OK   nmap « webcam               » -> camera
  OK   nmap « VoIP phone           » -> telephonie
  OK   nmap « quelque chose d'inédit » -> detecte_nmap
  OK   nmap « printer|print server » -> imprimante
```

---

## Rattrapage sans rescan

Page **Équipements**, bouton « Identifier les fabricants », visible tant qu'il reste des équipements non identifiés. Le sous-titre indique combien.

Ou par API : `POST /api/equipements/resoudre-fabricants` (admin + opérateur, cloisonné par site).

La réponse détaille : résolus, types précisés, MAC aléatoires, OUI absents du registre, et **fabricants SNMP conservés** — le rattrapage ne touche jamais à une valeur d'origine SNMP, plus fiable que l'OUI.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Source du registre | Table en base + graine embarquée | Seule option satisfaisant « sans Internet » **et** « sans redéployer » |
| Étendue | Registre complet (53 559) | Une liste curée écartait `A434D9`, votre propre cas |
| Format de la graine | JSON gzip, 517 Ko | Acceptable pour un dépôt ; 1,5 Mo décompressé en mémoire |
| Dépendance npm | **Aucune** | `oui-data` n'a servi qu'à générer le fichier |
| Priorité | SNMP > **OUI** > nmap | Le « fabricant » de nmap est un éditeur d'OS, pas un constructeur |
| MAC aléatoires | Registre non consulté, marquage explicite | Éviter un fabricant faux, et ne pas réexaminer inutilement |
| Affichage | Point médian gris + infobulle | Un badge sur 150 lignes deviendrait du bruit |
| Enrichissement du type | Constructeurs mono-produit seulement | Zéro risque d'erreur |
| HP + port 9100 | **Non implémenté**, signalé | Demande de réordonner le scan |
| Cache | 1 heure en mémoire | Le registre ne bouge qu'à l'import |

---

## Limites connues

1. **L'OUI identifie la carte, pas la machine.** Serveur Dell + carte Intel = « Intel ». Signalé dans l'interface par « · carte réseau ».
2. **Les MAC aléatoires resteront non identifiées.** C'est le but de cette technologie. Sur un parc avec beaucoup de smartphones, le taux d'identification plafonnera.
3. **Le registre vieillit.** L'IEEE publie de nouvelles attributions chaque semaine ; les blocs existants ne changent pas. Une mise à jour trimestrielle suffit.
4. **Machines virtuelles.** Certains hyperviseurs utilisent des MAC localement administrées : marquées « aléatoires », ce qui est exact mais peut surprendre.
5. **Pas de désambiguïsation MA-M / MA-S.** L'IEEE attribue aussi des blocs plus courts (28 et 36 bits) partagés entre plusieurs petits fabricants. Ils ne sont pas gérés : sur ces blocs, l'OUI 24 bits renvoie le nom du gestionnaire du bloc. Cas marginal en entreprise.

---

## SQL à exécuter

Fichier complet et commenté : **`backend/migrations/2026-08-17-oui-fabricant.sql`**

### 1. Structure

```sql
USE NetSecureManager;

CREATE TABLE IF NOT EXISTS OUI_FABRICANT (
  oui        CHAR(6) NOT NULL PRIMARY KEY,
  fabricant  VARCHAR(120) NOT NULL,
  date_maj   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE EQUIPEMENT
  ADD COLUMN fabricant_source ENUM('snmp','oui','nmap','mac_aleatoire') NULL AFTER fabricant;
```

### 2. Marquer la provenance de l'existant

Important : cela **protège** vos fabricants SNMP actuels du rattrapage OUI.

```sql
UPDATE EQUIPEMENT SET fabricant_source = 'snmp'
WHERE fabricant IS NOT NULL AND fabricant <> ''
  AND sys_descr IS NOT NULL AND sys_descr <> '' AND fabricant_source IS NULL;

UPDATE EQUIPEMENT SET fabricant_source = 'nmap'
WHERE fabricant IS NOT NULL AND fabricant <> ''
  AND (sys_descr IS NULL OR sys_descr = '') AND fabricant_source IS NULL;
```

### 3. Importer le registre

```bash
cd backend
node tools/importer-oui.js
```

### 4. Mesurer le potentiel sur votre parc

```sql
SELECT
  COUNT(*) AS total,
  SUM(fabricant IS NOT NULL AND fabricant <> '') AS avec_fabricant,
  SUM(adresse_mac IS NOT NULL AND adresse_mac <> '') AS avec_mac,
  SUM((fabricant IS NULL OR fabricant = '')
      AND adresse_mac IS NOT NULL AND adresse_mac <> '') AS identifiables_par_oui
FROM EQUIPEMENT;
```

La migration contient aussi la répartition par provenance, le palmarès des fabricants, et le décompte des MAC aléatoires de votre parc.

---

## Fichiers

**Créés** — `backend/data/oui-ieee.json.gz` (517 Ko), `backend/data/README.md`, `backend/src/services/ouiService.js`, `backend/tools/importer-oui.js`, `backend/migrations/2026-08-17-oui-fabricant.sql`, `frontend/src/Components/Fabricant.jsx`

**Modifiés** — `services/discoveryService.js` (priorité des sources, correctif du type nmap), `routes/scan.js` (écriture de `fabricant_source`, route de rattrapage, route d'état), `Components/EquipementsPage.jsx` (bouton de rattrapage, affichage), `Components/Dashboard.jsx` (affichage)

`package.json` inchangé — aucune dépendance ajoutée.

---

## Ordre des opérations

1. Exécuter les étapes 1 et 2 de la migration.
2. `node tools/importer-oui.js`
3. Redémarrer le backend.
4. Page **Équipements** → « Identifier les fabricants ». Le bilan s'affiche.
5. Vérifier `GET /api/oui/etat` : doit indiquer `table (53559 entrées)`. S'il indique « graine embarquée », l'import n'a pas abouti.
