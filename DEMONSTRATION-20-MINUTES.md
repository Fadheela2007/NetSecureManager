# Démonstration — 20 minutes, client non technique

Document de travail. À garder hors du dépôt public (voir la fin).

---

## La règle qui commande tout

Votre client ne veut pas voir un logiciel. Il veut savoir **ce qu'il ne sait pas
aujourd'hui**, et combien ça lui coûte.

Trois mots à ne jamais prononcer : *SNMP*, *CIDR*, *scan réseau*.
Trois mots à dire à la place : **« le parc »**, **« la plage d'adresses »**,
**« l'inventaire »**.

Et une règle de survie : **ne montrez jamais un écran que vous n'avez pas ouvert
la veille.** Une démonstration qui plante ne se rattrape pas.

---

## Avant qu'il arrive — 15 minutes de préparation

À faire le matin même, pas la veille :

1. Backend démarré, agent lancé, un **scan complet déjà passé** (le parc doit
   être plein quand vous ouvrez l'écran).
2. Un onglet de navigateur, **un seul**. Pas de terminal visible, pas de code,
   pas de VS Code dans la barre des tâches.
3. La politique de blocage **active**, avec `neverssl.com` en règle manuelle.
4. Un appareil que vous pouvez **débrancher** — une imprimante, une caméra, un
   petit switch. C'est votre meilleur moment de démonstration.
5. Vérifiez que vous êtes connectée en **administrateur**.

Si le réseau du client est instable ou inconnu, **faites la démonstration sur
votre propre réseau** et dites-le : « je vous montre sur mon parc, on installera
chez vous ensuite ». Personne ne s'en formalise. Une démonstration qui échoue
parce que leur wifi est capricieux, si.

---

## 0 — Ne commencez pas par le produit (2 min)

N'ouvrez rien. Posez trois questions et écoutez.

> « Aujourd'hui, si je vous demande combien d'appareils sont branchés sur votre
> réseau — ordinateurs, imprimantes, caméras, téléphones — vous auriez le
> chiffre ? »

> « Quand une imprimante ou une caméra tombe en panne, vous l'apprenez comment ?
> C'est quelqu'un qui vient vous le dire ? »

> « Et si un appareil qui n'est pas à vous se branchait sur votre réseau, vous
> le verriez ? »

Presque personne ne sait répondre. **C'est votre démonstration.** Tout ce qui
suit répond à ces trois questions, dans l'ordre.

Notez leurs réponses sur un papier, devant eux. Vous vous en resservirez à la
fin.

---

## 1 — « Il trouve tout seul » (4 min)

**Écran :** Sites → bouton *Scanner tout le site*.

Ne préparez rien. Lancez devant lui. Pendant que ça tourne :

> « Je ne lui ai rien dit. Aucune liste, aucune adresse, aucun mot de passe
> d'équipement. Il est en train de regarder le réseau et de trouver ce qui est
> branché dessus. »

Quand ça finit — **83 équipements, 72 secondes** sur votre parc :

> « 508 adresses possibles, examinées en une minute et douze secondes.
> 83 appareils trouvés. »

Puis la phrase qui vend :

> « Vous m'avez dit tout à l'heure que vous pensiez en avoir une trentaine. »

*(Ne dites cela que s'il a effectivement donné un chiffre plus bas. Sinon :
« la plupart des gens à qui je montre ça sous-estiment de moitié. » — c'est vrai,
c'est arrivé sur votre propre réseau : 35 machines visibles au lieu de 101.)*

**Le geste à ne pas rater :** si une plage n'a rien donné, montrez la ligne
*hors de portée* :

> « Et là, il ne me dit pas « zéro appareil ». Il me dit qu'il n'a pas pu
> regarder ce réseau-là. C'est la différence entre un outil qui vous rassure et
> un outil qui vous informe. »

---

## 2 — « Il sait ce que c'est » (3 min)

**Écran :** Équipements → cliquez sur une machine bien identifiée.

> « Pour chacun, il a trouvé le nom, le fabricant, et de quel type d'appareil il
> s'agit : un poste, une imprimante, une caméra. Sans que personne ne l'ait
> saisi. »

**Puis, volontairement, ouvrez-en un marqué « inconnu ».** C'est contre-intuitif
et c'est votre meilleur argument :

> « Celui-ci, il ne sait pas. Et il le dit. Il aurait pu deviner — beaucoup
> d'outils le font — mais un inventaire faux est pire qu'un inventaire
> incomplet. Quand cette case est remplie, vous pouvez vous y fier. »

Un client non technique retient ça. C'est la phrase qui vous distingue.

---

## 3 — « Il prévient avant vos employés » (4 min)

**C'est le moment le plus fort de la démonstration. Ne le ratez pas.**

Débranchez l'appareil que vous avez préparé. Devant lui, physiquement.

> « Je viens de débrancher l'imprimante. Personne ne l'a signalé. Personne ne
> s'en est rendu compte. Regardons. »

Parlez pendant l'attente — le cycle prend quelques minutes. C'est le bon moment
pour la question du coût :

> « Combien de temps, chez vous, entre le moment où quelque chose tombe et le
> moment où quelqu'un vous le dit ? Une heure ? Une matinée ? »

**Écran :** Alertes → l'alerte apparaît.

> « Il ne vous envoie pas dix messages pour la même panne. Un seul, et il compte
> les fois où le problème revient. Vous pouvez dire « je sais, je m'en occupe »,
> et il se tait sans oublier. »

Rebranchez, montrez que ça se referme.

> « Et l'historique reste. Dans six mois, vous saurez quel appareil vous a lâchée
> le plus souvent. C'est ce qui décide un remplacement. »

---

## 4 — « Vous décidez ce qui est accessible » (4 min)

**Écran :** Contrôle d'accès web.

Montrez les **catégories**, pas les listes.

> « Vous cochez ce que vous ne voulez pas sur votre réseau. Là, ça représente
> près de 79 000 sites. Vous n'avez aucune liste à écrire ni à tenir à jour. »

**Ne faites jamais défiler les noms de domaines à l'écran.** Montrez le
compteur, pas le contenu.

Puis le champ du message :

> « Et quand quelqu'un tombe dessus, il ne voit pas une erreur. Il voit ce que
> vous écrivez ici. »

**Écran :** un navigateur, `http://neverssl.com` → la page « Accès bloqué ».

> « Voilà ce que voit votre employé. Pas « la connexion a échoué » — votre
> message. Ça vous économise les appels au support. »

**Si le client demande « et sur les autres sites ? »** — répondez franchement :

> « Sur les sites sécurisés, la majorité aujourd'hui, le navigateur affiche sa
> propre erreur avant de nous laisser parler. Le site est bloqué, mais le message
> ne s'affiche pas. Pour aller plus loin il faut un équipement en coupure, ce
> qui est un autre budget. »

Cette honnêteté vaut plus que la fonction elle-même. Un client qui vous prend en
défaut plus tard ne signe pas.

---

## 5 — « Plusieurs agences » (2 min)

À ne faire **que** si le client a plusieurs sites. Sinon, sautez.

> « Chaque agence a un petit boîtier qui surveille son réseau et remonte ici.
> Et une personne rattachée à une agence ne voit que la sienne — pas par
> politesse d'affichage : le serveur refuse de lui donner le reste. »

---

## 6 — Fermez avec ses propres mots (2 min)

Reprenez le papier du début.

> « Vous m'avez dit que vous ne saviez pas combien d'appareils vous aviez : il y
> en a 83. Que vous l'appreniez par vos employés : maintenant vous le savez avant
> eux. Et qu'un appareil inconnu pouvait se brancher sans que vous le voyiez :
> il apparaîtrait dans cette liste au prochain passage. »

Puis taisez-vous. Laissez-le parler le premier.

---

## Ce qu'il ne faut PAS montrer

| À éviter | Pourquoi |
|---|---|
| La page Réinitialisation | Vous montrez le bouton qui efface tout. Aucun intérêt, gros malaise. |
| Un terminal, du code, VS Code | Il achète un produit, pas un chantier. |
| Les listes de domaines bloqués | Contenu embarrassant à l'écran. |
| La page Journal | Utile en exploitation, illisible en démonstration. |
| Un graphique vide | S'il n'y a pas de données, n'ouvrez pas l'écran. |
| Le taux « 100 % de disponibilité » | Toujours 100 % juste après un scan. Un technicien le relèvera. |

---

## Les trois questions qui vont tomber

**« Combien ça coûte ? »**
Ne bricolez pas un prix en direct. « Ça dépend du nombre de sites et
d'appareils. Je vous envoie une proposition chiffrée demain. » Puis envoyez-la
le lendemain, vraiment.

**« Et si ça tombe en panne ? »**
« Le logiciel est installé sur votre serveur, chez vous. Vos données ne sortent
pas. S'il s'arrête, votre réseau continue de fonctionner normalement — c'est un
observateur, il n'est pas sur le chemin. »

**« Il faut changer quelque chose sur mon réseau ? »**
« Non pour l'inventaire et les pannes. Pour la mesure de consommation par poste
et pour le blocage, il faut un équipement réseau administrable — je vérifie ça
chez vous avant de m'engager. » **Ne promettez pas ces deux fonctions avant
d'avoir vu leur matériel.**

---

## Répétition

Jouez-la **à voix haute, seule, chronomètre en main**, au moins une fois avant
le client. Pas dans votre tête : à voix haute. Vous découvrirez que la partie 3
est trop longue et que vous cherchez vos mots en 4.

Le but n'est pas d'apprendre par cœur. C'est de ne jamais être surprise par
votre propre écran.

---

## À faire de ce fichier

Il ne doit pas partir sur GitHub — c'est un document commercial, pas un
livrable. Ajoutez à `.gitignore` :

```
DEMONSTRATION-*.md
```
