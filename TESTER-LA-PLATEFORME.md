# Tester NetSecureManager

Parcours complet de vérification. Comptez **40 minutes**.

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
casse une fonction entière, la cohérence des données et les 190 tests
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

Outils de développement (**F12**) → onglet **Réseau**, puis naviguez.

| À chercher | Attendu |
|---|---|
| `mot_de_passe_hash` | **jamais présent** |
| `agent_token` dans `/api/sites` | **jamais présent** |
| `snmp_v3_auth_key` | **jamais présent** |
| valeurs de `/api/configuration` | masquées si la clé contient `pass`, `secret`, `token` |

Un seul de ces champs visible est un défaut à corriger avant toute
démonstration.

### T16. Le cloisonnement par site tient

Créez un utilisateur rattaché à un seul site, connectez-vous avec.

**Attendu :** il ne voit que les équipements, alertes et incidents de son
site. Le sélecteur de site en haut n'affiche que le sien.

### T17. Le dernier administrateur est protégé

Essayez de supprimer le dernier compte administrateur global, ou de
supprimer votre propre compte.

**Attendu :** un refus explicite. Sans cette protection, on peut se
verrouiller hors de sa propre plateforme.

### T18. La création de compte est fermée

Déconnectez-vous, puis dans PowerShell :

```powershell
curl.exe -X POST http://localhost:5000/api/auth/register -H "Content-Type: application/json" -d "{\"email\":\"pirate@test.fr\",\"mot_de_passe\":\"motdepasse123\",\"role\":\"admin\"}"
```

**Attendu :** un refus (403).

Cette route servait à créer le tout premier compte, mais restait ouverte
ensuite : n'importe qui sur le réseau pouvait se fabriquer un compte
administrateur. Elle n'accepte plus que si la table des utilisateurs est
**entièrement vide**, et le rôle n'est plus lu depuis la requête.

### T18b. Les tentatives de connexion sont freinées

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

Envoyez-moi la grille remplie, même partiellement. Les échecs
m'intéressent plus que les réussites — et une case « pas compris » est
une information utile, pas un aveu.
