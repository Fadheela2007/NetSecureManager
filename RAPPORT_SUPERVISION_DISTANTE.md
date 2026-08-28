# Correction de la supervision des sites distants

**Date :** 12 août 2026

**Vérifications :** backend 18/18 `node --check`, frontend compile en 784 ms, `oxlint` 0 erreur. **22 tests automatisés sur le nouveau flux, 0 échec.**

**Migration :** aucune modification de structure. Un script de nettoyage des données faussées.

---

## ⚠ Un bug actif découvert en testant

Avant tout le reste : **aucun agent ne pouvait plus transmettre.**

`server.js` montait deux routeurs ainsi, **avant** la route agent :

```js
app.use("/api/auth", authRoutes);
app.use("/api", requireAuth, plagesRoutes);        // ← ligne 23
app.use("/api", requireAuth, utilisateursRoutes);  // ← ligne 24
...
app.post("/api/agent/push", ...)                   // ← ligne 125
```

`app.use("/api", requireAuth, ...)` exécute `requireAuth` pour **toute** requête commençant par `/api` — y compris `/api/agent/push`. Le jeton d'agent n'étant pas un JWT, `jwt.verify` échouait et l'agent recevait :

```
401 {"error":"Session expirée, reconnectez-vous"}
```

Mes tests l'ont révélé : les huit scénarios de push échouaient tous avec ce message avant que je ne comprenne d'où il venait.

C'était précisément le point signalé dans le cahier des charges du premier audit — « vérifier que `/api/agent/push` est bien déclarée avant le middleware `requireAuth` global ». Il l'était à l'époque ; la régression est arrivée avec les montages ajoutés ensuite, dont le mien pour `utilisateurs`.

**Corrigé** : tous les routeurs protégés par JWT sont regroupés après la route agent, avec un commentaire d'avertissement à l'endroit où la tentation de remonter un `app.use` se présentera.

Ironie de la situation : ce bug aurait déclenché l'alerte `agent_muet` construite la semaine dernière, laquelle aurait correctement pointé vers un problème de transmission — sans dire que la cause était côté serveur.

---

## 1. Distinguer un site à agent d'un site local

**J'ai réutilisé `SITE.dernier_push IS NOT NULL`**, comme vous le suggériez. Le critère convient, et pour la même raison qu'il convenait pour l'alerte agent muet :

- Un site qui a **déjà transmis** est supervisé sur place. Le central ne le sonde plus.
- Un site qui **n'a jamais transmis** est scanné manuellement depuis l'interface, donc joignable depuis le central.

Aucune colonne ajoutée, aucun drapeau à cocher, aucune désynchronisation possible entre une case et la réalité.

**Le cas d'amorçage se résout tout seul.** Un site distant dont l'agent n'a pas encore poussé n'a aucun équipement en base — le push est ce qui les crée. Le central n'a donc rien à sonder, et la question ne se pose pas.

**Un cas limite assumé :** un site où le central *pourrait* atteindre les machines et où un agent tourne quand même (même réseau local, agent installé par redondance). Le central cesse de le sonder au premier push. Aucune perte réelle — l'agent couvre le site — mais les relevés de performance CPU/RAM ne sont plus collectés pour lui, puisque l'agent ne remonte que des statuts.

---

## 2. Qui détermine le statut : l'agent

**L'agent, pas le serveur.** Le serveur ne peut rien observer sur un réseau qu'il n'atteint pas : lui faire inférer un statut serait lui faire inventer une information.

Seul l'agent distingue « j'ai sondé cette machine et elle n'a pas répondu » de « je n'ai pas regardé ». C'est toute la différence entre une panne et un angle mort.

### Ce que l'agent transmet désormais

```js
{
  id_site, equipements,
  cidr: "192.168.10.0/24",   // la plage réellement balayée
  balayage_complet: true      // le balayage est allé à son terme
}
```

Ces deux champs sont ce qui autorise une déduction. Le serveur marque hors ligne un équipement seulement si **trois conditions** sont réunies : il est absent du relevé, son IP est **dans la plage balayée**, et le balayage a **abouti**.

Un équipement hors de la plage n'est pas concerné : l'agent ne l'a pas regardé. Un balayage interrompu (exception pendant `scanRange`) ne conclut rien — sans quoi une erreur transitoire déclarerait tout le site en panne d'un coup.

### Compatibilité ascendante

Un agent non redéployé n'envoie ni `cidr` ni `balayage_complet`. Le serveur marque alors `up` ce qu'il voit et **ne conclut rien sur le reste**. Un agent ancien ne peut donc pas provoquer de fausse panne — il perd seulement la détection des machines éteintes. La réponse du push contient `statut_deduit: false`, ce qui permet de repérer les agents à mettre à jour.

### Anti-clignotement conservé

Le compteur `echecs_consecutifs` est réutilisé tel quel : un équipement n'est déclaré `down` qu'après `seuil_echecs_avant_alerte` balayages consécutifs sans réponse — exactement comme pour un site local. Un ICMP perdu ne déclenche rien.

---

## 3. Agent muet : ni `down`, ni `up`, mais `inconnu`

Vous posiez exactement la bonne question. La réponse était déjà dans le schéma : `EQUIPEMENT.statut` est un `ENUM('up','down','inconnu')`. La troisième valeur n'était jamais utilisée — c'est précisément ce cas.

Quand `verifierAgents()` détecte un silence au-delà du seuil :

- Les équipements du site passent à **`inconnu`**. Les laisser à `up` afficherait un parc en bonne santé qui n'est peut-être plus là ; les passer à `down` inventerait une panne non constatée.
- `echecs_consecutifs` est remis à zéro : on ne compte pas des échecs qu'on n'a pas observés.
- Les alertes `equipement_down` encore actives sur ce site sont **clôturées**.

### Ce dernier point mérite une justification

Une alerte affirme « cette machine ne répond pas ». Dès qu'on cesse d'observer, on ne peut plus maintenir cette affirmation. Deux options :

- **Les laisser actives** : elles resteraient ouvertes indéfiniment et gonfleraient le temps d'indisponibilité dans le calcul de disponibilité, pour une période où l'on ne savait rien.
- **Les clôturer** : on perd la continuité d'une panne qui serait réelle et se poursuivrait.

**J'ai retenu la clôture**, parce que l'alerte `agent_muet` — de niveau `critical` — prend le relais et signale que le problème est désormais la perte de visibilité elle-même. Un opérateur voit un signal fort, correctement nommé, plutôt qu'une accumulation d'alertes qui prétendent en savoir plus qu'on n'en sait.

### Effet sur le tableau de bord

Les compteurs « En ligne » et « Hors ligne » ne comptent que `up` et `down` : des équipements en `inconnu` auraient disparu des totaux sans explication. J'ai ajouté une carte **« État inconnu »**, affichée uniquement quand ce nombre est non nul.

---

## 4. Données déjà en base : oui, il faut les corriger

Les équipements distants marqués `down` à tort et leurs alertes fictives sont dans la base. Le script `backend/migrations/2026-08-12-correction-supervision-distante.sql` procède en deux temps.

### Constats d'abord (ne modifient rien)

Trois requêtes : quels sites sont en mode agent, combien d'équipements sont marqués à tort, et — la plus parlante — **combien d'heures d'indisponibilité fictives** ont été accumulées par site.

### Corrections ensuite

| Étape | Action | Nature |
|---|---|---|
| 4 | Équipements distants → `inconnu` | sûre |
| 5 | Clôturer les alertes fictives actives | sûre, rien n'est supprimé |
| 6 | **Supprimer** les alertes fictives | **destructive, à décider** |

**Pourquoi `inconnu` et non `up` à l'étape 4 :** le serveur n'a jamais rien observé de fiable sur ces machines. Les déclarer en ligne serait aussi faux que de les déclarer hors ligne. Le premier push de l'agent tranchera, sur la foi d'une observation réelle.

**L'étape 6 est laissée commentée**, avec la commande `mysqldump` de sauvegarde et une variante prudente qui ne supprime que les alertes antérieures à la correction. Le choix est le vôtre : effacer un historique faux, ou le conserver en sachant qu'il ment.

---

## 5. Effet sur les taux de disponibilité

**Tout taux affiché jusqu'ici pour un équipement de site distant est faux, et proche de 0 %.** Le calcul additionne les durées des alertes `equipement_down` : des alertes permanentes donnent une indisponibilité permanente.

Après correction, trois trajectoires :

| Ce que vous faites | Effet sur les taux |
|---|---|
| Étapes 4 à 6 | Justes **immédiatement** |
| Étapes 4 et 5 seulement | Restent faussés tant que les alertes fictives sont dans la fenêtre (30 j). Se corrigent seuls en glissant hors fenêtre. Une période de **7 jours redevient juste plus vite** |
| Rien | **Faux indéfiniment** — une alerte active compte jusqu'à l'instant présent |

Les équipements des **sites locaux ne sont concernés par aucun de ces points** : leur supervision était correcte depuis le début.

Un détail à connaître : les sites à agent n'auront **aucun relevé de performance** (CPU, RAM, latence, trafic). L'agent remonte des statuts, pas des mesures. Le contrôle de couverture du calcul de disponibilité s'appuie sur l'ensemble du parc, il reste donc valide — mais les graphiques de `EquipementDetail` resteront vides pour ces machines. C'est une conséquence directe de l'architecture, pas un défaut : le central ne peut pas interroger en SNMP ce qu'il ne peut pas joindre.

---

## Résultats des tests

```
=== 1. Le cycle central ignore les sites à agent ===
  OK   seul l'équipement du site local est retenu
  OK     aucun équipement du site distant

=== 2. Push avec balayage complet : absent dans le CIDR -> compteur ===
  OK   push accepté                     OK   statut déduit signalé
  OK   absent : echecs=1, pas encore down
  OK   après 3 balayages : down         OK     compté dans la réponse

=== 3. Équipement HORS de la plage balayée : intact ===
  OK   172.16.0.99 hors du /24 -> statut inchangé

=== 4. Balayage PARTIEL : aucune déduction ===
  OK   statut_deduit = false            OK   absent NON pénalisé
    -> un balayage interrompu ne peut pas provoquer de panne générale

=== 5. Ancien agent (sans cidr ni balayage_complet) ===
  OK   push accepté                     OK   aucune déduction
    -> compatibilité ascendante : un agent non mis à jour reste sûr

=== 6. Retour en ligne : alerte résolue, compteur remis à zéro ===
  OK   statut repassé à up   OK   echecs remis à 0   OK   alerte résolue

=== 7. Agent muet : inconnu, pas down ===
  OK   tous les équipements du site -> inconnu
  OK   aucun marqué down à tort         OK   aucun laissé up à tort
  OK   alerte d'indispo clôturée (non observable)
  OK   le site LOCAL n'est pas touché

=== 8. Jeton d'agent : cloisonnement inchangé ===
  OK   mauvais jeton -> 403
  OK   CIDR invalide -> pas de plantage, aucune déduction

  22 test(s) réussi(s), 0 échec(s)
```

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Critère site local | `dernier_push IS NULL` | Réutilise la convention existante, aucune colonne |
| Qui décide du statut | L'agent | Le serveur ne peut rien observer à distance |
| Déduction des absents | Seulement si balayage complet **et** IP dans le CIDR | Un balayage partiel ne doit pas inventer une panne générale |
| Agents anciens | Acceptés, sans déduction | Aucun redéploiement forcé, aucun risque de fausse panne |
| Seuil avant `down` | `echecs_consecutifs` réutilisé | Comportement identique aux sites locaux |
| Agent muet | `inconnu` | Troisième valeur de l'ENUM, déjà prévue et inutilisée |
| Alertes pendant le silence | Clôturées | `agent_muet` porte le vrai signal ; sinon indisponibilité fictive |
| Carte « État inconnu » | Ajoutée au tableau de bord | Sinon les compteurs cessent de s'additionner |
| Suppression des alertes fictives | **Laissée à votre décision** | Destructive |
| Ordre de montage des routes | Corrigé + commentaire | Régression active, agents bloqués |

---

## Fichiers

**Backend** — `server.js` (ordre de montage, statuts déduits du push, deux fonctions ajoutées), `services/monitoringService.js` (périmètre du cycle, bascule en `inconnu`), `agent/agent.js` (déclaration du balayage)

**Frontend** — `Components/Dashboard.jsx` (carte « État inconnu »)

**Créé** — `backend/migrations/2026-08-12-correction-supervision-distante.sql`

---

## Ordre des opérations

1. **Redémarrer le backend.** Le bug d'ordre des routes est corrigé : vos agents peuvent de nouveau transmettre. C'est le point le plus urgent, indépendamment du reste.
2. **Lancer les constats** (requêtes 1 à 3) et regarder l'ampleur des dégâts.
3. **Exécuter les corrections** 4 et 5, décider pour la 6.
4. **Redéployer les agents** avec le nouveau `agent.js` — sans cela ils fonctionnent, mais les machines éteintes ne seront plus détectées. Vérifier `"statut_deduit": true` dans la réponse du premier push.
5. **Contrôler** qu'aucun relevé nouveau n'apparaît pour les sites à agent (requête en fin de migration).
