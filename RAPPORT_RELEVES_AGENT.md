# Relevés SNMP par l'agent — rapport

**Date :** 13 août 2026
**Périmètre :** consigne B.

**Vérifications :** backend 20/20 `node --check`, serveur démarre, `monitoringService` et `agent.js` s'importent sans dépendance circulaire. **26 tests automatisés sur le flux complet, 0 échec.**

**Migration SQL : aucune** — sous réserve que la migration du 10 août (colonne `index_snmp` sur `INTERFACE_RESEAU`) ait été appliquée. Sinon les relevés fonctionnent, seul l'inventaire des interfaces échoue en silence.

---

## Qui garde le compteur précédent : l'agent

C'est la question centrale, et **l'argument décisif n'est pas celui auquel on pense**.

Le débit se calcule par différence entre deux compteurs cumulés. Cela suppose de connaître le précédent, mais surtout **l'intervalle exact qui les sépare**.

| | L'agent calcule | Le central calcule |
|---|---|---|
| Intervalle mesuré | entre ses deux lectures SNMP — **exact** | entre deux réceptions de push |
| Sensible à la latence réseau | non | **oui** |
| Sensible aux reprises sur erreur | non | **oui** |
| Survit au redémarrage de l'agent | non | oui |

Un push retardé de 30 secondes fausserait un calcul côté central **sans que rien ne le signale** : on obtiendrait un débit plausible mais faux. Pour un outil de diagnostic, c'est le pire résultat possible — pire qu'une valeur absente, qu'on sait interpréter.

**Décision : l'agent calcule.** Ce qui circule sur le réseau est alors une grandeur physique (kbit/s) et non un compteur brut qui n'a de sens qu'avec un état côté serveur.

**Contrepartie assumée :** au redémarrage de l'agent, le cache est vide et le premier cycle ne remonte pas de débit — les champs restent `NULL`. C'est honnête : on ne calcule pas une différence sans point de départ. Cela se corrige seul au cycle suivant.

Au passage, une précision sur la question posée : *« le serveur central doit alors distinguer les compteurs de chaque site »* — ce problème n'existait pas. `id_equipement` est unique pour toute la plateforme, la `Map` existante aurait suffi. Ce n'est donc pas ce qui a tranché.

### Vérifié par test

```
=== Débit : premier cycle NULL, second calculé ===
  OK   1er cycle : trafic NULL (pas de point de départ)
  OK     CPU/RAM quand même remontés
  OK   2e cycle : débit calculé
     128 ko en ~1,1 s -> 907 kbit/s (attendu ~900)

=== Redémarrage de l'agent ===
  OK   après redémarrage, trafic NULL
  OK     puis se rétablit seul

=== Débordement de compteur 32 bits ===
  OK   delta négatif -> NULL, pas de débit aberrant
```

Le dernier point compte : `ifInOctets` est un compteur 32 bits qui déborde. Un delta négatif signale un débordement ou un redémarrage de l'équipement — on remonte `NULL` plutôt qu'un débit délirant.

---

## Ne pas alourdir l'agent : deux arbitrages distincts

### 1. Ne sonder que ce qui répond en SNMP

C'est l'optimisation la plus importante, et elle règle en même temps votre remarque sur les équipements muets.

Sur un parc courant, la grande majorité des machines n'expose pas SNMP. Les interroger quand même coûterait **4 interrogations à 3 s de délai d'attente, soit jusqu'à 12 secondes par machine muette** — sur 50 machines, 10 minutes de balayage pour aucun résultat.

`scanRange` a déjà déterminé qui répond : les équipements dont `sys_descr` est renseigné. L'agent se limite à ceux-là.

```
=== Collecte : seuls les équipements répondant en SNMP sont sondés ===
  OK   1 seul équipement sondé sur 3
  OK     aucune interrogation des machines muettes
```

**Ni erreur, ni trafic inutile** — pas parce que les erreurs sont attrapées, mais parce que la requête n'est pas émise.

### 2. Inventaire des interfaces : espacé

Même raisonnement que côté serveur, transposé au rythme de l'agent. L'inventaire double le coût SNMP (4 tables de plus par équipement), et le nom, la MAC ou le VLAN d'une interface ne changent qu'à la reconfiguration d'un switch.

L'agent le collecte **au premier cycle après démarrage, puis un cycle sur 12** (`INVENTAIRE_TOUS_LES_N_CYCLES`, réglable dans son `.env`, `0` pour désactiver). À 5 minutes de cycle, cela fait une actualisation par heure.

Différence avec le serveur, qui le réservait aux scans : pour l'agent, chaque cycle *est* un scan. Il fallait donc un autre critère de rareté — d'où le compteur de cycles.

---

## Les alertes de performance s'appliquent bien aux relevés poussés

Vous aviez raison de le signaler : sans cela, la fonctionnalité aurait été **silencieusement à moitié morte**. Les seuils étaient évalués dans `checkEquipement`, donc uniquement dans le cycle local.

`evaluerChargeDepuisPush()` est appelée depuis la réception du push. Point important : **les compteurs de dépassement sont les mêmes** (`depassements`, clé `id_equipement`). L'hystérésis et le nombre de relevés consécutifs s'appliquent donc à l'identique, quelle que soit la provenance du relevé.

```
=== SEUILS DE CHARGE sur relevés poussés (le point clé) ===
  OK   2 relevés à 95 % : pas encore d'alerte
  OK   3e relevé : alerte cpu_eleve créée
  OK     niveau warning
  OK   hystérésis : oscillation 88-92 -> pas de 2e alerte
```

La configuration est lue **une fois par lot**, pas par équipement — même optimisation que dans le cycle local.

---

## Valeurs NULL

```
=== Valeurs NULL : aucune alerte, aucune erreur ===
  OK   5 relevés NULL -> 0 alerte
  OK     relevés quand même enregistrés (latence)
```

Le second point mérite un mot : un équipement sans SNMP ne produit **aucun** relevé (il n'est pas sondé). Mais un équipement qui répond en SNMP sans exposer `HOST-RESOURCES-MIB` produit un relevé avec `cpu_pourcent` et `ram_pourcent` à `NULL` — et sa latence, elle, est utile. On l'enregistre donc.

---

## Compatibilité

```
=== Compatibilité : agent non redéployé ===
  OK   push sans champ releves accepté
  OK     0 relevé, 0 erreur
```

Même principe que pour `cidr` et `balayage_complet` : champ absent, rien ne se passe. Un agent non redéployé continue de remonter les statuts, il ne remonte simplement pas de métriques.

La réponse du push l'indique : `"releves": 0`, `"interfaces": 0`.

Et si la colonne `index_snmp` manque encore en base, l'inventaire échoue en silence sans faire échouer le push :

```
=== Interfaces : colonne index_snmp absente -> échec silencieux ===
  Interface eth0 de 192.168.10.20 ignorée: Unknown column 'index_snmp'
  OK   push réussit malgré l'erreur SQL
```

---

## Volume de `RELEVE` — votre rétention de 6 jours tient

Vous avez la rétention à 6 jours. Projection, sachant qu'**une ligne n'est produite que par un équipement répondant en SNMP** :

| Scénario | lignes/jour | sur 6 jours | Taille estimée |
|---|---|---|---|
| Site local seul, 20 éq, cycle 1 min *(situation actuelle)* | 28 800 | 172 800 | ~13 Mo |
| 3 agents × 100 éq, **5 %** en SNMP | 33 120 | 198 720 | ~15 Mo |
| 3 agents × 100 éq, **20 %** en SNMP | 46 080 | 276 480 | ~21 Mo |
| 3 agents × 100 éq, **50 %** en SNMP | 72 000 | 432 000 | ~33 Mo |

**Le site local domine le volume**, et de loin : il tourne à la minute alors que les agents tournent aux 5 minutes. Passer de 0 à 300 équipements distants avec 20 % de couverture SNMP fait croître le volume de **60 %**, pas d'un facteur 15.

**6 jours de rétention restent très confortables.** L'index `idx_releve_date` ajouté le 10 août rend la purge efficace sur ces volumes.

Le levier le plus efficace si le volume devenait un souci n'est pas la rétention mais **l'intervalle du site local** : passer `intervalle_scan_minutes` de 1 à 2 divise par deux la source principale.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Qui calcule le débit | **L'agent** | Seul lui connaît l'intervalle exact entre ses lectures |
| Au redémarrage de l'agent | Trafic `NULL` un cycle | Mieux qu'une valeur inventée ; se corrige seul |
| Delta négatif | `NULL` | Débordement de compteur ou redémarrage d'équipement |
| Qui est sondé | Uniquement `sys_descr` renseigné | Évite jusqu'à 12 s de timeouts par machine muette |
| Inventaire des interfaces | 1er cycle puis 1 sur 12 | Données quasi statiques ; réglable dans le `.env` de l'agent |
| Interface retenue pour le débit | La première | Aligné sur le cycle central — limite ci-dessous |
| Relevé avec CPU/RAM `NULL` | Enregistré quand même | La latence reste utile |
| Seuils de charge | Évalués sur les pushs, compteurs partagés | Sinon la fonctionnalité ne marcherait que sur le site local |
| Démarrage auto de l'agent | Protégé par `require.main === module` | Un `require` déclenchait un balayage réseau complet |

---

## Limites connues

**1. Une seule interface pour le débit.** L'agent retient `interfaces[0]`, comme le fait le cycle central. Sur un switch à 24 ports, le débit remonté est celui de la première interface, pas le total. C'est une limite préexistante que je n'ai pas élargie pour rester cohérent avec le comportement du site local — mais elle est plus visible maintenant que les switches distants sont supervisés. La corriger demanderait de décider quoi remonter : somme, interface la plus chargée, ou une ligne de `RELEVE` par interface.

**2. SNMPv3 non couvert pour les métriques.** `snmpTable()` ouvre une session v1/v2c. Un équipement configuré exclusivement en v3 répondra au `snmpProbe` de `scanRange` (qui gère v3) mais pas à `snmpMetrics`. Il apparaîtra donc dans les équipements sans produire de relevé.

**3. La communauté SNMP de l'agent est globale.** L'agent utilise `SNMP_COMMUNITY` de son `.env` pour tout son périmètre, alors que le serveur central sait lire les paramètres par plage dans `PLAGE_SCAN`. Un site avec plusieurs communautés différentes n'est pas couvert. L'agent pourrait interroger le central pour récupérer ses plages — ce serait la suite logique.

**4. Un relevé par cycle d'agent, pas par minute.** Les graphiques des équipements distants seront moins denses que ceux du site local (un point toutes les 5 minutes au lieu d'une minute). C'est visible à l'œil sur `EquipementDetail`, et normal.

---

## SQL à exécuter

**Aucune migration nouvelle.** Deux contrôles utiles :

```sql
USE NetSecureManager;

-- 1) La colonne index_snmp existe-t-elle ? (migration du 10 août)
--    Sans elle, les relevés fonctionnent mais l'inventaire des interfaces
--    échoue en silence — visible dans la console du backend.
SHOW COLUMNS FROM INTERFACE_RESEAU LIKE 'index_snmp';

-- 2) Après quelques cycles d'agent : les relevés arrivent-ils ?
SELECT s.nom AS site,
       COUNT(DISTINCT r.id_equipement) AS equipements_avec_releve,
       COUNT(*) AS releves_1h,
       SUM(r.cpu_pourcent IS NOT NULL) AS avec_cpu,
       SUM(r.trafic_entrant_kbps IS NOT NULL) AS avec_debit
FROM RELEVE r
JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
JOIN SITE s ON s.id_site = e.id_site
WHERE r.date_releve >= NOW() - INTERVAL 1 HOUR
GROUP BY s.id_site, s.nom;
```

Sur un site à agent, `avec_debit` doit être inférieur à `releves_1h` : le premier relevé après chaque redémarrage de l'agent n'a pas de débit. Un écart d'un ou deux est normal ; un `avec_debit` à 0 signale un agent qui redémarre en boucle.

---

## Fichiers

**Modifiés** — `agent/agent.js` (collecte SNMP, calcul du débit, inventaire espacé, garde de démarrage), `server.js` (`enregistrerReleves`, `enregistrerInterfacesAgent`, réponse enrichie), `services/monitoringService.js` (`evaluerChargeDepuisPush`)

**Aucun fichier frontend modifié** — `EquipementDetail` lit `RELEVE` et `INTERFACE_RESEAU` sans se soucier de leur provenance.

---

## Déploiement

1. **Redéployer les agents** avec le nouveau `agent.js`. Optionnellement, ajouter à leur `.env` :
   ```
   SNMP_COMMUNITY=public
   INVENTAIRE_TOUS_LES_N_CYCLES=12
   ```
   Les deux ont des valeurs par défaut : rien n'est obligatoire.

2. **Vérifier la réponse du premier push** — elle contient désormais `releves`, `seuils_evalues` et `interfaces`. Le journal de l'agent affiche aussi combien d'équipements ont été sondés en SNMP.

3. **Attendre deux cycles** avant de juger le débit : le premier ne peut pas en produire.

4. **Ouvrir un équipement distant** répondant en SNMP : ses graphiques CPU/RAM ne doivent plus être vides.
