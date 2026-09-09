# Démonstration — déroulé complet, 20 minutes

Document de travail. À garder hors du dépôt public (voir la fin).

Pour chaque partie : **ce que ça fait**, **comment ça se passe**, **ce que
vous dites**, et **ce qui peut mal tourner**.

| | Partie | Durée |
|---|---|---|
| 0 | Avant d'ouvrir quoi que ce soit | 2 min |
| 1 | Il trouve tout seul | 4 min |
| 2 | Il sait ce que c'est | 3 min |
| 3 | Il prévient avant vos employés | 4 min |
| 4 | Vous décidez ce qui est accessible | 4 min |
| 5 | Plusieurs agences *(à sauter si un seul site)* | 2 min |
| 6 | Fermez avec ses propres mots | 2 min |

---

## Deux publics, deux cadrages

Le déroulé est le même. **Le cadrage change.**

Devant un **dirigeant**, vous parlez de ce qu'il ignore et de ce que ça
lui coûte. Devant un **responsable informatique**, la même phrase sonne
comme une accusation : *« vous ne maîtrisez pas votre réseau »*. Il
défendra son territoire et trouvera dix raisons techniques de dire non.

Retournez-la. **L'outil travaille pour lui, pas contre lui** : il apprend
les pannes avant que la direction ne l'appelle, il a un inventaire à jour
sans le tenir à la main, et des chiffres à montrer quand il demande un
budget.

Vocabulaire : avec un dirigeant, jamais *SNMP*, *CIDR*, *scan*. Avec un
technicien, parlez normalement — traduire vous ferait passer pour
quelqu'un qui récite.

---

## Avant qu'ils arrivent

À faire le matin même, pas la veille :

1. **Redémarrez tout depuis zéro** : backend, base, agent si vous montrez
   le blocage web.
2. **Vérifiez que la supervision tourne.** Au démarrage du backend, aucun
   avertissement « supervision centrale à l'arrêt » ne doit apparaître.
   C'est arrivé jeudi : les 135 équipements n'étaient surveillés par
   personne, et rien ne le disait à l'écran.
3. **Un scan complet déjà passé**, pour que le parc soit rempli à
   l'ouverture.
4. **Un onglet de navigateur, un seul.** Pas de terminal, pas de VS Code
   dans la barre des tâches.
5. **Un appareil que vous pouvez débrancher** — imprimante, caméra, petit
   switch. C'est votre meilleur moment.
6. Connectée en **administrateur**.

Si leur réseau est inconnu ou instable, **faites la démonstration sur le
vôtre** et dites-le : *« je vous montre sur mon parc, on installera chez
vous ensuite »*. Personne ne s'en formalise. Une démonstration qui échoue
à cause de leur wifi, si.

---

# Partie 0 — Avant d'ouvrir quoi que ce soit

**2 minutes. Aucun écran.**

### Ce que ça fait

Installe le problème dans leur tête **avant** la solution. Sans elle, tout
ce qui suit est une liste de fonctions. Avec elle, chaque écran répond à
une question qu'ils se sont posée eux-mêmes.

Vous y récoltez aussi un chiffre qu'ils ont donné — et un chiffre qu'on a
donné soi-même, on ne le conteste pas.

### Comment ça se passe

Écran fermé. Un papier devant vous. Vous posez trois questions et vous
**écoutez** — la tentation est de répondre à leur place.

**Devant un dirigeant :**

> « Si je vous demande combien d'appareils sont branchés sur votre réseau
> — ordinateurs, imprimantes, caméras, téléphones — vous auriez le
> chiffre ? »
>
> « Quand une imprimante ou une caméra tombe en panne, vous l'apprenez
> comment ? Quelqu'un vient vous le dire ? »
>
> « Et si un appareil qui n'est pas à vous se branchait sur votre réseau,
> vous le verriez ? »

**Devant un responsable informatique** — même diagnostic, autre angle :

> « Combien de temps vous prend la mise à jour de votre inventaire ? »
>
> « Vous apprenez les pannes par vos utilisateurs ou par un outil ? »
>
> « Si votre direction vous demandait demain la liste exacte de ce qui
> tourne sur le réseau, vous mettriez combien de temps ? »

S'ils donnent un chiffre, **notez-le sur le papier devant eux.** Le geste
le rend officiel.

### Ce qui peut mal tourner

Ils répondent « je sais très bien ce qu'il y a sur mon réseau ». Ne
contredisez pas. Répondez : *« alors on va vérifier ensemble, ça prend une
minute »* — et enchaînez sur la partie 1. Le scan tranchera.

---

# Partie 1 — Il trouve tout seul

**4 minutes.**

### Ce que ça fait

Démontre la découverte automatique. Trois preuves d'un coup : ça marche
sans configuration, c'est rapide, et le parc réel est plus grand que ce
qu'on croit.

### Comment ça se passe

**Écran : Sites → « Scanner tout le site ».** Ne préparez rien, lancez
devant eux. Ça tourne plus d'une minute — il faut parler pendant.

> « Je ne lui ai rien dit. Aucune liste, aucune adresse, aucun identifiant
> d'équipement. Il regarde le réseau et il trouve ce qui est branché
> dessus. »

L'avancement défile machine par machine. **Le délai est un atout** : il
rend visible qu'un vrai travail se fait. Commentez-le, ne vous en excusez
pas.

À la fin :

> « 508 adresses possibles, examinées en soixante-douze secondes.
> 83 appareils trouvés. »

Puis, s'ils ont donné un chiffre en partie 0 :

> « Vous m'avez dit tout à l'heure que vous pensiez en avoir une
> trentaine. »

Sinon, le fait vécu :

> « Sur mon propre réseau, je croyais avoir 35 machines. Il y en avait
> 101. La moitié ne rentrait pas dans la plage que j'avais déclarée. »

### Le geste qui vous distingue

Si une plage rend zéro équipement :

> « Là, il ne me dit pas "zéro appareil". Il me dit qu'il n'a pas pu
> regarder ce réseau-là, et pourquoi. C'est la différence entre un outil
> qui rassure et un outil qui informe. »

### Ce qui peut mal tourner

Le scan plus long que prévu sur un réseau inconnu. Phrase prête :
*« sur votre réseau je découvre, comptez une à deux minutes »*.

---

# Partie 2 — Il sait ce que c'est

**3 minutes.**

### Ce que ça fait

La partie 1 prouvait qu'il **trouve**. Celle-ci prouve qu'il
**comprend** — nom, fabricant, type, sans saisie. C'est ce qui sépare un
inventaire utilisable d'une liste d'adresses IP.

Et c'est là que vous placez l'argument qui vous distingue, en montrant ce
que le produit **ne sait pas**.

### Comment ça se passe

**Écran : Équipements → une machine bien identifiée** (imprimante, switch).

> « Pour chacun : le nom, le fabricant, le type d'appareil. Sans saisie. »

Ne détaillez les sources que si on vous le demande. Réponse alors :

> « Par ordre de confiance. D'abord ce que l'équipement déclare lui-même
> en SNMP. Sinon les trois premiers octets de son adresse matérielle, qui
> identifient le constructeur de la carte réseau. Sinon la page
> d'administration qu'il sert lui-même. Et en dernier recours seulement,
> l'empreinte de sa pile réseau. »

**Puis ouvrez volontairement un « inconnu » :**

> « Celui-ci, il ne sait pas. Et il le dit.
>
> Il aurait pu deviner — beaucoup d'outils le font, ils remplissent avec
> la supposition la plus probable. On a fait le choix inverse. Un
> inventaire faux est plus dangereux qu'un inventaire incomplet, parce
> qu'on s'y fie.
>
> Quand cette case est remplie, vous pouvez vous appuyer dessus. »

Enchaînez immédiatement, sinon vous laissez une impression de manque :

> « Et ce qu'il ne sait pas, vous, vous le savez. »

Montrez **Nommer**, saisissez un nom devant eux, validez. Trente secondes.

### Ce qui peut mal tourner

**Aucun « inconnu »** : n'en fabriquez pas. Dites *« ici tout est
identifié ; sur un parc plus large il reste toujours des appareils muets,
et dans ce cas la case reste vide plutôt que remplie au hasard »*.

**Beaucoup trop d'inconnus** : ne fuyez pas l'écran, proposez le nommage.

---

# Partie 3 — Il prévient avant vos employés

**4 minutes. C'est le moment le plus fort — ne le ratez pas.**

### Ce que ça fait

Démontre la vraie valeur : la panne connue **avant** la plainte. Et ça ne
se joue pas à l'écran, ça se joue par un geste physique.

### Comment ça se passe

**Débranchez l'appareil préparé, devant eux.**

> « Je viens de débrancher l'imprimante. Personne ne l'a signalé, personne
> ne s'en est rendu compte. Regardons. »

L'alerte met environ trois minutes — l'équipement doit rater trois
passages consécutifs, pour qu'un simple paquet perdu ne réveille personne
à trois heures du matin.

**Parlez pendant l'attente.** C'est le bon moment pour la question du
coût :

> « Combien de temps, chez vous, entre le moment où quelque chose tombe et
> le moment où quelqu'un vous le dit ? Une heure ? Une matinée ? »

Puis faites-leur calculer : nombre de personnes bloquées × durée × coût
horaire. Ils produisent eux-mêmes le chiffre qui justifie votre prix.

**Écran : Alertes → l'alerte apparaît.**

> « Il ne vous envoie pas dix messages pour la même panne. Un seul, et il
> compte les fois où le problème revient. Vous pouvez dire "je sais, je
> m'en occupe", et il se tait sans oublier. »

Rebranchez, montrez que ça se referme.

> « Et l'historique reste. Dans six mois, vous saurez quel appareil vous a
> lâché le plus souvent. C'est ce qui décide un remplacement. »

### Ce qui peut mal tourner

**L'alerte ne monte pas.** Cause la plus probable : la supervision est à
l'arrêt. Vérifiez-le avant, c'est au point 2 de la préparation.

**L'attente est trop longue et le silence s'installe.** Ayez la question
du coût prête ; elle remplit exactement ce temps.

---

# Partie 4 — Vous décidez ce qui est accessible

**4 minutes.**

### Ce que ça fait

Démontre le contrôle d'accès web. Attention : deux besoins différents, que
le client confond.

**Bloquer ce qui est illégal ou dangereux** — personne ne discute.
**Bloquer ce qui fait perdre du temps** — c'est une décision de
management. Vous fournissez l'outil, le client choisit la politique.

### Comment ça se passe

**Écran : Contrôle d'accès web.** Montrez les **catégories**, jamais les
listes.

> « Vous cochez ce que vous ne voulez pas sur votre réseau. Là, ça
> représente près de 79 000 sites. Vous n'avez aucune liste à écrire ni à
> tenir à jour. »

**Ne faites jamais défiler les noms de domaines à l'écran.** Compteur, pas
contenu.

Puis le champ du message :

> « Et quand quelqu'un tombe dessus, il ne voit pas une erreur. Il voit ce
> que vous écrivez ici. »

**Écran : un navigateur → `http://neverssl.com`** → la page « Accès
bloqué ».

> « Voilà ce que voit votre employé. Pas "la connexion a échoué" — votre
> message. Ça vous économise les appels au support. »

### Ce qui peut mal tourner

**« Et sur les autres sites ? »** — répondez franchement :

> « Sur les sites sécurisés, la majorité aujourd'hui, le navigateur
> affiche sa propre erreur avant de nous laisser parler. Le site est
> bloqué, mais le message ne s'affiche pas. Pour aller plus loin il faut
> un équipement en coupure, ce qui est un autre budget. »

**« Vous voyez quels sites mes employés visitent ? »** — et c'est un
argument, pas un aveu :

> « Non, et c'est délibéré. Le résolveur n'enregistre aucune requête. La
> plateforme vous dit qui consomme de la bande passante, pas ce qu'il
> regarde. Si vous cherchez à surveiller la navigation nominative de votre
> personnel, ce n'est pas ce produit. »

---

# Partie 5 — Plusieurs agences

**2 minutes. À sauter si le client n'a qu'un site.**

### Ce que ça fait

Démontre le multi-sites et surtout le **cloisonnement**, qui décide si une
entreprise multi-agences signe.

### Comment ça se passe

> « Chaque agence a un petit service qui surveille son réseau et remonte
> ici. On ne peut pas scanner un réseau privé distant depuis l'extérieur —
> il faut un point d'entrée sur place. Et c'est lui qui appelle le
> serveur, jamais l'inverse : aucun port à ouvrir en entrée chez vous. »
>
> « Une personne rattachée à une agence ne voit que la sienne. Pas par
> politesse d'affichage : le serveur refuse de lui donner le reste. »

Devant un technicien, ajoutez :

> « Un accès direct par identifiant à un équipement d'un autre site
> renvoie 404, pas 403 — on ne confirme même pas que la ressource
> existe. »

---

# Partie 6 — Fermez avec leurs propres mots

**2 minutes.**

### Ce que ça fait

Boucle la démonstration sur la partie 0. Ce ne sont plus vos arguments,
ce sont leurs réponses.

### Comment ça se passe

Reprenez le papier du début.

> « Vous m'avez dit que vous ne saviez pas combien d'appareils vous aviez :
> il y en a 83. Que vous l'appreniez par vos employés : maintenant vous le
> savez avant eux. Et qu'un appareil inconnu pouvait se brancher sans que
> vous le voyiez : il apparaîtrait dans cette liste au prochain passage. »

**Puis taisez-vous.** Laissez-les parler les premiers. C'est difficile et
c'est décisif — le premier qui parle après une proposition est en position
de faiblesse.

---

## Ce qu'il ne faut PAS montrer

| À éviter | Pourquoi |
|---|---|
| La page Réinitialisation | Vous montrez le bouton qui efface tout. Aucun intérêt, gros malaise. |
| Un terminal, du code, VS Code | Ils achètent un produit, pas un chantier. |
| Les listes de domaines bloqués | Contenu embarrassant à l'écran. |
| La page Journal | Utile en exploitation, illisible en démonstration. |
| Un graphique vide | S'il n'y a pas de données, n'ouvrez pas l'écran. |
| Le taux « 100 % de disponibilité » | Toujours 100 % juste après un scan. Un technicien le relèvera. |

---

## Les questions qui vont tomber

**« Combien ça coûte ? »**
Ne bricolez pas un prix en direct. *« Ça dépend du nombre de sites et
d'appareils, je vous envoie une proposition chiffrée demain. »* Puis
envoyez-la le lendemain, vraiment.

**« Et si ça tombe en panne ? »**
*« Le logiciel est installé sur votre serveur, chez vous. Vos données ne
sortent pas. S'il s'arrête, votre réseau continue de fonctionner — c'est
un observateur, il n'est pas sur le chemin. »*

**« Il faut changer quelque chose sur mon réseau ? »**
*« Non pour l'inventaire et les pannes. Pour la consommation par poste et
pour le blocage, il faut un équipement réseau administrable — je vérifie
ça chez vous avant de m'engager. »* **Ne promettez pas ces deux fonctions
avant d'avoir vu leur matériel.**

**« C'est chiffré entre l'agence et le serveur ? »**
*« Pas imposé aujourd'hui : l'architecture cible un agent sur le réseau
local ou un tunnel. Avant tout déploiement d'un agent qui traverse
Internet, il faut du HTTPS — c'est identifié, pas encore fait. »*

**« Vous avez d'autres clients ? »**
Si non, dites-le. *« Vous seriez le premier. C'est pour ça que je suis
présente à l'installation et que le prix en tient compte. »* Un mensonge
sur ce point se vérifie en un appel.

---

## Répétition

Jouez-la **à voix haute, seule, chronomètre en main**, au moins une fois.
Pas dans votre tête : à voix haute. Vous découvrirez que la partie 3 est
trop longue et que vous cherchez vos mots en 4.

Le but n'est pas d'apprendre par cœur. C'est de ne jamais être surprise
par votre propre écran.

---

## À faire de ce fichier

Document commercial, pas un livrable. Ajoutez à `.gitignore` :

```
DEMONSTRATION-*.md
```
