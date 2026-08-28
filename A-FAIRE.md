# À faire — mode d'emploi

Ce fichier remplace mes rapports pour la partie « comment faire ».
Vous suivez les étapes dans l'ordre. Chacune indique :

- **où** taper la commande,
- **quoi** taper exactement,
- **ce qui doit s'afficher**,
- **quoi faire si** ce n'est pas ça.

Il y a 5 étapes. Comptez 30 minutes, dont 20 d'attente pendant les scans.

---

## Étape 1 — Arrêter le backend

Dans la fenêtre où tourne `npm start`, appuyez sur **Ctrl + C**.

Les deux migrations qui suivent modifient des tables que le backend lit en
permanence. Les passer pendant qu'il tourne fonctionne le plus souvent,
mais pas toujours — et un échec au milieu d'une migration est bien plus
pénible à réparer qu'un arrêt de deux minutes.

---

## Étape 2 — Passer les deux migrations SQL

Ouvrez **MySQL Workbench**, connectez-vous à votre base.

### 2a. Les alertes

Ouvrez ce fichier :

```
C:\Users\LENOVO\Documents\NetSecureManager\backend\migrations\2026-08-18-alertes-acquittement.sql
```

Exécutez-le entièrement (icône éclair ⚡, ou **Ctrl + Maj + Entrée**).

**Ce qui doit s'afficher :** des lignes vertes ✓ dans le panneau du bas.

**Si vous voyez `Error Code: 1060 Duplicate column name` :** la colonne
existe déjà, c'est sans gravité. Passez la commande suivante et continuez.

C'est cette migration qui fait disparaître les messages :

```
Supervision de 192.168.0.160 échouée: Unknown column 'occurrences' in 'field list'
```

### 2b. La bande passante

Même chose avec :

```
C:\Users\LENOVO\Documents\NetSecureManager\backend\migrations\2026-08-18-bande-passante.sql
```

**Vérification :** exécutez cette requête. Vous devez voir les quatre
colonnes `vitesse_mbps`, `trafic_entrant_kbps`, `trafic_sortant_kbps` et
`date_trafic` dans la liste.

```sql
USE NetSecureManager;
SHOW COLUMNS FROM INTERFACE_RESEAU;
```

**Si elles n'y sont pas :** la migration n'est pas passée. Relancez-la et
regardez le message d'erreur — envoyez-le-moi, il dit exactement ce qui
bloque.

---

## Étape 3 — Mesurer le gain de vitesse du scan

C'est ce que vous m'avez demandé de confirmer. **Je ne peux pas le faire :
je n'ai aucun accès à votre réseau.** Ce que j'annoncerais serait une
estimation, pas une mesure. Voici l'outil pour la faire vous-même.

Ouvrez **PowerShell** (pas besoin d'administrateur) :

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
node tools\mesurer-scan.js 192.168.0.0/23
```

**Ce qui va se passer :** deux scans complets à la suite. Le premier est
volontairement lent (l'ancien comportement, gardé pour comparer), le
second est le nouveau. **Comptez 5 à 10 minutes en tout.** C'est normal,
laissez tourner sans rien toucher.

**Ce qui doit s'afficher à la fin :**

```
  RÉSULTAT

  Séquentiel  : 2 min 57 s
  Lots de 5   : 40 s
  Gain        : 4.4× plus rapide
  Économie    : 2 min 17 s par cycle

  ✓ Même détection : 23 équipement(s) dans les deux cas.
    La parallélisation ne fait rien perdre.
```

Les chiffres seront différents des miens — ils dépendent de votre réseau.
**La ligne qui compte est la dernière.**

**Si vous voyez `⚠ ATTENTION : 23 en séquentiel, 19 en parallèle` :** le
scan rapide a manqué des machines. C'est le seul vrai risque de ce
changement. Dans ce cas, ouvrez le fichier
`C:\Users\LENOVO\Documents\NetSecureManager\backend\.env`, ajoutez cette
ligne à la fin, enregistrez, et relancez la mesure :

```
SCAN_CONCURRENCE=3
```

**Envoyez-moi le bloc RÉSULTAT complet** quand vous l'avez. C'est lui qui
me permet de dire que c'est terminé — pas mes estimations.

---

## Étape 4 — Redémarrer et vérifier

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
npm start
```

**Ce qui doit s'afficher :** le démarrage habituel, **sans** aucune ligne
`Unknown column`.

Puis, dans une autre fenêtre :

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\frontend
npm run build
```

**Ce qui doit s'afficher :** `✓ built in ... s`.

**Si le build échoue :** copiez-moi le message d'erreur. Je ne peux pas
lancer ce build moi-même — les dépendances installées dans votre dossier
sont des programmes compilés pour Windows, et mon environnement
d'exécution est un Linux séparé. J'ai vérifié la syntaxe de tous les
fichiers que j'ai touchés, mais ce n'est pas la même garantie qu'un build
réussi.

---

## Étape 5 — Regarder le résultat

Lancez l'interface (`npm run dev` dans `frontend`), connectez-vous.

1. Menu **Bande passante** : nouvelle page. Elle sera probablement vide au
   début — c'est normal, il faut **deux cycles de scan** avant le premier
   chiffre. Le débit se calcule par différence entre deux relevés : sans
   point de départ, il n'y a rien à calculer.

2. Menu **Alertes** : les alertes répétées sont maintenant regroupées avec
   un compteur `×12` au lieu de douze lignes identiques.

3. Si le bandeau dit « 4 équipements mesurés sur 37 » : c'est normal. Le
   débit se lit en SNMP, que la plupart des postes Windows n'activent pas.
   Ce n'est pas une panne.

---

## Étape 6 — Le contrôle des accès web (point 3)

Nouvelle fonction. Elle demande **quatre choses**, dont deux ne sont pas
du logiciel. Prenez-les dans l'ordre : sauter la 3 ou la 4 donne une
fonction qui a l'air de marcher et qui ne bloque rien.

### 6a. La migration (2 minutes)

Dans MySQL Workbench, exécutez :

```
C:\Users\LENOVO\Documents\NetSecureManager\backend\migrations\2026-08-19-controle-acces-web.sql
```

**Vérification :**

```sql
USE NetSecureManager;
SELECT code, libelle, nb_domaines FROM CATEGORIE_WEB;
```

Doit renvoyer **7 lignes**, toutes avec `nb_domaines = 0`. C'est normal :
les catégories existent, elles sont vides.

### 6b. Importer au moins une liste (5 minutes)

Une catégorie vide ne bloque rien. L'écran vous le dira en orange, mais
autant le faire tout de suite.

**Ouvrir PowerShell :** touche Windows, tapez `powershell`, Entrée.
Pas besoin d'être administrateur.

**Puis copiez-collez ces deux lignes**, une à la fois :

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
node tools\importer-listes-web.js publicite --recommandee --remplacer
```

C'est tout. L'outil télécharge la liste lui-même — vous n'avez ni
navigateur à ouvrir, ni fichier à ranger, ni chemin à retaper.

**Ce qui doit s'afficher :**

```
Liste de référence : StevenBlack/hosts
Taille attendue    : environ 180 000 domaines, ~5 Mo

Source : https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts
  5.2 Mo téléchargés.

Catégorie : Publicité et pistage
Mode      : remplacement

  Lignes lues        : 178432
  Lignes ignorées    : 1204  (commentaires, lignes vides, entrées invalides)
  Domaines retenus   : 177228
  Total en catégorie : 177228  (doublons écartés)

  ✓ Import terminé.
```

Comptez une à deux minutes : le téléchargement est rapide, l'insertion
des 177 000 domaines un peu moins.

**Si vous voyez `Téléchargement impossible` :** votre machine n'a pas
accès à ce site (proxy, pare-feu). Ouvrez alors l'adresse dans votre
navigateur, enregistrez la page (Ctrl+S) dans `Téléchargements`, puis :

```powershell
node tools\importer-listes-web.js publicite C:\Users\LENOVO\Downloads\hosts.txt --remplacer
```

Pour obtenir le chemin exact d'un fichier sans le retaper : dans
l'explorateur Windows, **clic droit sur le fichier → « Copier en tant que
chemin d'accès »**, puis Ctrl+V dans PowerShell.

**Ce qui doit s'afficher :**

```
  Lignes lues        : 178432
  Lignes ignorées    : 1204  (commentaires, lignes vides, entrées invalides)
  Domaines retenus   : 177228
  Total en catégorie : 177228  (doublons écartés)

  ✓ Import terminé.
```

**Si `Total en catégorie : 0` :** le fichier n'est pas au bon format.
L'outil accepte un domaine par ligne, le format `hosts`, ou le format
AdBlock. Envoyez-moi les cinq premières lignes du fichier.

**Deuxième liste utile**, celle des sites malveillants — à activer
partout, elle protège au lieu de restreindre :

```powershell
node tools\importer-listes-web.js malveillant --recommandee --remplacer
```

Les autres catégories (`reseaux_sociaux`, `streaming`, `adulte`, `jeux`,
`contournement`) n'ont pas de liste de référence intégrée : il n'existe
pas de source publique que je puisse recommander sans réserve pour
celles-là. Vous les remplirez soit à la main depuis l'écran **Accès web**,
soit avec une adresse de votre choix :

```powershell
node tools\importer-listes-web.js streaming https://adresse-de-votre-choix/liste.txt --remplacer
```

Pour voir toutes les options à tout moment, lancez la commande sans
arguments :

```powershell
node tools\importer-listes-web.js
```

### 6c. Configurer depuis l'interface (5 minutes)

Menu **Accès web**. Cochez vos catégories, écrivez le message de blocage,
cochez « Politique active », **Enregistrer**.

Le bandeau en haut de l'écran vous dira l'état réel : *enregistrée*,
*en attente de l'agent*, ou *appliquée*. Ce n'est pas la même chose, et
c'est volontairement affiché séparément.

### 6d. D'abord, comprendre ce qui se passe

Avant les commandes, le mécanisme. Sans ça, les étapes n'ont pas de sens
et la moindre erreur devient incompréhensible.

**Quand vous tapez `facebook.com` dans un navigateur**, votre ordinateur
ne sait pas où c'est. Il demande à un **serveur DNS** : « c'est quelle
adresse ? » Le serveur répond `157.240.1.35`, et le navigateur s'y
connecte.

Ce serveur DNS, aujourd'hui, c'est celui de votre box internet ou de
votre opérateur.

**Le blocage consiste à s'intercaler à cette place.** On installe notre
propre serveur DNS, on dit aux ordinateurs du réseau « posez-lui vos
questions à lui », et quand quelqu'un demande un domaine interdit, il
répond `0.0.0.0` — une adresse qui ne mène nulle part. Le site ne
s'ouvre pas.

Il y a donc **trois choses distinctes** à mettre en place, et c'est
pour ça que ça paraît compliqué :

| # | Quoi | Sans ça |
|---|---|---|
| 1 | Un serveur DNS qui sait bloquer | Rien à interroger |
| 2 | Les ordinateurs qui l'interrogent | Il tourne dans le vide |
| 3 | L'impossibilité d'en changer | Contournable en 30 secondes |

Faites-les **dans cet ordre**, en vérifiant chacune. Tout faire d'un coup
puis constater que ça ne marche pas, sans savoir laquelle des trois a
échoué, est le meilleur moyen d'y passer la journée.

---

### 6e. Chose n° 1 — le serveur DNS

Le logiciel s'appelle **dnsmasq**. Il n'existe pas sous Windows. Vous
avez trois voies, de la plus rapide à la plus définitive.

#### Voie A — WSL, pour tester en 15 minutes (recommandé pour commencer)

WSL, c'est un Linux qui tourne à l'intérieur de Windows. Gratuit, déjà
inclus dans Windows 10 et 11.

**Ouvrez PowerShell en administrateur** (touche Windows, tapez
`powershell`, puis clic droit → *Exécuter en tant qu'administrateur*) :

```powershell
wsl --install
```

Redémarrez le PC quand il vous le demande. Au redémarrage, une fenêtre
noire s'ouvre et vous demande de créer un nom d'utilisateur et un mot de
passe — c'est votre compte Linux, notez-le.

Ensuite, dans cette fenêtre Linux :

```bash
sudo apt update && sudo apt install dnsmasq -y
```

Le mot de passe demandé est celui que vous venez de créer. *(Rien ne
s'affiche pendant que vous le tapez — c'est normal, tapez et validez.)*

**Puis lancez le script de préparation** — il traite trois obstacles
propres à WSL que l'installation ne règle pas toute seule :

```bash
sudo bash /mnt/c/Users/LENOVO/Documents/NetSecureManager/backend/src/agent/preparer-wsl.sh
```

S'il vous dit **« IL FAUT REDÉMARRER WSL »**, allez dans une fenêtre
PowerShell, tapez `wsl --shutdown`, fermez toutes les fenêtres Ubuntu,
attendez dix secondes, rouvrez Ubuntu et relancez la même commande.

À la fin, il affiche l'adresse du résolveur, du genre `172.24.145.179`.
**Notez-la.**

> **Pourquoi ce script.** À la fin de `apt install dnsmasq`, une ligne
> passe inaperçue au milieu de cent autres :
> *« Could not execute systemctl »*. dnsmasq est bien installé, mais WSL
> ne démarre pas systemd, donc le service n'a jamais été lancé. Sans
> traiter ça, rien de la suite ne peut marcher — et le symptôme
> (« le port 53 ne répond pas ») ne dit pas d'où vient le problème.

> **Limite de la voie A** : cette adresse n'est joignable que depuis
> **votre PC**, pas depuis les autres machines du réseau. C'est suffisant
> pour vérifier que le blocage fonctionne, pas pour équiper un bureau.
> L'adresse change aussi à chaque redémarrage de Windows.

#### Voie B — une machine virtuelle, pour équiper un vrai réseau

VirtualBox (gratuit) + Ubuntu Server. Comptez 45 minutes. Au moment de
configurer la machine virtuelle, choisissez **« Accès par pont »**
(*bridged*) comme mode réseau : la VM reçoit alors une vraie adresse du
réseau, visible par tous les autres postes.

#### Voie C — un Raspberry Pi, pour la production

Environ 50 000 FCFA. C'est ce qu'on vend au client : petit, silencieux,
consomme 3 watts, on l'oublie dans un placard. C'est la réponse que vous
donnerez en clientèle.

---

### 6f. Chose n° 2 — faire interroger ce serveur

**Commencez par UN SEUL ordinateur, sans toucher au routeur.** C'est
réversible en dix secondes et ça isole le problème : si ça bloque sur ce
poste, le serveur marche ; il ne restera qu'à généraliser.

> **⚠ DEUX FENÊTRES DIFFÉRENTES, c'est la confusion la plus fréquente.**
>
> | Fenêtre | À quoi elle sert | Comment la reconnaître |
> |---|---|---|
> | **Ubuntu** | commandes Linux (`sudo`, `apt`, `hostname`) | l'invite se termine par `$` — `lenovo@Fadheela:~$` |
> | **PowerShell** | commandes Windows (`Set-DnsClientServerAddress`, `nslookup`) | l'invite commence par `PS C:\>` |
>
> Une commande Windows tapée dans Ubuntu répond `command not found`, et
> inversement. Gardez les deux fenêtres ouvertes côte à côte.
>
> Pour ouvrir PowerShell en administrateur : touche Windows, tapez
> `powershell`, puis **clic droit → Exécuter en tant qu'administrateur**.

#### Test préalable — sans rien changer à Windows

Avant de toucher aux réglages de votre poste, interrogez directement le
résolveur. Cette commande ne modifie **rien** :

```powershell
nslookup exemple-bloque-nsm.com 172.24.145.179
```

*(remplacez par l'adresse affichée par le script)*

- **`Address: 0.0.0.0`** → dnsmasq marche. Continuez.
- **Délai d'attente** → le problème est dans WSL, pas sur Windows.
  Relancez `preparer-wsl.sh`, il dira où ça coince. Inutile d'aller plus
  loin tant que ce test échoue.

#### Puis basculer le poste

**Trouvez d'abord le nom exact de votre carte réseau** — c'est là que ça
achoppe souvent. Dans **PowerShell en administrateur** :

```powershell
Get-NetAdapter | Where-Object Status -eq "Up" | Format-Table Name, InterfaceDescription
```

Vous verrez plusieurs lignes, dont beaucoup de cartes **virtuelles**
(VMware, VirtualBox, Hyper-V, WSL). Ce ne sont pas les bonnes.

**Celle qui vous intéresse est celle dont la description mentionne un
vrai fabricant** — par exemple `Realtek PCIe GbE Family Controller` ou
`Intel Wireless-AC`. Son nom est en général `Ethernet` (câble) ou `Wi-Fi`
(sans fil).

> **Attention :** si vous donnez un nom qui n'existe pas, PowerShell ne
> bloque pas toujours de façon visible — la commande semble passer et
> **rien n'est modifié**. C'est exactement ce qui arrive quand on tape
> `"Wi-Fi"` sur une machine branchée en câble.
>
> Vérifiez toujours après coup avec `nslookup` (voir plus bas) : c'est la
> seule preuve que le changement a bien pris.

Puis, en remplaçant `Ethernet` par le nom trouvé et l'adresse par la
vôtre :

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses 172.24.145.179
```

**Testez immédiatement, avec le domaine témoin** que le script de
préparation a mis dans la configuration :

```powershell
nslookup exemple-bloque-nsm.com
```

| Ce que vous voyez | Ce que ça veut dire |
|---|---|
| `Address: 0.0.0.0` | **Ça marche.** Toute la chaîne est bonne. |
| Une vraie adresse | Le poste n'interroge pas votre serveur |
| `Délai d'attente dépassé` | L'adresse est fausse, ou dnsmasq ne tourne pas |

On teste ce domaine-là et pas `doubleclick.net` pour une raison précise :
il ne dépend **que** de dnsmasq. Si vous testiez directement un domaine
de la liste publicité, un échec pourrait venir de trois endroits
différents (WSL, le poste, ou la politique jamais reçue par l'agent) et
vous ne sauriez pas lequel.

Une fois le témoin bloqué, et **seulement** ensuite, testez un vrai
domaine de la liste :

```powershell
nslookup doubleclick.net
```

S'il n'est pas bloqué alors que le témoin l'est : la chaîne réseau est
bonne, c'est la politique qui n'est pas arrivée. Regardez l'état affiché
en haut de l'écran **Accès web**.

**Pour revenir en arrière à tout moment** (à faire si quoi que ce soit
cloche — vous récupérez internet instantanément) :

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ResetServerAddresses
```

#### Une fois que ça marche sur un poste : généraliser

Là seulement, on touche au routeur.

1. Dans un navigateur, allez à l'adresse de votre box : le plus souvent
   `http://192.168.1.1` ou `http://192.168.0.1`.
2. Connectez-vous (identifiants au dos de la box, en général).
3. Cherchez une section **DHCP**, ou *Réseau local*, ou *LAN*.
4. Trouvez les champs **Serveur DNS primaire / secondaire**.
5. Remplacez le primaire par l'adresse de votre machine Linux.
6. Enregistrez, puis redémarrez un poste pour qu'il reçoive le nouveau
   réglage.

> **Attention** : si votre machine Linux s'éteint, **plus aucun poste du
> réseau n'aura internet**. C'est le risque réel de cette étape, et la
> raison pour laquelle une VM sur votre portable ne convient pas en
> production. Mettez toujours une adresse de secours (`9.9.9.9`) dans le
> champ *DNS secondaire*.

---

### 6g. Chose n° 3 — empêcher le contournement

Sans cette étape, n'importe qui remet `8.8.8.8` dans ses réglages réseau
et retrouve tout. **Testez d'abord si vous êtes contournable :**

```powershell
nslookup doubleclick.net 8.8.8.8
```

- **Une vraie adresse s'affiche** → vous êtes contournable. Normal à ce
  stade.
- **Délai d'attente** → le verrouillage est déjà en place.

Les règles à poser sont dans l'écran **Accès web**, encadré orange en bas
de page, avec un onglet par type de matériel. Bouton *Copier les règles*,
puis collez-les dans le pare-feu du routeur.

**Dites-le tout de suite si c'est le cas :** sur une box d'opérateur
grand public, c'est en général **impossible** — elles n'offrent pas de
pare-feu configurable. Le blocage fonctionnera quand même, mais il restera
contournable par quelqu'un qui sait ce qu'il fait.

Ce n'est pas rédhibitoire, c'est une information à donner au client :
*« le filtrage tient l'usage courant ; pour le rendre infranchissable, il
faut un routeur professionnel »*. Cette phrase, dite avant la vente, vous
crédibilise. Découverte après, elle vous coûte le client.

---

### Récapitulatif des trois tests

Faites-les dans l'ordre, ils répondent chacun à une question différente :

```powershell
# 1. Mon serveur bloque-t-il ?
nslookup doubleclick.net 172.28.114.203     # (l'adresse de votre Linux)
#    Attendu : 0.0.0.0

# 2. Mon poste l'interroge-t-il vraiment ?
nslookup doubleclick.net
#    Attendu : 0.0.0.0

# 3. Peut-on me contourner ?
nslookup doubleclick.net 8.8.8.8
#    Attendu : délai d'attente (sinon : contournable)
```

Si le test 1 échoue, inutile de regarder les autres : le problème est sur
la machine Linux, pas sur le réseau.

---

# Réponses à vos deux questions

## « Vérifie que ça ne crée pas de charge excessive »

Fait, par le calcul — je peux compter ce que le code émet, même sans accès
à votre réseau.

**Ce que 5 machines en parallèle envoient, en pointe :**

| | Quantité | Comparaison |
|---|---|---|
| Processus nmap simultanés | 5 au maximum | — |
| Paquets par seconde | 500 à 1 500 | un poste qui charge une page web en émet autant |
| Débit | ~0,7 Mbit/s | **0,07 %** d'un lien gigabit |
| Connexions TCP ouvertes en pointe | 95 (19 ports × 5 machines) | brèves : 400 ms chacune |
| Charge sur les machines visées | quasi nulle | un port fermé répond par un simple refus |

**Le vrai risque n'était pas la bande passante mais la détection.** Un
scan trop agressif ne casse rien : il se fait **bloquer**. Les pare-feux
et les sondes anti-intrusion réagissent au nombre de connexions
simultanées venant d'une même machine. À 50 en parallèle, on franchit les
seuils courants et le scan renverrait **moins** de résultats en étant plus
agressif. À 5, le trafic reste de même nature qu'avant — simplement cinq
fois moins étalé dans le temps.

C'est pourquoi j'ai gardé 5 et plafonné le réglage `SCAN_CONCURRENCE` à
20 : pour qu'une valeur tapée à la légère (500) ne transforme pas votre
agent en outil d'attaque sur le réseau d'un client.

**Ce que j'ai vérifié en test** (`npm test`, 37 tests au vert) : que la
limite de 5 n'est **jamais** dépassée, même transitoirement, même quand
les machines répondent à des vitesses très inégales. C'était le point
sensible — c'est là qu'un bug serait invisible chez vous et visible chez
le client.

## « Confirme le nouveau temps sur un /23 réel »

**Je ne peux pas, et je ne vais pas faire semblant.** Je n'ai aucun accès
à votre réseau. Ce que je peux vous donner :

- un **modèle** calculé à partir des délais réellement codés (1,5 s
  d'attente SNMP, ~6 s de nmap, 0,4 s de ports) :

  | Machines actives | Avant | Après | Gain |
  |---|---|---|---|
  | 12 | 1 min 13 s | 24 s | 3,1× |
  | 25 | 2 min 57 s | 40 s | 4,4× |
  | 50 | 6 min 01 s | 1 min 20 s | 4,5× |

- l'**outil de mesure** de l'étape 3, qui produit le vrai chiffre sur vos
  machines.

Le tableau ci-dessus est une prédiction. Tant que vous ne m'avez pas
envoyé le bloc RÉSULTAT, **je considère ce travail comme non confirmé** —
pas terminé.

---

# Ce que j'ai changé (résumé court)

| Fichier | Changement |
|---|---|
| `services/parLots.js` | **nouveau** — la brique qui limite à 5 machines à la fois |
| `services/discoveryService.js` | identification par lots de 5 au lieu d'une par une |
| `tools/mesurer-scan.js` | **nouveau** — l'outil de l'étape 3 |
| `tests/parLots.test.js` | **nouveau** — 13 tests sur la limite de concurrence |
| `agent/installer.ps1` et `.sh` | ne déclarent plus un échec quand le scan n'a pas fini |
| `agent/agent.js` | affiche son avancement au lieu de rester muet |
| `services/monitoringService.js` | ne s'arrête plus si une migration manque |
| `services/politiqueWebService.js` | **nouveau** — compilation des politiques de blocage web |
| `routes/accesWeb.js` | **nouveau** — API de la politique web |
| `agent/dnsGuard.js` | **nouveau** — application de la politique sur dnsmasq |
| `tools/importer-listes-web.js` | **nouveau** — import des listes de domaines |
| `Components/AccesWebPage.jsx` | **nouveau** — écran Accès web |
| `tests/politiqueWeb.test.js` | **nouveau** — 21 tests sur le blocage |

`npm test` dans `backend` : **58 tests, tous au vert.**

---

# Sur le point 3, ce qu'il faut savoir avant de le vendre

**Ce que la plateforme ne peut pas faire, par construction.** Aucune
table ne relie une requête DNS à une personne, un poste ou une adresse
IP. Il n'y a nulle part d'historique de navigation. Ce n'est pas un
filtrage appliqué à l'affichage : la donnée n'existe pas en base, et
dnsmasq est configuré sans journalisation des requêtes. Même en le
voulant, l'application ne peut pas répondre à « quels sites a visités
Untel ».

C'est un argument de vente, pas seulement une contrainte. Un client qui
demande cette fonction demande un outil de surveillance des salariés —
produit différent, obligations légales différentes.

**La limite honnête à annoncer.** Les règles de pare-feu couvrent les
fournisseurs DNS grand public, ceux que les navigateurs utilisent par
défaut. Elles ne couvrent pas un service DoH auto-hébergé sur un domaine
quelconque : rien ne distingue ce trafic d'une visite de site web
ordinaire. Contre quelqu'un de déterminé et compétent, aucun filtrage DNS
ne tient — la réponse à ce niveau est un proxy d'entreprise. Le filtrage
DNS traite l'usage courant, ce qui est l'essentiel du besoin réel.

Dites-le au client avant qu'il le découvre. Une limite annoncée est un
gage de sérieux ; la même limite découverte est un mensonge.

**Ce qui reste à faire sur ce point**, et que je n'ai pas écrit :

1. **La page de blocage.** Aujourd'hui un domaine bloqué renvoie `0.0.0.0`,
   ce qui donne une erreur de connexion illisible. Servir une vraie page
   *« bloqué par la politique de l'entreprise »* demande un petit serveur
   web sur l'agent. Une demi-journée, et c'est ce qui fait la différence
   entre « le réseau est cassé » et « la règle fonctionne » aux yeux d'un
   utilisateur.

2. **Le comptage par catégorie.** Le compteur remonté aujourd'hui est un
   total global issu de `dnsmasq --stats`, qui mélange cache et blocages.
   Il est donc imprécis, et l'écran ne l'affiche volontairement pas
   encore : mieux vaut aucun chiffre qu'un chiffre faux. Un comptage
   exact par catégorie demande de lire les statistiques autrement, sans
   journaliser les requêtes — faisable, mais c'est un chantier en soi.

3. **Un installateur pour dnsmasq**, qui ferait les étapes 6d
   automatiquement quand l'agent tourne sous Linux avec les droits.
