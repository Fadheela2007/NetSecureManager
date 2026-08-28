# Alertes sur seuils de performance — rapport

**Date :** 12 août 2026
**Périmètre :** consigne 1 uniquement. Les consignes 2 (taux de disponibilité) et 3 (thème clair/mobile) ne sont pas traitées ici.

**Vérifications :** backend 17/17 `node --check`, serveur démarre, frontend compile en 527 ms (contrôle de non-régression, aucun fichier frontend modifié). **20 tests automatisés sur l'anti-clignotement, 0 échec.**

**Migration :** 4 clés de configuration, aucune modification de structure.

---

## Les trois décisions que vous me demandiez de justifier

### 1. Hystérésis : oui, et c'est la protection la plus utile

J'ai mis **deux protections cumulées**, pas une seule :

| Protection | Rôle |
|---|---|
| **N relevés consécutifs** (3 par défaut) | Ignore les pics ponctuels — sauvegarde, antivirus, compilation |
| **Hystérésis** (marge 10 %) | Déclenche à 90 %, ne résout qu'en dessous de **80 %** |

La première seule ne suffit pas. Un processeur qui reste durablement autour du seuil oscille naturellement : 88, 92, 89, 91… Avec un seuil unique, chaque passage sous 90 résout l'alerte et chaque passage au-dessus la recrée — **avec une notification à chaque fois**.

**Mesuré sur banc de test**, même série d'oscillation `92, 88, 92, 88, 92, 88, 92, 88` :

```
sans hystérésis -> 4 alertes et 4 notifications
avec hystérésis -> 1 alerte,  1 notification
```

Entre 80 et 90 % se trouve une **zone morte** : ni alerte, ni résolution. C'est ce qui rend le comportement stable.

**Choix fait à votre place :** marge de 10 points plutôt qu'un second seuil par métrique. Une clé unique `marge_hysteresis_pourcent` évite de multiplier les réglages (sinon il en faudrait 4 : déclenchement et résolution pour CPU et RAM). Si vous voulez des marges différentes par métrique, c'est une ligne à changer.

### 2. Niveau : `warning`, pas `critical`

**Une charge élevée n'est pas une panne.** L'équipement répond, le service est peut-être dégradé mais pas interrompu. Réserver `critical` à l'indisponibilité garde au niveau sa valeur de signal — si tout est critique, plus rien ne l'est, et l'opérateur cesse de regarder.

Conséquence à connaître : ces alertes **suivent le même flux que les autres**, donc elles s'escaladent en incident au bout de `seuil_escalade_minutes` (15 min par défaut), comme les alertes de disponibilité. Un serveur saturé pendant 15 minutes ouvrira donc un incident. C'est cohérent, mais si vous trouvez cela trop bavard, la piste est de filtrer l'escalade sur le niveau — dites-le moi, je ne l'ai pas fait de mon propre chef car cela change le comportement de `escaladeIncidents()`.

### 3. Trafic : je n'ai pas ajouté d'alerte, et c'est délibéré

Vous laissiez le choix. **Un seuil absolu en kbps n'a aucun sens** sans connaître la capacité du lien : 50 000 kbps, c'est 5 % d'un lien gigabit et 500 % d'un lien 10 Mb/s. Le même chiffre serait tantôt normal, tantôt impossible.

L'indicateur pertinent est le **taux d'utilisation** = trafic ÷ capacité du lien. Il faudrait collecter `ifSpeed` (OID `1.3.6.1.2.1.2.2.1.5`), qui n'est pas relevé aujourd'hui, et rapporter le débit à l'interface concernée — sachant que `monitoringService` n'exploite que `interfaces[0]`.

Ce serait une fonctionnalité à part entière, pas une extension de celle-ci. **Ajouter un seuil arbitraire en kbps aurait produit un indicateur faux**, ce qui est pire que pas d'indicateur.

---

## Ce qui a été fait

### Évaluation à coût nul pour le cycle

L'évaluation travaille sur l'objet `metrics` que `checkEquipement` vient déjà d'obtenir. **Aucune interrogation SNMP supplémentaire**, aucune lecture de base en plus — sauf lors de la création effective d'une alerte, qui est rare par construction.

### Une amélioration collatérale : la configuration est lue une fois par cycle

En ajoutant 4 nouveaux seuils, je suis tombé sur un problème préexistant que j'avais signalé lors du premier audit sans le corriger : `getConfig()` était appelée **par équipement**. Sur 50 machines hors ligne, cela faisait 50 requêtes par minute pour lire la même valeur. Avec les seuils de charge, on serait passé à 4 requêtes par équipement.

`chargerConfigCycle()` lit maintenant **toute la configuration en une requête** au début du cycle et la transmet. Le nombre de requêtes de configuration passe de *N × 4* à **1 par cycle**.

*Effet de bord :* une modification de seuil depuis l'interface prend effet au cycle suivant (moins d'une minute), au lieu d'être vue immédiatement par les équipements traités après la modification. C'est plus cohérent : tous les équipements d'un même cycle sont désormais évalués avec la même configuration.

### Garde-fou NULL — le cas majoritaire

Vous aviez raison d'insister : la plupart des machines n'exposent pas HOST-RESOURCES-MIB. Le code écarte `null`, `undefined`, `NaN`, chaîne vide et toute valeur non numérique **avant toute comparaison**. Une valeur absente ne déclenche rien, ne résout rien, et remet le compteur à zéro pour ne pas cumuler des dépassements séparés par des trous de mesure.

Testé : `null`, `undefined`, `NaN`, `""`, `"abc"`, et `metrics` entièrement `null` — aucune alerte, aucune erreur.

### Suggestions de résolution

`cpu_eleve` et `ram_elevee` ont chacun 5 pistes concrètes. Deux qui me semblent les plus utiles en pratique :

- *CPU* — « Déterminer si la charge est ponctuelle ou durable : une sauvegarde, un antivirus ou une mise à jour saturent le processeur quelques minutes, ce qui est normal. »
- *RAM* — « Distinguer mémoire utilisée et mémoire mise en cache : sous Linux, un cache élevé est normal et n'indique pas une saturation. Vérifier avec `free -h` la ligne *available*. »

Cette dernière évite un faux positif classique : sous Linux, la mémoire « utilisée » au sens SNMP inclut le cache, et un serveur sain affiche souvent 90 %+.

---

## Résultats des tests

```
=== Anti-clignotement : 3 relevés consécutifs requis ===
  OK   2 relevés au-dessus du seuil -> aucune alerte
  OK   3e relevé -> 1 alerte
  OK   5 relevés de plus -> toujours 1 seule alerte (pas d'empilement)
  OK     1 seule notification envoyée
  OK     niveau = warning

=== Interruption : la série repart de zéro ===
  OK   2 au-dessus, 1 en dessous, 2 au-dessus -> aucune alerte

=== HYSTÉRÉSIS : oscillation 88-92 % autour du seuil 90 ===
  OK   alerte créée une fois
  OK   oscillation 85-93 % -> AUCUNE résolution (zone morte)
  OK   oscillation -> AUCUNE nouvelle alerte
  OK     aucune notification supplémentaire

=== Résolution : seulement sous 80 % (seuil 90 - marge 10) ===
  OK   79 % -> résolution
  OK   nouvelle montée durable -> nouvelle alerte

=== Sans hystérésis, ce que l'oscillation aurait donné ===
  -> 4 alertes et 4 notifications pour la MEME oscillation
  OK   l'hystérésis évite bien ce clignotement

=== Valeurs NULL (cas majoritaire) ===
  OK   aucune alerte sur valeurs nulles/invalides
  OK   aucune résolution parasite
  OK   metrics = null ne provoque pas d'erreur

=== RAM traitée indépendamment du CPU ===
  OK   RAM haute + CPU bas -> 1 alerte ram_elevee
  OK     aucune alerte cpu_eleve

  20 test(s) réussi(s), 0 échec(s)
```

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Hystérésis | Oui, marge de 10 points | Mesuré : divise par 4 le nombre d'alertes sur oscillation |
| Une clé de marge unique | Plutôt que 4 seuils | Évite de multiplier les réglages |
| Niveau | `warning` | Une charge n'est pas une panne ; préserve le sens de `critical` |
| Alerte trafic | **Non implémentée** | Un seuil absolu en kbps est un indicateur faux sans `ifSpeed` |
| Seuils par défaut | 90 % CPU et RAM | Repère usuel ; en dessous, trop de pics normaux |
| Relevés consécutifs | 3 | ≈ 3 minutes de charge soutenue avec un cycle d'une minute |
| Compteurs en mémoire | Plutôt qu'en base | Données volatiles ; évite une écriture par équipement et par cycle |
| Config lue par cycle | Au lieu de par équipement | Corrige un problème préexistant ; 1 requête au lieu de N × 4 |
| Alerte unique par métrique | Vérification avant insertion | Une alerte active à la fois par équipement et par type |

---

## Effets de bord anticipés

**1. Les compteurs sont perdus au redémarrage.** Un équipement déjà en charge doit à nouveau accumuler 3 relevés avant d'alerter. Sans gravité : les alertes déjà créées sont en base, seuls les compteurs volatils repartent à zéro.

**2. Une alerte de charge peut rester active si l'équipement cesse de répondre en SNMP.** Si SNMP tombe alors qu'une alerte est active, la valeur devient `NULL` : on ne résout pas (on ne sait pas), et l'alerte reste. C'est volontaire — résoudre sur une absence de donnée reviendrait à affirmer que tout va bien. Si l'équipement tombe complètement, l'alerte `equipement_down` prend le relais et signale le vrai problème.

**3. Escalade en incident au bout de 15 minutes.** Ces alertes suivent le flux commun. Voir la remarque en section « Niveau ».

**4. Sans matériel exposant HOST-RESOURCES-MIB, la fonctionnalité reste muette.** Ce n'est pas une anomalie. La requête de contrôle n° 1 de la migration vous dira combien d'équipements sont réellement concernés.

**5. Modification de seuil visible au cycle suivant.** Conséquence de la lecture unique par cycle (moins d'une minute).

---

## SQL à exécuter

Fichier complet : **`backend/migrations/2026-08-12-seuils-performance.sql`**

```sql
USE NetSecureManager;

INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('seuil_cpu_pourcent', '90',
   'Pourcentage de charge processeur au-delà duquel une alerte est déclenchée'),
  ('seuil_ram_pourcent', '90',
   'Pourcentage d''occupation mémoire au-delà duquel une alerte est déclenchée'),
  ('releves_consecutifs_avant_alerte_charge', '3',
   'Nombre de relevés consécutifs au-dessus du seuil avant de déclencher une alerte de charge'),
  ('marge_hysteresis_pourcent', '10',
   'Écart sous le seuil requis pour résoudre une alerte de charge (évite le clignotement)');
```

**Avant de laisser tourner**, la requête de contrôle n° 2 du fichier vous montre quels équipements auraient déjà déclenché une alerte sur les 7 derniers jours. C'est le meilleur moyen de calibrer les seuils sur vos données réelles plutôt que sur une valeur théorique.

---

## Fichiers modifiés

**Backend** — `services/monitoringService.js` (évaluation des seuils, config par cycle), `services/suggestions.js` (2 nouveaux codes de cause)

**Créé** — `backend/migrations/2026-08-12-seuils-performance.sql`

**Frontend** — aucun. Les nouvelles alertes s'affichent automatiquement dans `AlertesPage` avec leurs suggestions, et les nouvelles clés dans `ConfigurationPage`.

---

## Suite

Les consignes 2 (taux de disponibilité) et 3 (thème clair / mobile) restent à traiter. Dites-moi quand enchaîner — la 2 touche au backend et aux rapports, la 3 est purement de la présentation.
