# Comment ça marche — à expliquer à un responsable informatique

Document de préparation. À garder hors du dépôt public (voir la fin).

Un responsable informatique pose toujours les mêmes trois questions, dans
cet ordre : **qu'est-ce que ça installe chez moi, à quoi ça parle, et
qu'est-ce que ça stocke.** Tant qu'il n'a pas ces réponses, il n'écoute pas
le reste.

Ce document donne les réponses exactes, et vous dit quoi répondre quand
elles sont gênantes.

---

## 1. Ce qui tourne, et où

Trois morceaux, pas plus :

**Le serveur central** — un service Node.js et une base MySQL, installés
sur une machine du client. C'est lui qui porte l'interface web, la base de
données et le cycle de supervision. Rien n'est hébergé chez vous.

**L'interface** — une application web servie par ce même serveur.
L'utilisateur ouvre un navigateur, rien à installer sur les postes.

**L'agent** *(optionnel, un par site distant)* — un petit service Node.js
posé sur une machine du réseau distant. Il existe pour une raison
technique simple : **on ne peut pas scanner un réseau privé depuis
l'extérieur.** Si toutes les machines sont sur le même réseau que le
serveur central, aucun agent n'est nécessaire.

> À dire tel quel : *« sur un site unique, il n'y a qu'une machine à
> installer. L'agent ne sert que pour une agence distante. »*

---

## 2. Ce qui parle à quoi

**Le serveur central vers les équipements** — trois protocoles, tous en
lecture seule :

| | | |
|---|---|---|
| ICMP (ping) | l'équipement répond-il | — |
| SNMP | ce que l'équipement déclare de lui-même | port 161, lecture seule |
| TCP | quels ports sont ouverts | connexion ouverte puis fermée |

**Rien n'est écrit sur les équipements. Aucun agent n'est installé sur les
postes.** C'est le point qui rassure le plus, dites-le tôt.

**L'agent vers le central** — HTTP(S), à l'initiative de l'agent, avec un
jeton propre au site. Le central ne se connecte jamais à l'agent : c'est
l'agent qui pousse. Concrètement, **aucun port à ouvrir en entrée sur le
réseau distant.**

**Vers l'extérieur** — rien. Aucun service tiers n'est interrogé pour
superviser. La seule sortie possible est le serveur SMTP du client, s'il
active les alertes par courriel, et c'est son propre serveur.

---

## 3. Ce qui est stocké

Dans la base MySQL du client, sur sa machine :

- l'inventaire : adresses IP et MAC, noms, types, fabricants ;
- les relevés : disponibilité, charge, mémoire, compteurs d'interfaces ;
- les alertes et incidents, avec leur historique ;
- les comptes utilisateurs — mots de passe hachés en bcrypt, jamais en
  clair, jamais renvoyés par l'API ;
- un journal d'activité : qui a fait quoi, quand.

**Ce qui n'est pas stocké, et c'est important pour la partie blocage web :
aucun historique de navigation.** Le résolveur DNS est configuré
délibérément *sans* journalisation des requêtes. Seuls des totaux
remontent. Un outil qui enregistrerait quel poste visite quel site poserait
un problème que le client ne veut pas avoir.

---

## 4. Le rythme

- **Cycle de supervision : toutes les minutes.** Un équipement doit rater
  plusieurs passages consécutifs avant qu'une alerte parte — trois par
  défaut, réglable. Ça évite d'alerter sur un paquet perdu.
- **Escalade des incidents et vérification des agents : toutes les 5
  minutes.**
- **Purge des vieux relevés : une fois par heure**, pour que la base ne
  gonfle pas indéfiniment.
- **Le scan de découverte** est lancé à la demande, ou par l'agent selon
  son intervalle. Il n'est pas permanent.

---

## 5. L'impact sur leur réseau — la question qui fâche

Ils vont demander si votre scan risque de perturber quelque chose, ou de
déclencher leur sonde de détection d'intrusion. Réponse honnête et
chiffrée :

**Cinq machines interrogées en parallèle au maximum**, par défaut. Ce n'est
pas un chiffre choisi au hasard : monter à cinquante diviserait le temps,
mais changerait la nature du trafic — cinquante balayages simultanés
ressemblent à une reconnaissance hostile, et les pare-feux les bloquent. Le
scan rendrait alors *moins* de résultats en étant plus agressif.

La limite est réglable, plafonnée à 20, pour qu'une valeur saisie à la
légère ne transforme pas l'outil en outil d'attaque.

En chiffres réels : un réseau de 500 adresses examiné en 72 secondes, sans
incident.

---

## 6. Les limites — à dire avant qu'ils les trouvent

C'est le passage qui vous fera gagner leur confiance. Un produit sans
défaut annoncé est un produit dont on n'a pas cherché les défauts.

**Le chiffrement agent-central n'est pas imposé aujourd'hui.** L'exemple de
configuration fonctionne en HTTP sur réseau local. Avant tout déploiement
d'un agent qui traverse Internet, il faut du HTTPS — c'est identifié, pas
encore fait. Sur un site unique, la question ne se pose pas.

**La bande passante par machine exige un switch administrable en SNMP.**
Sans lui : inventaire et pannes fonctionnent, la consommation par poste
non. À vérifier chez eux avant de promettre quoi que ce soit.

**Le blocage web ne montre son message que sur les sites en HTTP.** En
HTTPS, le navigateur affiche sa propre erreur de certificat avant de nous
laisser parler. C'est vrai de tout blocage par DNS — aller plus loin
demande un équipement en coupure, donc un autre budget.

**Pas de réinitialisation de mot de passe en libre-service.** Un
administrateur réinitialise depuis l'interface. Un mécanisme par courriel
est prévu.

**Le limiteur de tentatives de connexion garde son état en mémoire.** Il ne
survit pas à un redémarrage et n'est pas partagé entre plusieurs serveurs.
Assumé à l'échelle d'un serveur unique, à revoir au-delà.

---

## 7. Ce qu'ils vont vouloir vérifier eux-mêmes

Proposez-le avant qu'ils le demandent, ça change tout :

- **Les tests automatiques** — 248, lancés devant eux en une commande.
- **Qu'aucun secret ne sort de l'API** — un outil dédié interroge chaque
  route et cherche les champs sensibles dans les réponses.
- **Le cloisonnement multi-site** — un compte rattaché à une agence ne
  reçoit rien d'un autre site, vérifié côté serveur et non à l'affichage.
  Un accès direct par identifiant renvoie 404, pas 403 : on ne confirme
  même pas que la ressource existe.

---

## 8. La phrase qui résume

Si vous ne deviez en garder qu'une :

> *« Tout s'installe sur une de vos machines. Rien ne sort de votre
> réseau. Rien n'est installé sur les postes. La plateforme lit, elle
> n'écrit jamais sur vos équipements. »*

---

## À faire de ce fichier

Document interne. Ajoutez à `.gitignore` :

```
ARCHITECTURE-EXPLIQUEE.md
```
