# Taux de disponibilité par équipement — rapport

**Date :** 12 août 2026
**Périmètre :** consigne 2 uniquement. La consigne 3 (thème clair / mobile) reste à traiter.

**Vérifications :** backend 18/18 `node --check`, serveur démarre, route montée et protégée. Frontend compile en 544 ms, `oxlint` 0 erreur. **27 tests automatisés sur le calcul, 0 échec.**

**Migration SQL : aucune.** Le calcul n'utilise que des tables et colonnes existantes.

---

## Le choix de méthode : B pour calculer, A pour douter

Vous me demandiez de trancher. **J'ai retenu la méthode B (durées des alertes) pour le calcul, et la méthode A (relevés) comme mesure de confiance.**

### Pourquoi pas la méthode A seule

Le cas qui tranche : **si le backend est resté arrêté deux jours**, la méthode A compte deux jours de relevés manquants et conclut que *tous* les équipements ont été indisponibles deux jours.

C'est la réponse la plus fausse possible — elle confond « je n'ai pas regardé » avec « c'était en panne ». Et ce n'est pas théorique : chaque redémarrage du serveur, chaque coupure, chaque maintenance produirait un trou compté comme une panne généralisée.

S'y ajoutent les fragilités que vous citiez : la purge supprime les relevés au-delà de 30 jours (la période par défaut est donc pile à la limite), et `intervalle_scan_minutes` est modifiable, ce qui change le nombre de relevés attendus rétroactivement.

### Ce que la méthode A apporte quand même : la couverture

Les relevés restent le seul moyen de savoir **si la supervision tournait**. Je les utilise donc pour un usage différent : compter les **heures distinctes où au moins un équipement du parc a produit un relevé**.

Peu importe lequel. Ce qui est mesuré, c'est « le backend tournait-il à cette heure-là ». Cela sépare proprement deux situations que la méthode A confondait :

| Situation | Relevés de cet équipement | Relevés des autres |
|---|---|---|
| **Cet équipement était en panne** | absents | présents |
| **Le backend était arrêté** | absents | absents aussi |

Quand la couverture descend sous 80 %, le taux ferme est masqué et remplacé par un avertissement nommant la cause.

### Les angles morts de la méthode B, tous rendus explicites

**1. Les pannes courtes sont invisibles.** Une alerte n'est créée qu'après `seuil_echecs_avant_alerte` cycles consécutifs (3 minutes par défaut). Une coupure de 90 secondes ne laisse aucune trace. **Le taux affiché est donc structurellement un majorant** — la disponibilité réelle est au mieux celle indiquée, jamais meilleure. C'est écrit dans les avertissements, y compris quand le taux vaut 100 %.

**2. Les équipements récents n'ont pas d'historique.** Vous insistiez sur ce point. Le calcul est ramené à la durée d'existence réelle (`EQUIPEMENT.date_ajout`), et en dessous de 24 h d'observation le taux ferme est masqué. **Un équipement découvert il y a 3 heures n'affichera jamais 100 %.**

**3. Les alertes actives.** Une panne en cours n'a pas de `date_resolution` : elle est comptée jusqu'à l'instant présent, ce qui est le comportement attendu.

---

## Réponse de l'API

`GET /api/equipements/:id/disponibilite?jours=30`

```json
{
  "id_equipement": 7,
  "periode_jours": 30,
  "debut_effectif": "2026-07-13T...",
  "heures_observables": 720,
  "minutes_indisponible": 120,
  "nb_pannes": 1,
  "taux_disponibilite": 99.72,
  "taux_indicatif": 99.72,
  "fiable": true,
  "couverture_pourcent": 98.6,
  "avertissements": ["Les interruptions plus courtes que le seuil..."]
}
```

**Deux champs distincts, volontairement.** `taux_disponibilite` vaut `null` dès que le calcul n'est pas fiable — impossible d'afficher par mégarde un chiffre trompeur. `taux_indicatif` porte toujours la valeur brute, pour ceux qui veulent un ordre de grandeur en connaissance de cause. L'interface affiche le second en gris avec la mention « indicatif » quand le premier est absent.

---

## ⚠ Une limite qui dépasse le calcul : les sites distants

En implémentant, j'ai vérifié un point qui rend les taux **faux pour les sites distants**, indépendamment de la méthode choisie.

`cycleSupervision()` fait :

```js
const [equipements] = await db.query("SELECT * FROM EQUIPEMENT");
```

**Tous** les équipements, tous sites confondus, sont pingués **depuis le serveur central**. Or l'architecture multi-sites repose sur un agent local précisément parce qu'on ne peut pas atteindre un réseau privé distant depuis Internet — c'est écrit dans l'en-tête d'`agent.js`.

Conséquence : les équipements d'un site distant sont pingués depuis le central, échouent systématiquement, et sont marqués `down` en permanence. Leur taux de disponibilité tendra vers 0 % **alors qu'ils fonctionnent parfaitement**.

**Je ne l'ai pas corrigé** — c'est un choix d'architecture, pas un bug d'implémentation, et le corriger change le comportement de la supervision. Les pistes possibles :

1. Ne pinguer depuis le central que les équipements du site local, et se fier aux push de l'agent pour les autres (il faudrait alors un marqueur de site local, ou réutiliser `dernier_push IS NOT NULL` comme pour la surveillance des agents).
2. Faire remonter par l'agent le statut qu'il observe lui-même, plutôt que de le déduire d'un ping central.

La seconde est la plus juste conceptuellement : c'est l'agent qui est sur place.

**Tant que ce point n'est pas tranché, les taux ne sont significatifs que pour le site hébergeant le backend.**

---

## Performance

Vous demandiez d'évaluer le coût. Trois requêtes, **quel que soit le nombre d'équipements** :

| Requête | Coût |
|---|---|
| Lecture de l'équipement | clé primaire |
| Indisponibilités, tout le parc, `GROUP BY id_equipement` | index sur `ALERTE` |
| Couverture : `COUNT(DISTINCT heure)` sur `RELEVE` | index `idx_releve_date` |

La troisième est la seule coûteuse — elle balaie la plage de dates sur la table la plus volumineuse. Comme **elle donne le même résultat pour tous les équipements**, elle est mise en cache 5 minutes par période. Un rapport de 200 équipements l'exécute une fois, pas 200.

Mesuré sur banc : **2 ms pour 200 équipements** en mode lot.

Si `RELEVE` devenait très volumineuse malgré la purge, la piste suivante serait de matérialiser la couverture dans une petite table alimentée par le cron. Pas nécessaire aujourd'hui.

---

## Résultats des tests

```
=== Scénario 1 : parc sain, une panne de 2 h sur 30 jours ===
  OK   taux ≈ 99.72 %          OK   1 panne comptée
  OK   marqué fiable           OK   120 min d'indisponibilité

=== Scénario 2 : panne ENCORE ACTIVE (pas de date_resolution) ===
  OK   comptée jusqu'à maintenant (~180 min)
  OK   taux < 100 %

=== Scénario 3 : panne DÉBORDANT la fenêtre (commencée avant) ===
  OK   seule la partie dans la fenêtre compte (~1 j)

=== Scénario 4 : équipement découvert il y a 2 jours, période 30 j ===
  OK   calcul ramené à ~48 h observées, pas 720 h
  OK   avertissement explicite sur la période réelle
  OK   reste fiable (2 j > seuil de 24 h)

=== Scénario 5 : équipement découvert il y a 3 h ===
  OK   NON fiable
  OK   taux_disponibilite = null (pas de faux 100 %)
  OK   avertissement sur l'historique trop court

=== Scénario 6 : BACKEND ARRÊTÉ — le piège de la méthode A ===
  OK   NON fiable
  OK   couverture rapportée à 40 %
  OK   avertissement nomme la cause (backend arrêté)
  OK   taux ferme masqué
    -> la méthode A aurait annoncé 40 % de disponibilité
       pour un équipement jamais tombé

=== Scénario 7 : avertissement sur les pannes courtes ===
  OK   taux fiable = 100 %
  OK   mention « majorant » présente même à 100 %

=== Scénario 8 : mode lot (rapports) ===
  OK   200 équipements traités en 2 ms

=== Scénario 9 : bornes de période ===
  OK   jours=0 -> 30    OK   jours=9999 -> 365
  OK   jours='abc' -> 30    OK   équipement inexistant -> null

  27 test(s) réussi(s), 0 échec(s)
```

Le scénario 6 est celui qui justifie tout le reste : sans le contrôle de couverture, un équipement n'ayant jamais eu la moindre panne se serait vu attribuer 40 % de disponibilité.

---

## Où c'est visible

**`EquipementDetail.jsx`** — encadré au-dessus des graphiques : taux en grand, coloré selon le niveau (≥ 99 % vert, ≥ 95 % ambre, en dessous rouge), gris si non fiable. Sélecteur 7 / 30 / 90 jours. Nombre de pannes, minutes d'indisponibilité, heures réellement observées, et la liste des avertissements.

**Rapport PDF** — colonne disponibilité sur chaque ligne d'équipement, note méthodologique en petit sous le titre, et bandeau rouge si la couverture est insuffisante.

**Rapport Excel** — 4 colonnes ajoutées (taux, minutes d'indisponibilité, nombre de pannes, fiabilité du calcul) plus **un onglet « Méthode »** expliquant le calcul et ses limites. Le taux est stocké en valeur numérique pour permettre tris et graphiques ; c'est la colonne « Fiabilité » qui porte la nuance.

Cet onglet me paraissait nécessaire : un taux de disponibilité qui circule dans un fichier Excel finit par être lu hors contexte, souvent par quelqu'un qui n'a pas vu l'interface.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Méthode de calcul | Alertes (B), relevés en contrôle | La méthode A seule transforme un arrêt du backend en panne généralisée |
| Mesure de couverture | Sur tout le parc, pas par équipement | Sépare « cet équipement est tombé » de « le backend était arrêté » |
| Seuil de fiabilité | 80 % de couverture | En dessous, plus d'un cinquième de la période n'a pas été observé |
| Durée minimale | 24 h | En dessous, un taux n'a pas de sens statistique |
| Deux champs de taux | `taux_disponibilite` (null si douteux) + `taux_indicatif` | Rend impossible l'affichage accidentel d'un chiffre trompeur |
| Périodes proposées | 7 / 30 / 90 jours | 30 par défaut ; au-delà de 90 la purge des relevés fausse la couverture |
| Cache de couverture | 5 minutes | Une seule requête lourde par rapport au lieu d'une par équipement |
| Rapports | Sur 30 jours, non paramétrable | Aligné sur la fenêtre d'alertes déjà utilisée dans ces rapports |
| Onglet « Méthode » dans Excel | Ajouté | Un taux exporté circule hors contexte |
| Ping central des sites distants | **Non corrigé** | Choix d'architecture, à trancher — voir plus haut |

---

## Fichiers

**Créé** — `backend/src/services/disponibiliteService.js`

**Modifiés** — `backend/src/routes/scan.js` (route + import), `backend/src/routes/rapports.js` (PDF, Excel, onglet Méthode), `frontend/src/Components/EquipementDetail.jsx`

**SQL à exécuter : aucun.**

---

## Test manuel suggéré

1. Ouvrir un équipement depuis **Équipements** : l'encadré de disponibilité apparaît au-dessus des graphiques.
2. Basculer entre 7, 30 et 90 jours — les valeurs doivent varier de façon cohérente.
3. Sur un équipement scanné il y a moins de 24 h : le taux doit être grisé, marqué « indicatif », avec l'avertissement sur l'historique trop court.
4. Exporter le rapport Excel et ouvrir l'onglet **Méthode** : il indique la couverture réelle de votre période.
5. Si vous avez des équipements sur un site distant, comparez leur taux à leur état réel — c'est là que la limite du ping central se voit.

---

## Suite

Reste la consigne 3 : thème clair/sombre et adaptation mobile. Purement présentation, aucun impact fonctionnel. Dites-moi quand enchaîner.
