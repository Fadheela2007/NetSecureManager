# Tester NetSecureManager

Parcours complet de vérification. Comptez **55 minutes** — 40 pour les
parties 0 à 5, un quart d'heure pour la partie 6 (corrections de l'audit
du 8 septembre).

Chaque test indique ce que vous devez voir, et quoi faire sinon. Faites-les
dans l'ordre : un test qui échoue rend les suivants inexploitables.

**Notez ce qui ne va pas au fur et à mesure** plutôt que de vous arrêter au
premier problème — sauf indication contraire.

---

## Avant de commencer

Trois fenêtres à garder ouvertes :

| Fenêtre | Comment l'ouvrir | Reconnaissable à |
|---|---|---|
| **Backend** | `cd ...\backend` puis `npm start` | le journal du serveur défile |
| **Frontend** | `cd ...\frontend` puis `npm run dev` | affiche une adresse `http://localhost:5173` |
| **PowerShell** | touche Windows, `powershell` | invite `PS C:\>` |

---

# Partie 0 — Le contrôle automatique

**Ce qui a changé :** les anciens tests T1, T2 et T6 (démarrage, tests
unitaires, registre des fabricants) se vérifiaient à la main. Ils sont
maintenant couverts par une seule commande, plus fiable qu'une lecture de
journal — un œil humain ne repère pas une ligne d'erreur au milieu de
trois cents.

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
node tools\appliquer-migrations.js
node tools\verifier-tout.js
```

Les migrations d'abord : deux d'entre elles sont récentes (origine du nom,
nom personnalisé). Sans elles, la liste d'équipements renvoie une erreur
de colonne inconnue, et vous chercheriez la panne ailleurs.

**Attendu :** aucune ligne rouge. Une ligne jaune est un point d'attention,
pas un échec — le texte dit quoi faire.

Il contrôle la configuration, les 21 tables, les colonnes dont l'absence
casse une fonction entière, la cohérence des données et les 286 tests
unitaires.

**Ne passez à la suite que si cette commande est propre.** Tout ce qui suit
suppose une base saine ; déboguer un scan sur une base incomplète fait
perdre des heures.

### T3. Le frontend se construit

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\frontend
npm run build
```

**Attendu :** `✓ built in ... s`.

C'est le seul test que je ne peux jamais faire à votre place : mes outils
tournent sous Linux, vos dépendances sont compilées pour Windows.

---

# Partie 1 — La découverte du réseau

### T4. Un scan trouve des machines

Interface → tableau de bord → **Lancer un scan réseau**. Saisissez votre
plage (`192.168.0.0/23`).

**Attendu :** une liste d'équipements avec adresse IP, nom, fabricant,
type.

**Combien de temps :** environ une minute pour 25 machines actives. Si
c'est beaucoup plus long :

```powershell
node tools\mesurer-scan.js 192.168.0.0/23
```

### T5. Les types sont plausibles

Page **Équipements**, colonne « type ».

**Attendu :** `poste_travail` pour les PC, `imprimante` pour les
imprimantes, `routeur/switch` pour les équipements réseau, `inconnu`
pour ce qui ne peut pas être déterminé.

**Ce qui serait un défaut :** un poste Windows classé `serveur`, ou un
type absent de cette liste. Signalez-le-moi avec la ligne `sys_descr` de
l'équipement, et la valeur de `type_source` — cette colonne dit quelle
règle a décidé, ce qui rend le diagnostic immédiat au lieu d'être une
enquête.

`inconnu` n'est **pas** un défaut. Mieux vaut « inconnu » qu'une
catégorie fausse : c'est une règle du produit, pas une limite.

### T6. Les fabricants sont renseignés

**Attendu :** la plupart des équipements ont un fabricant.

Le registre lui-même est vérifié en Partie 0. Si le compte est bon mais
que la colonne reste vide dans l'interface, c'est que les équipements ont
été découverts **avant** l'import : le fabricant est résolu au scan, pas
à l'affichage. Relancez un scan.

**Nuance à connaître :** l'OUI identifie la **carte réseau**, pas la
machine. Un serveur Dell avec une carte Intel remontera « Intel ». Ce
n'est pas une erreur, et la colonne `fabricant_source` le dit.

### T6b. Les noms d'équipements sont renseignés

**Attendu :** la colonne « nom » n'est pas vide partout.

Quatre sources sont interrogées en parallèle : SNMP, DNS inverse,
NetBIOS et mDNS. Pour savoir laquelle répond sur ce réseau :

```powershell
node tools\diagnostic-noms.js
```

**Ce qui n'est PAS un défaut :** une caméra, un module industriel ou un
capteur n'a pas de nom de machine. Sa case reste vide, et c'est correct —
mieux vaut vide qu'un modèle déguisé en nom.

**Si TOUT est vide alors que le parc compte des postes Windows :**

```powershell
node tools\sonde-mdns.js
```

Cette sonde interroge tout le réseau d'un coup et dit ce qui parle.

### T6c. Renommer un équipement

Ouvrez la fiche d'un équipement → bouton **Nommer** → saisissez
« Imprimante comptabilité ».

**Attendu :** le nom apparaît dans la liste, avec le nom réseau
(`KMBFD6FC`) en sous-titre.

**Le test qui compte — relancez un scan ensuite.** Votre nom doit
SURVIVRE. S'il disparaît, signalez-le-moi immédiatement : cela voudrait
dire que le scan écrase la saisie manuelle, et personne ne recommence
un travail effacé sans explication.

### T6d. Les conflits d'adresses

**Attendu, après un scan :** aucune alerte de conflit sur un réseau sain.

**Test volontaire, si vous pouvez :** attribuez à une machine l'adresse
IP fixe d'une autre déjà présente, puis relancez un scan. Une alerte
« conflit d'adresses probable » doit apparaître.

**Ce qui serait un DÉFAUT :** des dizaines d'alertes de conflit après un
scan normal. Cela signifierait que le routeur répond pour tout le
sous-réseau et que le filtre ne joue pas. Signalez-le-moi avec le nombre
d'alertes.


---

# Partie 2 — La supervision dans la durée

### T7. Les relevés arrivent

La Partie 0 vous a déjà dit combien de relevés sont arrivés ces quinze
dernières minutes. Ici on vérifie qu'ils sont **exploitables**, pas
seulement présents.

Ouvrez la fiche d'un équipement qui répond en SNMP.

**Attendu :** un graphique avec des points.

**Si le graphique est vide :** normal si aucune machine n'expose SNMP.
L'écran vous le dit désormais explicitement, en distinguant « cet
équipement n'expose pas SNMP » de « pas encore mesuré » — deux situations
qui appellent des actions opposées.

La plupart des postes Windows n'activent pas SNMP par défaut. **Ce n'est
pas une panne**, mais c'est le point à préparer avant une démonstration.

### T8. Les alertes ne saturent plus

Page **Alertes**.

**Attendu :** une alerte par problème, avec un compteur `×12` si le
problème persiste — et non douze lignes identiques.

**Test volontaire :** débranchez une machine, attendez trois cycles.
Vous devez voir **une** alerte apparaître, dont le compteur monte.

### T9. L'acquittement fonctionne

Cochez plusieurs alertes → **Acquitter**.

**Attendu :** elles passent dans l'onglet « Acquittées » et sortent de la
file à traiter.

**Vérifiez qu'elles ne sont pas supprimées :** l'onglet doit les
contenir, et le taux de disponibilité ne doit pas changer. Acquitter
n'est pas supprimer.

---

# Partie 3 — La bande passante

### T10. Le classement se remplit

Page **Bande passante**.

**Attendu :** un classement des plus gros consommateurs, ou un bandeau
disant « X équipements mesurés sur Y ».

**Si le classement est vide :** il faut **deux** relevés SNMP pour
calculer un débit — le premier ne peut mathématiquement rien mesurer.
Attendez un cycle de plus.

### T11. Le détail par port

Cliquez sur un switch dans le classement.

**Attendu :** un graphique d'historique, puis un tableau des ports avec
leur débit et leur taux d'occupation.

**Point à vérifier :** un switch doit afficher la mention « cumul des
ports ». La somme des ports n'est pas le débit de transit — une trame
qui entre par le port 3 et sort par le port 7 est comptée deux fois.

**Repli sans SNMP :** si un équipement n'expose pas SNMP mais est
raccordé à un switch qui l'expose, son trafic est attribué par port. La
colonne « source » distingue `snmp` (mesure directe) de `port`
(attribution). L'attribution est **refusée** si plusieurs MAC sont vues
sur le même port : une valeur fausse serait pire qu'une case vide.

---

# Partie 4 — Le blocage web

Cette partie a son propre document : **`OU-EN-SUIS-JE.md`**.

### T12. Le résolveur bloque

```bash
sudo bash .../backend/src/agent/diagnostic-blocage.sh
```

**Attendu :** aux étapes 4 et 5, `BLOQUÉ` — **en A ET en AAAA**.

L'IPv6 compte autant que l'IPv4 : les navigateurs la préfèrent quand
elle existe. Un domaine bloqué en A mais joignable en AAAA n'est pas
bloqué du tout.

### T13. Le poste utilise bien le résolveur

```powershell
nslookup doubleclick.net
```

Sans préciser de serveur. **Attendu :** l'adresse de blocage.

**Si vous obtenez la vraie adresse :** votre poste interroge un autre
DNS. Voir `OU-EN-SUIS-JE.md`, pièce D.

### T14. Le contournement est fermé

```powershell
nslookup doubleclick.net 8.8.8.8
```

**Attendu :** délai d'attente.

**Si ça répond :** les règles de pare-feu ne sont pas posées. Sur une box
d'opérateur grand public, c'est souvent impossible — à dire au client
plutôt qu'à découvrir chez lui.

---

# Partie 5 — Les protections

Ces tests vérifient que la plateforme **refuse** ce qu'elle doit refuser.
Ils comptent autant que les autres : un acheteur sérieux les fera.

### T15. Aucun secret ne sort

```powershell
node tools\verifier-secrets.js votre-email
```

Le mot de passe est demandé ensuite, sans s'afficher.

**Attendu :** dix-sept routes examinées, aucun secret, et l'exception
documentée (`/sites/:id/agent` sert le jeton, réservé aux
administrateurs).

**Ce que l'outil garantit et que l'œil ne garantit pas :** une route qui
répond en erreur est comptée comme **non examinée**, jamais comme
réussie.

**Pourquoi ce n'est plus un contrôle manuel.** La version précédente
demandait de fouiller l'onglet Réseau des outils du navigateur. Trois
pièges, tous rencontrés :

- si la liste des requêtes est vide — panneau ouvert trop tard, page non
  rechargée — la recherche répond « rien trouvé ». C'est vrai, et ça ne
  prouve rien ;
- en développement, Vite sert le code source en clair : la recherche y
  trouve des correspondances qui ne sont pas des fuites ;
- le résultat dépend des pages auxquelles on a pensé.

### T16. Le cloisonnement par site tient

Créez un utilisateur rattaché à un seul site, puis :

```powershell
node tools\verifier-cloisonnement.js son-email
```

**Attendu :** « Le cloisonnement tient. »

L'outil compare ce que contient la base à ce que reçoit ce compte, et
vérifie cinq points — dont **le plus important, qu'un test à l'œil ne
voit jamais** : l'accès DIRECT par identifiant à un équipement d'un autre
site doit être refusé (404). Filtrer les listes ne suffit pas ; si
`/equipements/47/interfaces` répond, il suffit de deviner un numéro.

Faites ensuite le tour dans l'interface pour l'impression générale, mais
c'est l'outil qui tranche.

### T17. Le dernier administrateur est protégé

Essayez de supprimer le dernier compte administrateur global, ou de
supprimer votre propre compte.

**Attendu :** un refus explicite. Sans cette protection, on peut se
verrouiller hors de sa propre plateforme.

### T18. La création de compte est fermée

```powershell
node tools\verifier-protections.js
```

**Attendu :** « Tous les refus attendus sont en place » — dix contrôles :
création de compte, lecture sans jeton, jeton inventé, injection
d'équipements par un faux agent, réinitialisation sans authentification.

**Pourquoi plus de commande curl.** PowerShell réinterprète les
guillemets échappés : le serveur recevait du JSON tronqué et répondait
« Requête invalide ». Un refus, mais pas celui qu'on voulait vérifier —
et le test paraissait concluant sans avoir rien testé.

L'outil n'accepte que **401 ou 403**. Un 400 pour corps malformé n'est
pas une preuve : un refus ne vaut que si l'on sait pourquoi il a été
prononcé.

Cette route servait à créer le tout premier compte, mais restait ouverte
ensuite : n'importe qui sur le réseau pouvait se fabriquer un compte
administrateur. Elle n'accepte plus que si la table des utilisateurs est
**entièrement vide**, et le rôle n'est plus lu depuis la requête.

### T18b. Les tentatives de connexion sont freinées

> **Reporté après la mise en ligne.** Ce test exige un SECOND appareil
> capable d'atteindre la plateforme, ce que le poste de développement ne
> permet pas simplement : un téléphone en 4G n'atteint pas `localhost`,
> et le mettre sur le même Wi-Fi demande de modifier `FRONTEND_URL` puis
> de le remettre en état. Une fois la plateforme hébergée, le test tient
> en deux minutes depuis n'importe où.

Sur l'écran de connexion, saisissez **onze fois** un mauvais mot de passe
pour un compte existant.

**Attendu :** au bout d'une dizaine d'essais, le message change — « Trop
de tentatives de connexion. Réessayez dans N minutes. »

**Le point qui compte, et qui se teste :** depuis un AUTRE poste (ou un
téléphone en 4G), connectez-vous avec le bon mot de passe **du même
compte**. Cela doit fonctionner.

Un compte n'est jamais bloqué, seulement ralenti. Bloquer un compte
après cinq échecs permettrait à n'importe qui de verrouiller votre
administrateur en saisissant de faux mots de passe : la protection
deviendrait l'attaque.

**Si le compte est inaccessible depuis l'autre poste :** c'est un défaut
grave, signalez-le-moi.


### T19. La réinitialisation demande une confirmation

Interface → **Configuration** → bas de page → **Ouvrir la
réinitialisation**.

**Attendu :**

- rien n'est coché au départ ;
- chaque ligne affiche le **nombre réel** de lignes concernées ;
- la liste de ce qui n'est jamais effacé est affichée ;
- le bouton reste inactif tant que vous n'avez pas recopié
  `REINITIALISER`.

**Test complet, à faire APRÈS avoir noté vos autres résultats :** cochez
« Équipements découverts », confirmez, puis relancez un scan.

**Attendu :** parc vide, puis repeuplé par le scan. Vos comptes, sites,
jetons d'agent et politiques web sont **intacts** — reconnectez-vous
pour le vérifier.

---

# Partie 6 — L'interface

Ces tests ne cherchent pas des pannes mais des impressions. C'est ce que
l'acheteur voit en premier, avant toute fonctionnalité.

### T20. Le tableau de bord se lit en cinq secondes

**Attendu :** une phrase de verdict en haut (« Tout le parc répond »,
« 3 équipements ne répondent plus »…), puis quatre chiffres, chacun avec
une note qui dit ce qu'il signifie.

**Ce qui serait un défaut :** deux éléments qui se contredisent — un
verdict rassurant à côté d'un chiffre alarmant. Signalez-le-moi avec une
capture.

Le tableau de bord n'affiche que les **cinq** alertes prioritaires et les
cinq équipements récents. C'est volontaire : une page qui déroule tout ne
hiérarchise rien.

### T21. Les listes se filtrent

Page **Équipements** : cliquez sur les filtres de statut, triez par
colonne (dont l'adresse IP — elle doit se trier par valeur, `.9` avant
`.10`, pas alphabétiquement).

Page **Alertes** : filtrez par niveau, cherchez un texte.

**Attendu :** les compteurs de filtres restent stables quand vous filtrez
(ils comptent sur la liste complète), et l'en-tête du tableau reste
visible en défilant.

### T22. Les deux thèmes tiennent

Basculez clair/sombre avec le bouton en haut.

**Attendu en clair :** les cartes se détachent nettement du fond. Le
texte gris reste lisible. Aucun texte de couleur (vert, rouge, ambre) ne
paraît délavé.

**Attendu en sombre :** les couleurs d'état ne « vibrent » pas.

Si une zone reste illisible dans l'un des deux, notez laquelle.

### T23. L'interface dit quand elle ne sait pas

**Le test le plus important de cette partie.**

Dans la fenêtre du backend, appuyez sur **Ctrl + C** pour l'arrêter.
Laissez l'interface ouverte, puis parcourez les pages : Tableau de bord,
Équipements, Alertes, Incidents, Journal, Topologie, Sites,
Configuration.

**Attendu sur CHAQUE page :** un message disant que le serveur ne répond
pas, et un bouton **Réessayer**.

**Ce qui serait un DÉFAUT — et le plus grave du produit :** une page qui
affiche « Tout le parc répond », « Aucun équipement », « Rien à traiter »
ou tout autre message rassurant. Un outil de supervision qui annonce que
tout va bien alors qu'il ne voit plus rien est pire qu'inutile : il est
trompeur.

Relancez ensuite le backend, cliquez sur **Réessayer** : les données
doivent revenir sans avoir à recharger la page.

**Deuxième volet — la session expirée.** Ouvrez les outils de
développement (F12) → onglet **Application** → effacez le stockage local,
puis naviguez. Le message doit dire « Session expirée », et non
« Le serveur ne répond pas ». Trois causes, trois messages : les
confondre oblige l'utilisateur à deviner laquelle.


---

# Ce qu'il faut savoir avant une démonstration

Trois points qui ne sont pas des défauts, mais qui surprennent si on ne
les a pas anticipés.

**Sans SNMP sur le parc, la moitié des écrans est vide.** Bande passante,
graphiques de charge, détail des ports : tout vient de SNMP, que la
plupart des postes Windows n'activent pas. Activez-le sur deux ou trois
machines avant une démonstration, ou préparez un jeu de données.

**Le premier cycle ne mesure rien.** Débit et taux d'utilisation se
calculent entre deux relevés. Lancez la plateforme au moins dix minutes
avant de montrer quoi que ce soit.

**Le blocage web demande une machine Linux et un accès au routeur.**
C'est la fonction la plus impressionnante et la plus longue à installer.
Si la démonstration est courte, montrez-la sur votre propre poste plutôt
que sur le réseau du client.

---

# Grille à me renvoyer

| Test | Résultat | Remarque |
|---|---|---|
| Partie 0 contrôle auto | | |
| T3 build | | |
| T4 scan | | |
| T5 types | | |
| T6 fabricants | | |
| T6b noms | | |
| T6c renommage | | |
| T6d conflits IP | | |
| T7 relevés | | |
| T8 alertes | | |
| T9 acquittement | | |
| T10 bande passante | | |
| T11 ports | | |
| T12 blocage DNS | | |
| T13 poste | | |
| T14 contournement | | |
| T15 secrets | | |
| T16 cloisonnement | | |
| T17 dernier admin | | |
| T18 création compte | | |
| T18b force brute | | |
| T19 réinitialisation | | |
| T20 tableau de bord | | |
| T21 listes | | |
| T22 thèmes | | |
| **T23 serveur arrêté** | | |

---

# Partie 7 — Ce que l'audit du 8 septembre a changé

Ces six tests portent sur des défauts trouvés pendant l'audit et corrigés
depuis. Chacun est décrit avec **ce qu'il vérifie** et **pourquoi ça compte** :
ce sont exactement les questions qu'un acheteur pose, et vous devez pouvoir y
répondre sans hésiter.

Cinq d'entre eux sont déjà couverts par `node tools\verifier-tout.js` (section 7)
— celui-ci lit le code et exécute les fonctions concernées. Ce qui suit vérifie
le **comportement réel**, ce qu'aucun programme ne peut faire à votre place.

### T24. Un administrateur de site ne touche pas au blocage web d'un autre site

**Ce que ça vérifie.** Le cloisonnement en ÉCRITURE. Jusqu'au 8 septembre, trois
routes du contrôle d'accès web recevaient un identifiant de *politique* — jamais
un identifiant de *site* — et ne vérifiaient rien. Un administrateur du site 2
pouvait, en changeant un nombre dans l'URL, débloquer une catégorie chez un
autre client.

**Pourquoi ça compte.** C'est LA question d'un prestataire informatique qui gère
plusieurs clients avec votre plateforme. S'il ne peut pas cloisonner, il ne
l'achète pas.

**Comment faire.** Il faut deux comptes : un administrateur **global**
(`id_site` à NULL) et un administrateur **rattaché au site 2**. Créez le second
depuis l'écran Utilisateurs avec le premier.

Connectez-vous avec l'administrateur rattaché, puis dans les outils du
navigateur (F12 → Console) :

```js
// Remplacez 1 par l'identifiant d'une politique appartenant à un AUTRE site.
await fetch("http://localhost:5000/api/acces-web/politique/1/domaine", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + localStorage.getItem("token"),
  },
  body: JSON.stringify({ domaine: "test-audit.example", action: "bloquer" }),
}).then((r) => r.status);
```

**Attendu : `403` ou `404`.** Jamais `200`.

Refaites l'essai avec l'administrateur **global** : là, `200` est correct — il a
le droit.

**Troisième volet.** Toujours avec l'administrateur rattaché, appelez
`PUT /api/acces-web/politique` **sans champ `id_site`**. C'était le cas le plus
piégeux : `id_site` vaut `null` par défaut, `null` désigne la politique appliquée
à TOUS les sites, et l'ancien test ne se déclenchait jamais dessus.

**Attendu : `403`**, avec un message disant que seul un administrateur global
peut modifier la politique par défaut.

### T25. Une plage trop large est refusée au lieu de faire tomber le serveur

**Ce que ça vérifie.** Qu'une faute de frappe dans un masque ne tue pas la
supervision. `10.0.0.0/8` au lieu de `10.0.0.0/24` — un caractère — demandait la
construction d'une liste de 16,7 millions d'adresses. Le processus dépassait la
mémoire et **toute la supervision s'arrêtait**, y compris pour les sites qui
n'avaient rien demandé.

**Pourquoi ça compte.** Ce n'est pas un scénario d'attaquant : c'est une erreur
d'opérateur légitime, un jour de démonstration.

**Comment faire.** Dans l'écran de scan, saisissez `10.0.0.0/8` et lancez.

**Attendu :** un refus immédiat — moins d'une seconde — avec un message qui
indique le nombre d'adresses, la limite, et quoi faire. Le serveur continue de
tourner : vérifiez que la fenêtre du backend n'affiche aucune erreur et que
l'interface répond toujours.

**Puis relancez un scan normal sur votre `/24` habituel** : il doit fonctionner
exactement comme avant. Le plafond ne doit rien avoir cassé.

### T26. Le journal montre enfin qui touche aux comptes et aux jetons

**Ce que ça vérifie.** Avant le 8 septembre, la création, la modification et la
suppression de comptes, la régénération d'un jeton d'agent, la création d'un
site et les changements de réglages **ne laissaient aucune trace**. L'écran
« Journal d'activité » existait et ne montrait rien de tout cela.

**Pourquoi ça compte.** C'est la première chose qu'un audit d'acheteur vérifie.
Et en exploitation courante, c'est ce qui permet de répondre « qui a régénéré ce
jeton » six mois plus tard, quand un site ne remonte plus et que personne ne se
souvient d'avoir cliqué.

**Comment faire.** Enchaînez ces cinq actions, puis ouvrez l'écran Journal :

1. créez un compte de test (écran Utilisateurs) ;
2. changez son rôle ;
3. supprimez-le ;
4. régénérez le jeton d'agent d'un site (écran Sites → Mise en service) ;
5. modifiez un seuil dans Configuration.

**Attendu :** cinq lignes, chacune avec votre nom, l'heure et une description
qui dit **ce qui a changé** — « rôle → operateur », et non « compte modifié ».
La ligne du jeton doit dire que l'ancien est révoqué, et ne doit **pas** contenir
le jeton lui-même.

### T27. Le total de bande passante est un vrai total

**Ce que ça vérifie.** Le bloc en haut de l'écran Bande passante calculait une
**moyenne** en l'appelant « total ». Sur vingt machines mesurées, il affichait
environ un vingtième du débit réel du parc.

**Pourquoi ça compte.** C'est la pire catégorie d'erreur sur un outil de mesure :
le chiffre était petit, plausible, et rien ne signalait l'anomalie. Un client qui
dimensionne sa connexion Internet sur cette valeur se trompe d'un ordre de
grandeur — et c'est votre produit qu'il tiendra pour responsable.

**Comment faire.** Ouvrez l'écran Bande passante. Comparez le chiffre
« Descendant — total du parc » à la somme des colonnes du classement en dessous.

**Attendu :** le total est **supérieur ou égal** à la plus grosse ligne du
classement, et du même ordre de grandeur que la somme des lignes. S'il est plus
PETIT que la première ligne du classement, le défaut est revenu.

**Second volet — le pic.** L'étiquette doit dire « pic simultané ». Ce chiffre
est le plus fort débit **au même instant**, calculé minute par minute : deux
machines qui saturent le lien à des heures différentes ne l'ont jamais saturé
ensemble. Un pic simultané supérieur à la somme des moyennes est normal ; un pic
égal à la somme de tous les pics individuels serait le signe que le calcul est
revenu en arrière.

### T28. Les titres de colonnes tiennent au défilement

**Ce que ça vérifie.** Le fond de l'en-tête collant était déclaré sur `<thead>`.
Or, dans le mode de rendu utilisé par les tableaux, Firefox et les versions de
Chrome antérieures à la 91 **ne peignent pas** ce fond. Combiné à l'en-tête
collant, les lignes défilaient **derrière** les titres, qui devenaient illisibles.

**Comment faire.** Écran Équipements, avec assez de machines pour que la liste
défile. Faites défiler jusqu'en bas.

**Attendu :** les six titres (Statut, Nom, Adresse IP, Fabricant, Type, Dernière
découverte) restent visibles en haut, sur un fond opaque, sans qu'aucune ligne
n'apparaisse au travers.

**À refaire dans Firefox si vous l'avez** — c'est le navigateur où le défaut se
voyait, et celui qu'un client peut très bien utiliser.

⚠ **Avant ce test, recompilez** : `cd frontend` puis `npm run build`. Si vous
testez avec `npm run preview`, vous regardez la dernière version compilée — qui
peut dater d'avant les corrections. Rechargez ensuite avec **Ctrl + Maj + R**
pour vider le cache.

### T29. Le scan a gagné en vitesse

**Ce que ça vérifie.** nmap représente environ 93 % de la durée d'un scan, et le
réglage qui décide de tout est le nombre de machines analysées **en même temps**.
Il valait 5, il vaut 10.

**Comment faire.** Chronométrez un scan complet de votre `/24` habituel, sur un
parc où les machines n'ont jamais été identifiées (ou juste après une
réinitialisation des équipements).

**Attendu :** environ deux fois plus rapide qu'avant — de l'ordre d'une minute
quarante pour 44 machines actives, contre trois minutes.

**Si vous voulez aller plus vite :** ajoutez `SCAN_CONCURRENCE=16` dans
`backend/.env` et redémarrez. À réserver aux réseaux sans sonde d'intrusion, ou
aux scans de nuit — 16 sondes simultanées restent modestes, mais c'est un choix
qui appartient à l'exploitant.

**Ce qui n'est PAS corrigé, et qu'il faut savoir avant de conclure.** Un
**rescan** peut rester aussi lent que le premier. Le code évite normalement nmap
sur une machine déjà identifiée, mais seulement si son adresse MAC est connue —
or le serveur ne connaît les MAC que du réseau auquel il est **directement
raccordé**. Sur un VLAN routé, aucune MAC n'est vue et chaque scan repaie nmap
en entier. Si votre rescan est aussi long que le premier scan, c'est cela, pas
une régression.

---

### T30. L'interface bouge toute seule

**Ce que ça vérifie.** Un outil de supervision devant lequel on appuie sur F5
pour faire apparaître ce qu'on vient de provoquer se disqualifie en démonstration.

Deux mécanismes se complètent : les **événements** (le serveur émet `cycle`,
`scan`, `equipement`, `alerte` ; cinq écrans les écoutent) rafraîchissent dans la
seconde, et une **scrutation de secours** toutes les 60 secondes garantit un
plancher si le temps réel est désactivé. La scrutation s'arrête quand l'onglet
est caché — un poste de supervision reste ouvert toute la journée — et rafraîchit
immédiatement au retour sur l'onglet.

**⚠ À FAIRE AVANT CE TEST.** Recompilez :

```powershell
cd C:\Users\LENOVO\Documents\NetSecureManager\frontend
npm run build
```

Le temps réel a été ajouté le 8 septembre. Une version compilée antérieure ne
contient tout simplement pas `socket.io-client` : l'interface ne peut pas bouger,
quel que soit le réglage serveur. C'est vérifiable — cherchez `socket.io` dans
`dist/assets/*.js`, il doit s'y trouver.

**Comment faire.** Ouvrez la page Alertes et laissez-la. Dans une autre fenêtre,
lancez un scan, ou attendez la fin d'un cycle de supervision.

**Attendu :** la page se met à jour **sans que vous la rechargiez**. Au démarrage
du backend, le journal doit dire « Temps réel activé pour l'origine … » ; s'il dit
« Temps réel désactivé », `WEBSOCKET_ORIGINE` manque dans `.env` — la scrutation
prend alors le relais et l'écran bouge quand même, avec une minute de retard.

### T31. Le débit du parc dans le temps

**Ce que ça vérifie.** Les trois tuiles de total répondent « combien », la courbe
répond « quand ». Une moyenne sur 24 h noie la demi-heure de sauvegarde qui met
le lien à genoux tous les soirs — et c'est celle-là qu'un exploitant cherche.

**Comment faire.** Écran Bande passante, bloc « Débit du parc dans le temps ».

**Attendu :** une courbe entrant/sortant sur la période choisie, qui se complète
toute seule à chaque cycle. Changez de période (1 h, 24 h, 7 j) : la granularité
s'adapte, environ 200 points quelle que soit la durée.

**Ce qui n'est PAS un défaut :** le message « un seul point de mesure pour
l'instant ». Le débit se calcule par **différence entre deux relevés SNMP** : il
faut donc deux cycles avant le premier chiffre. Avec un intervalle à 5 minutes,
comptez 10 minutes. Pour tester plus vite, passez `intervalle_scan_minutes` à 1
dans l'écran Configuration.

## Grille pour la Partie 7

| Test | OK / KO | Ce que vous avez observé |
|---|---|---|
| T24 cloisonnement blocage web | | |
| T25 plage trop large refusée | | |
| T26 journal des comptes et jetons | | |
| T27 total de bande passante | | |
| T28 titres de colonnes au défilement | | |
| T29 vitesse du scan | | |
| T30 interface dynamique | | |
| T31 courbe du débit global | | |


Envoyez-moi la grille remplie, même partiellement. Les échecs
m'intéressent plus que les réussites — et une case « pas compris » est
une information utile, pas un aveu.
