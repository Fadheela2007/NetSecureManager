# Déployer l'inventaire sur tout le parc — sans rien installer

**Une règle écrite une fois couvre les 559 postes.** Pas d'installation,
pas de Node.js, pas de logiciel à maintenir sur les machines. Le script
vit sur le serveur du domaine ; chaque poste l'exécute et envoie son
inventaire.

C'est ainsi que procèdent Lansweeper et GLPI. Zabbix et CheckMK
déploient leur agent de la même façon — par stratégie de groupe, jamais
poste par poste.

---

## Ce qu'il faut, et ce que ça demande à l'informaticien

| | |
|---|---|
| Un domaine Active Directory | ✔ vous en avez un |
| Un accès en écriture au partage `NETLOGON` | à demander |
| Le droit de créer une stratégie de groupe | à demander |
| Quelque chose sur les postes | **rien** |

La demande à formuler tient en une phrase : *« un script PowerShell en
lecture seule, exécuté une fois par jour, qui envoie la liste des
logiciels installés à notre serveur de supervision. »*

---

## Étape 1 — Récupérer le script, déjà rempli

Page **Sites** → *Mise en service de l'agent* → bouton **« Télécharger le
script d'inventaire »**.

Le fichier arrive avec l'adresse du serveur, le numéro du site et le
jeton **déjà dedans**. Il n'y a rien à éditer.

> **C'est le point qui change tout au quotidien.** Le jeton se régénère —
> c'est même le geste de sécurité qu'on attend d'un exploitant. Si le
> script portait ses valeurs en dur, chaque rotation obligerait à rouvrir
> le fichier et recoller la bonne ligne : une modification de **code**
> pour une opération d'**exploitation**. Sur des centaines de postes,
> cette friction n'empêche pas seulement le confort, elle empêche la
> rotation elle-même — on finit par ne plus jamais changer le jeton.
>
> Avec le téléchargement : régénérer, télécharger, remplacer le fichier
> sur le partage. Les 559 postes suivent au prochain déclenchement.

> **À dire à l'informaticien, pas à cacher.** Ce jeton sera lisible par
> toute personne pouvant lire `NETLOGON`, c'est-à-dire tout compte du
> domaine. Il n'ouvre **aucune lecture** : il permet uniquement de
> déposer un inventaire. Quelqu'un qui le récupérerait pourrait envoyer
> un faux inventaire, pas consulter le parc. Si c'est jugé trop, la
> solution propre est un jeton dédié par site, régénérable depuis la
> page Sites.

---

## Étape 2 — L'essayer sur UN poste

Avant toute stratégie de groupe. On ne pousse pas sur 559 machines un
script qu'on n'a pas vu tourner une fois.

```powershell
powershell -ExecutionPolicy Bypass -File .\inventaire-poste.ps1 -Test
```

`-Test` **n'envoie rien**. Il affiche ce qui serait envoyé : le nom de
la machine, son système, le nombre de logiciels et de processus vus, et
les dix premiers logiciels. Si cette liste ressemble à ce qui est
installé sur le poste, la collecte fonctionne.

Puis, sans `-Test`, un envoi réel. Ouvrir ensuite la fiche de cette
machine dans la plateforme : les logiciels doivent y être.

---

## Étape 3 — Poser le script sur le partage

Copier le fichier dans :

```
\\<votre-domaine>\NETLOGON\NetSecureManager\inventaire-poste.ps1
```

`NETLOGON` est répliqué automatiquement sur tous les contrôleurs de
domaine et lisible par tous les postes. **Modifier ce fichier met à
jour les 559 postes** — c'est tout l'intérêt : le jour où l'adresse du
serveur change, une seule copie est à corriger.

---

## Étape 4 — La stratégie de groupe

Sur le contrôleur de domaine, *Gestion des stratégies de groupe* →
créer un objet, par exemple **Inventaire NetSecureManager**, puis :

```
Configuration ordinateur
  └ Préférences
     └ Paramètres du Panneau de configuration
        └ Tâches planifiées
           → Nouveau → Tâche planifiée (au moins Windows 7)
```

| Champ | Valeur |
|---|---|
| Nom | `NetSecureManager - inventaire` |
| Compte | `NT AUTHORITY\SYSTEM` |
| Exécuter avec les autorisations maximales | coché |
| Programme | `powershell.exe` |
| Arguments | `-ExecutionPolicy Bypass -WindowStyle Hidden -File "\\<domaine>\NETLOGON\NetSecureManager\inventaire-poste.ps1"` |
| Déclencheur | Quotidien, 12:30 |

**Pourquoi `SYSTEM`** : la tâche doit tourner même si personne n'est
connecté au poste, et lire la ruche du registre réservée aux
administrateurs.

**Pourquoi midi et demi, pas le démarrage** : au démarrage, 559 postes
allumés en même temps frapperaient le serveur dans la même minute. Une
heure creuse étale la charge. Ajoutez un délai aléatoire d'une heure
dans l'onglet *Paramètres* de la tâche si les postes démarrent tous à
8 h.

Lier ensuite la stratégie à l'unité d'organisation qui contient les
postes. Elle s'applique au prochain redémarrage, ou immédiatement avec
`gpupdate /force` sur un poste d'essai.

---

## Étape 5 — Vérifier que ça tourne

Sur un poste, après la première exécution :

```powershell
Get-Content "$env:ProgramData\NetSecureManager\inventaire.log" -Tail 5
```

| Ce qui s'affiche | Ce que ça veut dire |
|---|---|
| `Envoye : 187 logiciel(s), 94 processus` | tout va bien |
| `ARRET : le jeton du site n'est pas renseigne` | l'étape 1 a été sautée |
| `ECHEC : ... impossible de se connecter` | le poste n'atteint pas le serveur — pare-feu, ou mauvaise adresse |
| `ECHEC : Token d'agent invalide` | le jeton ne correspond pas à `$ID_SITE` |
| rien du tout | la tâche ne s'est pas déclenchée : vérifier la GPO avec `gpresult /r` |

Côté plateforme, les machines apparaissent au fil des envois. Une
machine sans inventaire affiche « aucun agent de poste n'est installé »
— un message, pas un écran vide.

---

## Ce que le script ne fait pas

À dire à l'informaticien avant qu'il pose la question :

- **Il n'ouvre aucun port** et n'attend aucune connexion. Il envoie, un
  point c'est tout. La plateforme ne peut lui donner aucun ordre.
- **Il ne collecte ni le nom de l'utilisateur, ni les lignes de
  commande** — celles-ci contiennent régulièrement des mots de passe et
  des chemins personnels.
- **Il ne lit aucun fichier, aucun document.** Registre et liste des
  processus, rien d'autre.
- **Il ne laisse rien** sur le poste, à part son journal dans
  `ProgramData`.
- Il fait une centaine de lignes et se lit en entier. C'est un argument :
  un service informatique accepte plus volontiers un script qu'il peut
  relire qu'un exécutable qu'il doit croire sur parole.

Reste une limite honnête : exécuté en tant que `SYSTEM`, il ne voit pas
les logiciels installés **pour un seul utilisateur** (certains Teams,
Zoom, Chrome personnels). Ils vivent dans la ruche du profil, qu'il
faudrait charger profil par profil — beaucoup de complexité, et une
intrusion supplémentaire dans l'espace de chaque personne, pour une
minorité de cas.

---

## Et l'agent Node dans tout ça

Il reste, et il sert encore pour :

- les **serveurs Linux**, qui n'ont ni registre ni GPO ;
- les machines **hors domaine** ;
- les postes qu'on veut suivre **toutes les heures** plutôt qu'une fois
  par jour.

Les deux envoient exactement le même message à la même route. Rien à
changer côté plateforme selon la méthode choisie.
