# Rapports planifiés par e-mail — rapport

**Date :** 13 août 2026
**Périmètre :** consigne A uniquement. La consigne B (relevés SNMP par l'agent) n'est pas traitée ici.

**Vérifications :** backend 20/20 `node --check`, serveur démarre sans erreur de chargement, les 4 routes de rapport répondent 401 sans jeton. **34 tests automatisés, 0 échec.** Test de non-régression sur la génération PDF : en-tête `%PDF-` valide.

---

## Le point le plus délicat : articulation avec la limitation des alertes

C'est la question que vous posiez, et c'est celle qui structure toute la solution.

**Les rapports utilisent un canal logique distinct : `"rapport"`.** Le transport SMTP est le même, mais le compteur de débit et le coupe-circuit sont séparés. Trois conséquences, toutes voulues :

| Situation | Effet |
|---|---|
| Rapport hebdomadaire vers 8 destinataires | Ne consomme rien du quota des alertes. Une alerte critique passe dans la même minute. |
| Le serveur mail refuse le rapport 5 fois | Le canal `rapport` est suspendu 15 min. **Les alertes continuent de partir.** |
| Le coupe-circuit des alertes se déclenche | N'empêche pas le rapport hebdomadaire. |

**Vérifié par test, pas supposé :**

```
=== Échec SMTP : tracé, coupe-circuit propre au canal rapport ===
  OK   aucun envoi réussi
  OK   échecs tracés en base
  OK   le canal ALERTES reste disponible
  OK   le canal RAPPORT est suspendu après 5 échecs
    -> un rapport en échec ne bloque pas les alertes critiques
```

Le plafond du canal rapport est fixé à 20 messages par minute — assez pour un parc de plusieurs dizaines de destinataires, et sans intérêt d'aller plus haut : un rapport n'est pas urgent.

---

## Le poids des pièces jointes : la crainte était infondée

Vous demandiez de vérifier. **Mesuré : 600 équipements produisent un PDF de 14 Ko.**

Le rapport est du texte, une ligne par équipement, sans image ni police embarquée. La croissance est linéaire et très plate : il faudrait environ **350 000 équipements** pour atteindre la limite.

J'ai quand même posé un garde-fou à **8 Mo**, pour une raison de principe : l'encodage base64 des pièces jointes ajoute ~33 %, donc 8 Mo de PDF font ~10,7 Mo sur le fil, ce que certains serveurs refusent déjà.

**Au-delà de la limite, l'e-mail part sans pièce jointe**, avec le résumé chiffré dans le corps et l'indication de télécharger le rapport depuis le tableau de bord. C'est préférable à un rejet SMTP : le destinataire est informé plutôt que de ne rien recevoir.

---

## Génération une fois par périmètre

Le rapport interroge plusieurs tables et génère un PDF. Il est produit **une fois par périmètre**, pas par destinataire.

Deux administrateurs globaux reçoivent le même document, généré une seule fois — vérifié en comparant la taille des pièces jointes reçues. Sur mon jeu de test : 4 destinataires répartis sur 3 périmètres → **3 générations, 4 envois**.

Les périmètres découlent directement de la convention de `getDestinataires()` :

- `id_site NULL` → **un** rapport de tous les sites, pour tous les administrateurs globaux
- `id_site = N` → **un** rapport du site N, pour ses utilisateurs rattachés

Le cloisonnement est vérifié sur le contenu : l'opérateur du site 2 reçoit un document intitulé « Yaounde » ne contenant qu'un équipement, alors que l'administrateur global en a trois.

---

## Rapport vide : pas d'envoi

Un périmètre sans équipement est ignoré, et le bilan indique pourquoi.

**Justification :** un rapport annonçant « 0 équipement supervisé » n'apporte aucune information. Pire, il apprend au destinataire à ignorer ces messages — et le jour où le rapport contiendra quelque chose d'important, il ne sera plus lu. Le cas se présente concrètement pour un site créé mais pas encore scanné, ou un opérateur rattaché à un site vide.

Le bilan reste explicite : `"ignore": "aucun équipement — envoi inutile"`. Rien n'est silencieux.

---

## Traçabilité

Chaque envoi est tracé dans `NOTIFICATION` avec `canal = 'rapport'`, ce qui le distingue immédiatement des notifications d'alerte.

`canal` étant un `ENUM('email','whatsapp')`, la migration propose de l'étendre. **Mais le code fonctionne sans :** si MySQL refuse la valeur, il retombe sur `'email'` et la trace est conservée. `id_alerte IS NULL` reste de toute façon un discriminant fiable — un rapport n'est lié à aucune alerte.

Testé dans les deux configurations :

```
  OK   canal = 'rapport'
  OK   ENUM sans 'rapport' -> repli sur 'email', trace conservée
```

---

## Planification

| Clé | Valeurs | Défaut |
|---|---|---|
| `rapport_planifie_frequence` | `desactive`, `hebdomadaire`, `mensuel` | **`desactive`** |
| `rapport_planifie_jour` | 1-7 (lundi=1) en hebdo, 1-28 en mensuel | 1 |
| `rapport_planifie_heure` | 0-23 | 8 |

**Défaut désactivé, délibérément.** Se mettre à écrire automatiquement à tous les administrateurs et opérateurs sans qu'ils l'aient demandé serait une mauvaise surprise. À vous d'ouvrir le robinet.

Le planificateur passe **toutes les heures à la 10ᵉ minute** — décalé de la supervision (chaque minute), de l'escalade (5 min) et de la purge (20ᵉ minute).

### Deux détails qui évitent des ennuis

**Le jour du mois est borné à 28.** Un envoi prévu le 30 serait purement et simplement sauté en février. Mieux vaut refuser la valeur que produire un rapport qui manque un mois sur douze.

**L'idempotence passe par la base, pas par la mémoire.** `rapport_planifie_dernier_envoi` est stocké dans `CONFIGURATION` : un redémarrage du serveur pendant l'heure d'envoi ne provoque donc pas un second courriel. Avec un compteur en mémoire, chaque redémarrage aurait renvoyé le rapport.

Testé, y compris le cas de l'horodatage corrompu — qui n'empêche pas l'envoi plutôt que de le bloquer indéfiniment.

---

## Pour tester sans attendre une semaine

Vous demandiez de tester réellement la planification. Deux routes ajoutées :

```
POST /api/rapport/envoyer-maintenant     (administrateurs uniquement)
GET  /api/rapport/planification
```

La première déclenche l'envoi immédiatement et renvoie un bilan détaillé : destinataires par périmètre, nombre d'équipements, poids de chaque pièce jointe, périmètres ignorés et pourquoi.

**Elle n'écrit pas l'horodatage de dernier envoi** — un test manuel ne fait donc pas sauter l'envoi automatique du jour.

La seconde dit où en est la planification (« ce n'est pas le jour », « déjà envoyé aujourd'hui »…) sans rien envoyer.

---

## Un nettoyage au passage

En extrayant la génération du PDF, je suis tombé sur de la duplication : `routes/rapports.js` collectait les données **deux fois**, une fois pour le PDF et une fois pour l'Excel, avec le même code recopié.

Tout est passé dans `services/rapportService.js`. La route est descendue de **149 à 119 lignes**, et il ne reste plus d'import inutilisé (`db`, `clauseSite`, `calculerDisponibiliteLot`, `formaterTaux` ne servaient plus).

Le PDF gagne aussi la ligne « État inconnu » quand des équipements sont dans cet état — cohérence avec la carte ajoutée au tableau de bord hier.

---

## Résultats des tests

```
=== Planification ===                        8 OK
=== Idempotence ===                          3 OK
=== Un PDF par périmètre ===                 9 OK
=== Rapport vide ===                         2 OK
=== Cloisonnement de la pièce jointe ===     3 OK
=== Traçabilité ===                          4 OK
=== Échec SMTP / coupe-circuit ===           4 OK
=== Poids de la pièce jointe ===             2 OK
                                            ------
                                       34 OK, 0 échec
```

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Canal de débit | `"rapport"`, distinct des alertes | Un rapport ne doit ni consommer le quota, ni suspendre les alertes |
| Plafond du canal | 20/minute | Suffisant, un rapport n'est pas urgent |
| Fréquence par défaut | **`desactive`** | Ne pas écrire à des gens sans leur accord |
| Limite de pièce jointe | 8 Mo | Marge pour le surcoût base64 (~33 %) |
| Au-delà de la limite | E-mail **sans** pièce jointe + explication | Mieux qu'un rejet SMTP silencieux |
| Rapport vide | Pas envoyé | Un rapport à 0 équipement apprend à ignorer les suivants |
| Jour du mois | Borné à 28 | Un envoi le 30 serait sauté en février |
| Idempotence | En base, pas en mémoire | Un redémarrage ne doit pas doubler l'envoi |
| Passage du planificateur | Horaire, 10ᵉ minute | Décalé des autres tâches |
| Route d'envoi manuel | Ajoutée | Sinon impossible de tester la planification |
| `canal = 'rapport'` | Avec repli sur `'email'` | Fonctionne avant et après la migration |
| Format | PDF seul | Le spec ne demandait que le PDF ; l'Excel reste téléchargeable |

---

## Limite connue

**La fréquence n'est pas modifiable depuis l'interface.** `ConfigurationPage` affiche tous les paramètres avec un champ `type="number"` — or `rapport_planifie_frequence` est du texte (`hebdomadaire`). Le champ s'affichera vide et refusera la saisie.

Le jour et l'heure, eux, sont numériques et se règlent normalement.

Je n'ai pas modifié `ConfigurationPage` : gérer des types de champ différents selon la clé demande de décrire les types quelque part, ce qui dépasse le périmètre de cette consigne. Deux options si vous voulez le régler :

1. Changer la fréquence en SQL (la commande est dans la migration) — suffisant si ce réglage bouge rarement.
2. Faire évoluer `ConfigurationPage` pour reconnaître les clés à valeurs énumérées et afficher un menu déroulant. Dites-le moi si vous voulez que je le fasse.

---

## SQL à exécuter

Fichier complet et commenté : **`backend/migrations/2026-08-13-rapports-planifies.sql`**

### Obligatoire

```sql
USE NetSecureManager;

INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('rapport_planifie_frequence', 'desactive',
   'Fréquence d''envoi du rapport par e-mail : desactive, hebdomadaire ou mensuel'),
  ('rapport_planifie_jour', '1',
   'Jour d''envoi — hebdomadaire : 1=lundi à 7=dimanche ; mensuel : 1 à 28'),
  ('rapport_planifie_heure', '8',
   'Heure d''envoi du rapport planifié (0 à 23, heure du serveur)'),
  ('rapport_planifie_dernier_envoi', '',
   'Horodatage du dernier rapport planifié envoyé (géré par le serveur)');
```

### Recommandé — lisibilité du journal

```sql
-- Vérifier d'abord la définition réelle :
SHOW COLUMNS FROM NOTIFICATION LIKE 'canal';

-- Si le résultat est bien enum('email','whatsapp') :
ALTER TABLE NOTIFICATION
  MODIFY COLUMN canal ENUM('email','whatsapp','rapport') NOT NULL;
```

⚠ Si votre ENUM contient d'autres valeurs, **adapter la liste** — un `MODIFY` la remplace entièrement.

### Activation, quand vous serez prête

```sql
-- Chaque lundi à 7 h :
UPDATE CONFIGURATION SET valeur = 'hebdomadaire' WHERE cle = 'rapport_planifie_frequence';
UPDATE CONFIGURATION SET valeur = '1'            WHERE cle = 'rapport_planifie_jour';
UPDATE CONFIGURATION SET valeur = '7'            WHERE cle = 'rapport_planifie_heure';
```

La migration contient aussi trois requêtes de contrôle : qui recevra quoi, quels périmètres seront ignorés faute d'équipements, et les traces après un envoi.

---

## Fichiers

**Créés** — `backend/src/services/rapportService.js`, `backend/src/services/rapportPlanifieService.js`, `backend/migrations/2026-08-13-rapports-planifies.sql`

**Modifiés** — `routes/rapports.js` (délégation au service, 2 routes ajoutées, 30 lignes en moins), `services/notificationService.js` (`envoyerRapport` + canal dédié), `services/monitoringService.js` (cron du planificateur)

**Aucun fichier frontend modifié.**

---

## Ordre des opérations

1. Exécuter la partie obligatoire de la migration.
2. Redémarrer le backend.
3. **Tester** avec `POST /api/rapport/envoyer-maintenant` et lire le bilan renvoyé — c'est là que vous verrez qui reçoit quoi et le poids réel de vos pièces jointes.
4. Vérifier la réception, puis activer la fréquence voulue.

---

## Suite

La consigne B (relevés SNMP par l'agent) reste à traiter. Dites-moi quand — elle touche à l'architecture agent, autant la prendre à froid.
