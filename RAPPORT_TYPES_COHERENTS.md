# Cohérence de la colonne Type — rapport

**Date :** 17 août 2026

**Vérifications :** backend 25/25 `node --check`, serveur démarre, frontend compile en 576 ms, `oxlint` 0 erreur. **43 tests automatisés, 0 échec**, dont 10 sur des chaînes `sysDescr` réelles.

---

## La cause commune de vos trois symptômes

Il manquait **la catégorie « poste de travail »** dans `TYPE_EQUIPEMENT`.

C'est la racine du symptôme n° 2 : la règle `if (texte.includes("windows")) return "serveur"` n'était pas une négligence, c'était la seule case disponible. Sans « poste de travail », tout ce qui tournait sous Windows devait aller quelque part.

S'y ajoutait un défaut de structure : le type était décidé à **trois endroits** sans vocabulaire commun — `fingerprint()` pour SNMP, le résultat brut de nmap, et la résolution OUI. Chacun produisait ses propres valeurs, dont `detecte_nmap` et `equipement_snmp`, qui sont des **noms de méthode**, pas des catégories.

**Une seule fonction décide désormais**, avec un vocabulaire fermé de 9 valeurs : `services/typeService.js`.

---

## Symptôme 1 — Windows 11 classé « serveur »

```
  OK   nmap « Microsoft Windows 11 24H2 » -> poste_travail
  OK     Windows 10 -> poste_travail
  OK     Windows 7 -> poste_travail
  OK     Windows Server 2019 -> serveur
  OK     Windows Server 2022 -> serveur
  OK     sysDescr NT nu -> inconnu
    -> l'ancienne règle donnait « serveur » aux 6 cas ci-dessus
```

**Le sixième cas mérite une explication.** Le `sysDescr` standard de Windows ne dit **pas** s'il s'agit d'une édition serveur ou poste :

```
Hardware: Intel64 Family 6 Model 142 - Software: Windows Version 6.3 (Build 9600 Multiprocessor Free)
```

« Windows Version 6.3 » est la version NT, pas le nom commercial. Impossible d'en tirer serveur ou poste. Conformément à votre consigne, le service renvoie **`inconnu`** plutôt que de deviner.

C'est nmap qui sauve la mise dans ces cas : lui restitue le nom commercial (« Microsoft Windows 11 24H2 »), donc le type est déterminé.

---

## Symptôme 2 — « detecte_nmap » dans la colonne Type

Cette valeur était produite comme repli quand le vocabulaire nmap n'était pas reconnu. Elle est **supprimée du chemin de classification** : toute valeur nmap non traduisible donne maintenant `inconnu`.

```
  OK   nmap « general purpose  » -> inconnu (jamais detecte_nmap)
  OK   nmap « specialized      » -> inconnu
  OK   nmap « power-device     » -> inconnu
  OK   nmap « game console     » -> inconnu
  OK   nmap « chose inédite    » -> inconnu
  OK   aucune valeur produite n'est un nom de méthode
```

**`equipement_snmp` subit le même sort** — vous ne l'aviez pas signalé, mais c'est le même défaut : « appareil qui répond en SNMP » décrit une méthode de détection, pas une catégorie d'équipement.

Détail volontaire : `general purpose` de nmap donne `inconnu` et **non** `serveur`. C'est précisément ce que nmap dit quand il ne sait pas trancher entre un poste et un serveur — le traduire en « serveur » reproduirait le symptôme n° 1 par une autre porte.

---

## Symptôme 3 — REALTEK sans type

**Ici, le comportement était correct** — et je ne l'ai pas « corrigé ».

Realtek fabrique les cartes réseau de PC de bureau, de téléviseurs, de routeurs domestiques et de NAS. Le fabricant de la puce ne dit rien du type d'appareil. Lui attribuer une catégorie serait exactement l'erreur que vous demandez d'éviter.

**Ce que j'ai fait à la place : donner à ces équipements une autre chance d'être classés.**

```
  OK   REALTEK seul -> inconnu (correct)
  OK   REALTEK + port 9100 -> imprimante
```

Le port 9100 (JetDirect) est quasi exclusivement une imprimante. Il **constate** au lieu de déduire.

### Deux découvertes qui bloquaient cette piste

**Le port 9100 n'était pas scanné.** `PORTS_COURANTS` couvrait 15 ports, aucun lié à l'impression. Votre piste « HP + port 9100 » ne pouvait donc pas fonctionner, faute de donnée. J'ai ajouté **515 (LPD), 554 (RTSP), 631 (IPP) et 9100 (JetDirect)** — quatre ports quasi mono-usage. Le coût est nul, `scanPorts` les teste en parallèle.

**Les ports arrivaient trop tard.** `scanPorts()` s'exécutait **après** l'insertion en base : au moment de décider du type, les ports étaient inconnus. Le scan est réordonné — les ports sont maintenant scannés dans `scanRange`, avant la classification, et le résultat est transmis à `routes/scan.js` pour éviter un second scan.

> Vous ne demandiez le port que combiné à un OUI HP. Je suis allé un cran plus loin : **le port seul suffit**. Un port 9100 ouvert est une imprimante quel que soit le fabricant de sa carte réseau. La combinaison avec l'OUI n'apportait rien de plus et aurait restreint la couverture.

---

## Ordre de confiance

| Rang | Source | Pourquoi à cette place |
|---|---|---|
| 1 | Texte SNMP | L'équipement se décrit lui-même |
| 2 | **Port révélateur** | Le port **constate**, nmap **déduit** |
| 3 | « Device type » de nmap | Analyse de la pile réseau |
| 4 | OS détecté par nmap | Nom commercial du système |
| 5 | Fabricant (OUI) | Constructeurs mono-produit uniquement |

```
  OK   SNMP prime sur le port
  OK   port prime sur nmap (le port constate, nmap déduit)
  OK   nmap device-type prime sur l'OS
  OK   fabricant en dernier recours
  OK     mais jamais contre un signal plus sûr
```

### Une nuance sur Linux

Le même mot ne vaut pas la même chose selon sa provenance :

```
  OK   Linux via SNMP -> serveur    (un agent snmpd installé = machine administrée)
  OK   Linux via nmap -> inconnu    (poste, Android ou routeur : indécidable)
```

Un `sysDescr` mentionnant Linux vient d'une machine sur laquelle quelqu'un a installé et configuré `snmpd` — c'est un serveur ou une appliance. La même chaîne détectée par nmap peut désigner n'importe quoi.

---

## Chaînes réelles vérifiées

```
  OK   routeur/switch <- Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M)…
  OK   pare-feu       <- FortiGate-60F v7.2.5,build1517,230606 (GA.F)
  OK   imprimante     <- HP ETHERNET MULTI-ENVIRONMENT,SN:CNBJK1234,PID:HP LaserJet…
  OK   routeur        <- RouterOS RB2011UiAS-2HnD
  OK   serveur        <- VMware ESXi 7.0.3 build-20328353
  OK   serveur        <- Linux srv-web01 5.15.0-91-generic #101-Ubuntu SMP x86_64
  OK   inconnu        <- APC Web/SNMP Management Card (MB:v4.1 PF:v6.8.2)
  OK   camera         <- AXIS P3245-LVE Network Camera
  OK   telephonie     <- Yealink SIP-T46S 66.85.0.5
  OK   imprimante     <- KYOCERA ECOSYS M5526cdw
```

La carte APC est instructive : c'est un onduleur. Aucune des neuf catégories ne lui convient, donc `inconnu`. La forcer dans « serveur » serait une erreur de plus.

**Les ports ambigus ne concluent jamais** — RDP (3389), SMB (445), SSH (22), HTTP (80/443) sont présents sur des postes comme sur des serveurs, et sont volontairement absents de la table des ports révélateurs.

---

## Reclassement sans rescan

Page **Équipements**, bouton **« Reclasser les types »**. Ou `POST /api/equipements/reclasser-types`.

Tout ce dont la classification a besoin est déjà en base : `sys_descr`, `os_detecte`, les ports dans `SERVICE_DETECTE`, et `fabricant`. Un nouveau balayage n'apporterait rien.

Le bilan distingue trois choses qui méritent de l'être :

- **`modifies`** — types corrigés
- **`passes_en_inconnu`** — équipements qui **perdent** une catégorie affirmée. C'est une correction voulue, pas une régression : mieux vaut l'absence de réponse qu'une réponse fausse. Affiché explicitement pour que ce ne soit pas une surprise.
- **`sans_port_scanne`** — équipements sans aucun port en base, qui ne bénéficieront de la déduction par port qu'après un prochain scan.

---

## Ce qui restera incohérent après correction

Vous demandiez de le signaler.

**1. Les équipements découverts avant aujourd'hui n'ont pas les nouveaux ports.** `SERVICE_DETECTE` ne contient pas 9100, 515, 631 ni 554 pour eux — ces ports n'étaient pas scannés. La déduction par port ne s'appliquera qu'après un nouveau scan. La requête de contrôle de la migration compte combien d'équipements sont dans ce cas.

**2. `sysName` n'est pas conservé en base.** Le reclassement travaille sur `sys_descr` seul, alors qu'un scan dispose aussi de `sysName`. Un nom d'hôte du type `NPI4A2B3C` (imprimante HP) est donc exploité au scan mais pas au reclassement. Ajouter une colonne `sys_name` corrigerait cela — je ne l'ai pas fait, c'est un ajout de structure hors périmètre.

**3. Le « Device type » de nmap n'est pas conservé non plus.** Même situation : disponible au scan, perdu ensuite.

**4. Les smartphones n'ont pas de catégorie.** Le vocabulaire que vous avez défini n'inclut pas « mobile ». Un téléphone Android identifié comme tel tombera en `inconnu` — un smartphone n'est pas un poste de travail. Ajouter la catégorie serait simple si vous le souhaitez.

**5. Si nmap n'est pas installé sur le serveur**, `nmapFingerprint()` renvoie `null` en silence et toute la branche nmap disparaît. Sur votre parc, cela expliquerait une part des « Inconnu » : sans SNMP (4 %) ni nmap, il ne reste que les ports et le fabricant. À vérifier avec `nmap --version` sur la machine du backend.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Catégorie manquante | Ajout de `poste_travail` | Cause racine du Windows → serveur |
| `detecte_nmap`, `equipement_snmp` | Retirés du chemin de classification | Noms de méthode, pas de catégories |
| nmap « general purpose » | → `inconnu`, pas `serveur` | Reproduirait le symptôme par une autre porte |
| Windows sans marqueur de version | → `inconnu` | Le sysDescr standard ne permet pas de trancher |
| Linux | `serveur` via SNMP, `inconnu` via nmap | Un agent snmpd installé traduit une machine administrée |
| Ports ajoutés | 515, 554, 631, 9100 | Quasi mono-usage ; coût nul (test parallèle) |
| Port seul vs OUI + port | **Port seul suffit** | Un port 9100 ouvert est une imprimante, quel que soit l'OUI |
| Ordre du scan | `scanPorts` avant l'insertion | Les ports étaient scannés trop tard pour servir |
| REALTEK | Reste `inconnu` | Realtek équipe PC, TV, routeurs — rien à en déduire |
| Onduleur APC | `inconnu` | Aucune des neuf catégories ne convient |
| Catégorie « mobile » | Non ajoutée | Absente de votre vocabulaire — signalée |

---

## Un coût à connaître

`scanPorts` est désormais appelé depuis `scanRange`, donc **aussi par l'agent distant**, qui ne le faisait pas. Cela ajoute environ **0,4 s par hôte actif** à son cycle — soit ~65 s pour 163 équipements, sur un cycle de 5 minutes.

C'est acceptable, et cela permet aux équipements des sites distants d'être correctement catégorisés. Mais l'agent **ne remonte pas encore** ces ports au serveur : `SERVICE_DETECTE` reste vide pour les sites distants. Le travail est fait mais le résultat n'est pas transmis. Ajouter `services` au push serait la suite logique — dites-le moi si vous voulez que je le fasse.

---

## SQL à exécuter

Fichier complet : **`backend/migrations/2026-08-17-types-coherents.sql`**

### 1. La catégorie manquante — obligatoire

```sql
USE NetSecureManager;

INSERT IGNORE INTO TYPE_EQUIPEMENT (libelle, description) VALUES
  ('poste_travail', 'Poste de travail (PC fixe ou portable)');
```

### 2. Constat avant correction

```sql
SELECT COALESCE(t.libelle, 'aucun type') AS type_actuel, COUNT(*) AS equipements,
       CASE t.libelle
         WHEN 'detecte_nmap'    THEN 'nom de méthode — à corriger'
         WHEN 'equipement_snmp' THEN 'nom de méthode — à corriger'
         WHEN 'serveur'         THEN 'à vérifier : postes Windows possibles'
         ELSE 'catégorie valide'
       END AS diagnostic
FROM EQUIPEMENT e
LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
GROUP BY t.libelle ORDER BY equipements DESC;
```

### 3. Puis le reclassement applicatif

Le SQL ne peut pas tout faire — la logique complète (ports, texte, fabricant) vit dans l'application :

```
POST /api/equipements/reclasser-types
```
ou le bouton **« Reclasser les types »** de la page Équipements.

La migration contient aussi les requêtes SQL pour les cas tranchables directement, et les contrôles d'après correction.

### 4. Facultatif — retirer les anciennes pseudo-catégories

Après le reclassement, et seulement si plus aucun équipement ne les référence (la clé étrangère vous protège sinon) :

```sql
-- DELETE FROM TYPE_EQUIPEMENT WHERE libelle IN ('detecte_nmap', 'equipement_snmp');
```

---

## Fichiers

**Créé** — `backend/src/services/typeService.js`, `backend/migrations/2026-08-17-types-coherents.sql`

**Modifiés** — `services/discoveryService.js` (4 ports ajoutés, scan des ports avant classification, appel au service, retrait de la table nmap devenue doublon), `routes/scan.js` (réutilisation des ports, route de reclassement), `Components/EquipementsPage.jsx` (bouton)

---

## Ordre des opérations

1. Exécuter l'étape 1 de la migration (`poste_travail`).
2. Redémarrer le backend.
3. Page **Équipements** → **« Reclasser les types »**. Lire le bilan.
4. Lancer un scan pour bénéficier des nouveaux ports, puis reclasser à nouveau — c'est là que les imprimantes muettes en SNMP apparaîtront.
5. Vérifier `nmap --version` sur le serveur : son absence explique une part des « Inconnu ».
