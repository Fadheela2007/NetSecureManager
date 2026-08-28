# Ajouter un site distant

**Temps nécessaire : environ 5 minutes par site**, dont 3 d'installation
effective. Aucune compétence particulière au-delà de savoir ouvrir un
terminal en administrateur.

---

## Pourquoi un agent

Un réseau d'entreprise distant n'est pas joignable depuis Internet : c'est
le principe même d'un réseau privé. Scanner les machines de l'agence de
Douala depuis un serveur à Yaoundé est techniquement impossible sans un
point d'entrée sur place.

L'agent est ce point d'entrée. Il tourne sur une machine du réseau local,
scanne depuis l'intérieur, et transmet ses résultats à la plateforme
centrale par une connexion sortante — la seule qui traverse un pare-feu
d'entreprise sans configuration.

Conséquence pratique : **aucune ouverture de port entrant n'est
nécessaire**. C'est la question que pose systématiquement un responsable
réseau, et la réponse est celle qu'il souhaite entendre.

---

## Prérequis sur la machine du site

| | |
|---|---|
| Machine | Un mini-PC, une VM ou un poste allumé en permanence |
| Système | Windows 10/11, Windows Server, ou Linux |
| Node.js | Version 18 ou supérieure |
| Réseau | Accès sortant HTTPS vers la plateforme |
| Privilèges | Administrateur (le service démarre au boot) |
| nmap | Facultatif — améliore l'identification des équipements |

Une machine modeste suffit : l'agent consomme quelques dizaines de Mo de
mémoire et sollicite le réseau quelques secondes toutes les 5 minutes.

---

## La procédure

### 1. Créer le site dans l'interface

**Sites** → renseigner le nom et la ville → **Ajouter le site**.

L'écran de mise en service s'ouvre immédiatement, avec la commande
d'installation prête à coller — **le jeton y est déjà inséré**. C'est
volontaire : la recopie manuelle d'un jeton de 48 caractères est la
première source d'erreur lors d'une mise en service.

### 2. Déclarer la plage à superviser

**Plages réseau** → ajouter le CIDR du site (par exemple
`192.168.10.0/24`), avec la communauté SNMP si elle est connue.

Cette étape est facultative mais recommandée : la commande d'installation
reprend alors automatiquement la bonne plage. Sans elle, la commande
propose `192.168.1.0/24` par défaut et il faut ajuster `--cidr`.

### 3. Lancer l'installation sur la machine du site

Copiez le dossier `backend` du projet sur la machine, puis, depuis
`backend/src/agent` :

**Linux**

```bash
sudo bash installer.sh \
  --url "https://superviseur.exemple.com/api" \
  --token "<fourni par l'interface>" \
  --site 2 \
  --cidr "192.168.10.0/24"
```

**Windows** — PowerShell en administrateur

```powershell
.\installer.ps1 -Url "https://superviseur.exemple.com/api" `
                -Token "<fourni par l'interface>" `
                -Site 2 -Cidr "192.168.10.0/24"
```

Le script :

1. vérifie les prérequis (Node.js, nmap)
2. installe l'agent et ses dépendances
3. écrit la configuration, avec des droits restreints sur le jeton
4. crée un service (systemd) ou une tâche planifiée (Windows) qui démarre
   au boot et redémarre en cas d'arrêt
5. **vérifie que la plateforme a bien reçu la remontée**

Ce dernier point n'est pas cosmétique. Un agent peut parfaitement écrire
« envoyé » dans son journal alors qu'un pare-feu bloque la sortie. Le
script interroge donc la plateforme elle-même et distingue trois cas :
plateforme injoignable, jeton refusé, ou transmission réussie.

### 4. Vérifier

L'écran de mise en service se met à jour tout seul, toutes les
5 secondes. Le bandeau passe au vert dès la première transmission :

```
● Agent actif — Actif à l'instant · 47 équipement(s) remonté(s)
```

La liste des sites affiche ensuite l'état de chaque agent en permanence.

---

## Que fait l'agent une fois installé

Toutes les 5 minutes (réglable), il :

- balaie sa plage en ICMP et complète par la table ARP — ce qui détecte
  aussi les machines qui bloquent le ping
- interroge en SNMP celles qui répondent, pour le processeur, la mémoire
  et les compteurs de trafic
- transmet à la plateforme les équipements vus, leur statut, et les relevés

Il ne reçoit aucune commande de l'extérieur et n'ouvre aucun port. La
communication est toujours à son initiative.

---

## Sécurité du jeton

Le jeton autorise l'envoi de données **au nom de ce site**, rien d'autre.
Il ne donne accès ni à l'interface, ni aux données des autres sites.

- Il n'est visible que par un administrateur, via l'écran de mise en
  service. Il n'apparaît dans aucune autre réponse de l'API.
- Sur la machine du site, le fichier de configuration est lisible
  uniquement par l'administrateur et le compte système.
- En cas de doute sur une fuite : **Régénérer** dans l'écran de mise en
  service. L'ancien jeton cesse immédiatement de fonctionner ; il faut
  alors relancer l'installation avec le nouveau.

---

## Si la remontée n'arrive pas

Le script s'arrête sur un message explicite. Les trois causes, par ordre
de fréquence :

**Plateforme injoignable.** L'URL est incorrecte, ou la sortie HTTPS est
bloquée. Depuis la machine du site :

```bash
curl -v https://superviseur.exemple.com/api/sites
```

**Jeton refusé (403).** Il a été régénéré depuis. Reprenez la commande
dans l'écran de mise en service.

**Le service ne démarre pas.**

```bash
# Linux
journalctl -u netsecuremanager-agent -f

# Windows — exécution manuelle, journal à l'écran
cd "C:\Program Files\NetSecureManager-Agent"
node src\agent\agent.js
```

---

## Sur plusieurs sites

Rien ne change : chaque site a son jeton, son agent, sa plage. Ils
n'interagissent pas entre eux.

La plateforme surveille elle-même les agents : si l'un cesse de
transmettre au-delà du seuil configuré, une alerte critique est levée et
les équipements du site passent en état « inconnu » — ni « en ligne » à
tort, ni « hors ligne » à tort.

C'est le point qu'il faut souligner face à un acheteur multi-sites :
**l'absence de données est elle-même détectée**. Sans cela, un site
entier peut devenir invisible sans que personne ne s'en aperçoive, ce qui
est le pire mode de défaillance d'un outil de supervision.

---

## Désinstaller

```bash
# Linux
sudo systemctl disable --now netsecuremanager-agent
sudo rm /etc/systemd/system/netsecuremanager-agent.service
sudo rm -rf /opt/netsecuremanager-agent

# Windows (PowerShell administrateur)
Unregister-ScheduledTask -TaskName NetSecureManagerAgent -Confirm:$false
Remove-Item -Recurse -Force "C:\Program Files\NetSecureManager-Agent"
```

Les données déjà remontées restent dans la plateforme. Pensez à régénérer
le jeton du site si la machine est mise au rebut.
