# Installer l'agent de poste

L'agent de poste s'installe **sur une machine à suivre**. Il remonte ce
qu'aucun scan réseau ne peut voir : les logiciels installés et les
programmes qui tournent.

> **Ne pas confondre avec l'agent de site.** L'agent de site
> (`src/agent`) s'installe une fois par **réseau** et scanne la plage.
> L'agent de poste s'installe sur chaque **machine** dont on veut voir
> l'intérieur. Les deux peuvent coexister sur la même machine.

---

## Avant de commencer

Il faut trois choses, toutes lisibles depuis la plateforme :

| | Où la trouver |
|---|---|
| L'adresse de l'API | celle que le navigateur utilise, suivie de `/api` |
| Le numéro du site | page **Sites**, colonne de gauche |
| Le jeton du site | page **Sites** → *Mise en service de l'agent* |

Le jeton est celui du **site**, pas de la machine. Quarante postes
partagent donc le même jeton — c'est ce qui rend le déploiement
réaliste. La contrepartie doit être dite au client : un poste compromis
peut envoyer un inventaire au nom d'un autre poste du même site. Il ne
peut **rien lire** : ce jeton n'ouvre aucune route de lecture.

---

## Installation sur un poste Windows

**1.** Créer un dossier sur la machine, par exemple
`C:\NetSecureAgent`, et y copier :

```
src\agent-poste\agent-poste.js
src\agent-poste\collecteurs.js
```

**2.** Installer les trois bibliothèques nécessaires :

```powershell
cd C:\NetSecureAgent
npm init -y
npm install axios node-cron dotenv
```

Node.js doit être présent sur le poste. S'il ne l'est pas et que
l'installer sur chaque machine n'est pas envisageable, dites-le : il
existe une alternative (empaqueter l'agent en un seul `.exe`), qui
demande une étape de plus au moment de la livraison.

**3.** Créer le fichier `.env` dans ce dossier :

```
CENTRAL_API_URL=http://192.168.0.10:5000/api
AGENT_TOKEN=le-jeton-du-site
ID_SITE=1
INTERVALLE_MINUTES=60
COLLECTER_UTILISATEUR=0
```

**4.** Lancer :

```powershell
node agent-poste.js
```

Un premier envoi part **immédiatement**. Ouvrez la fiche de cette machine
dans la plateforme : les logiciels et les programmes en cours doivent y
apparaître. Sans cet envoi immédiat, il faudrait attendre une heure avant
de savoir si l'installation a réussi.

**5.** Pour qu'il tourne en permanence, le déclarer dans le
**Planificateur de tâches** de Windows : *Créer une tâche* → déclencheur
« Au démarrage de l'ordinateur » → action `node` avec l'argument
`C:\NetSecureAgent\agent-poste.js` et le dossier de départ
`C:\NetSecureAgent`. Cocher « Exécuter même si l'utilisateur n'est pas
connecté ».

---

## Sur un poste Linux

Les mêmes fichiers, les mêmes trois bibliothèques. La collecte utilise
`ps` et `dpkg-query` au lieu de `tasklist` et du registre — l'agent
choisit seul selon le système, il n'y a rien à configurer.

Pour qu'il survive au redémarrage, un service systemd sur le modèle de
celui décrit dans le `README.md` pour le serveur.

---

## Combien ça consomme

L'agent se réveille toutes les heures, lit deux listes et envoie
quelques dizaines de kilo-octets. Entre deux réveils il ne fait rien.
L'intervalle par défaut est d'une heure et non de cinq minutes parce
qu'un inventaire n'est pas une mesure : la liste des logiciels d'un poste
ne change pas quatre fois par heure.

---

## La vie privée, à décider avant de déployer

La liste des programmes qu'une personne fait tourner sur son poste dit
beaucoup d'elle. Deux choix ont été faits dans ce sens, et ils doivent
être présentés au client plutôt que découverts :

- **Le nom de l'utilisateur n'est pas collecté** tant que
  `COLLECTER_UTILISATEUR=1` n'est pas écrit dans le `.env`.
- **Les lignes de commande complètes ne sont jamais collectées**, quelle
  que soit la configuration : elles contiennent régulièrement des mots de
  passe, des jetons et des chemins personnels. Le nom de l'exécutable
  suffit à répondre aux questions qu'on pose à un inventaire.

Déployer un agent qui observe les postes des salariés se prépare : dans
la plupart des cas, l'employeur doit en informer les personnes
concernées. Ce n'est pas une question technique, mais elle se pose avant
l'installation, pas après.

---

## Si rien n'apparaît

| Ce que dit l'agent | Ce que ça veut dire |
|---|---|
| `Configuration incomplète` | une des trois valeurs manque dans `.env` — l'agent refuse de démarrer plutôt que de tourner en silence |
| `Envoi refusé : Token d'agent invalide` | le jeton ne correspond pas à `ID_SITE` |
| `Envoi refusé : L'inventaire de poste n'est pas installé` | la migration n'a pas été appliquée sur le serveur : `node tools\appliquer-migrations.js` |
| `Aucune adresse réseau utilisable` | la machine n'a que des cartes virtuelles actives |
| `Processus non collectés` | droits insuffisants — l'inventaire des logiciels part quand même, et le serveur n'efface pas ce qu'il avait |

Sur la fiche d'un équipement, « aucun agent de poste n'est installé sur
cette machine » est un message, pas un écran vide. C'est volontaire : une
liste vide sans explication se lirait « cette machine ne fait tourner
aucun logiciel ».
