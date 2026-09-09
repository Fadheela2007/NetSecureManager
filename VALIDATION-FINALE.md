# Validation finale — NetSecureManager

**Avant la réunion de 16h30.** Compte 1 h 30.
Écrite pour **ton réseau à toi** : les résultats attendus tiennent compte de
ton parc réel (47 machines, 7 imprimantes, aucun commutateur administrable).

> **Comment lire cette fiche.** Chaque test dit ce que tu fais, ce que tu dois
> voir, et — c'est le plus important — **ce qui est normal même si ça ressemble
> à un défaut**. Ne t'arrête jamais sur un test : note et continue.

---

## Avant de commencer

```powershell
# 1. Backend, dans sa propre fenêtre, à laisser ouverte
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
npm start

# 2. Interface, à recompiler — plusieurs corrections en dépendent
cd C:\Users\LENOVO\Documents\NetSecureManager\frontend
npm run build
```

Puis **Ctrl + Maj + R** dans le navigateur. Sans ça tu testes l'ancienne version.

---

# A. Le socle — 10 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| A1 | `node tools\verifier-tout.js` | Aucune ligne rouge | ☐ |
| A2 | `node tools\diagnostic-supervision.js` | Site 1 en **CYCLE CENTRAL**, des relevés récents | ☐ |
| A3 | Regarder la fenêtre du backend au démarrage | « Temps réel activé », aucun avertissement de site exclu | ☐ |

**A2 est le verrou.** S'il échoue, arrête tout et dis-le-moi : sans relevés,
rien de ce qui suit ne peut fonctionner, et tu croirais à dix défauts là où il
n'y en a qu'un.

---

# B. La découverte — 20 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| B1 | Tableau de bord → **Détecter mes réseaux** | Ta plage proposée automatiquement | ☐ |
| B2 | Lancer le scan | Une liste : IP, nom, fabricant, type | ☐ |
| B3 | Saisir `10.0.0.0/8` et lancer | **Refus immédiat** avec un message clair, serveur toujours vivant | ☐ |
| B4 | `node tools\couverture.js` | Tes pourcentages — note-les, ils vont dans ton rapport | ☐ |

**Ce qui est normal et n'est pas un défaut :**

- Le scan est **long** — c'est ton réglage `SCAN_CONCURRENCE=3`, choisi pour
  rester discrète sur le réseau de l'entreprise. C'est le bon choix.
- Beaucoup de **noms vides**. Leur serveur DHCP n'enregistre pas ses baux dans
  le DNS : sur 12 machines testées, le DNS inverse en a nommé **zéro**. Il ne
  reste que NetBIOS et SNMP. Ce n'est pas ta plateforme, c'est leur réseau — et
  c'est une remarque à faire à ton encadreur.
- Beaucoup de types **« inconnu »**. Un appareil qui n'expose ni SNMP, ni port
  révélateur, ni signature nmap ne donne aucun signal. Le produit refuse de
  deviner : mieux vaut une case honnête qu'une catégorie fausse.
- Le **fabricant manquant** sur certaines machines : les téléphones modernes
  changent volontairement d'adresse matérielle à chaque réseau. Aucun registre
  ne peut les identifier — c'est une protection du téléphone.

---

# C. Les alertes — 15 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| C1 | `node tools\diagnostic-alertes.js` | **0 fantôme**, et seulement de vraies disparitions | ☐ |
| C2 | Page Alertes | Pas cinquante fois la même ligne | ☐ |
| C3 | Acquitter une alerte | Elle sort de la liste active | ☐ |

**Ce qui est normal :** des alertes sur des téléphones et des portables partis
du réseau. Elles sont **exactes** — ces machines ont répondu puis sont parties.
Ce qui a été corrigé aujourd'hui, ce sont les 11 alertes sur des machines qui
n'avaient **jamais** répondu.

---

# D. Les mesures — 20 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| D1 | Fiche d'un équipement (clic sur une ligne) | La **courbe de latence** s'affiche | ☐ |
| D2 | Fiche de `192.168.0.249` (imprimante HP) | Courbe mémoire autour de 94 % | ☐ |
| D3 | Page Bande passante | Bloc « Débit du parc dans le temps » avec une courbe | ☐ |
| D4 | Comparer le total au classement en dessous | Le total est **≥** la plus grosse ligne | ☐ |

**Ce qui est normal :**

- **Aucune courbe processeur.** Tes appareils SNMP sont des imprimantes, et la
  table de charge processeur est **facultative** dans la norme SNMP : elles ne
  la publient pas. Vérifié appareil par appareil.
- **« Aucune mesure sur cette période »** au début. Le débit se calcule par
  différence entre deux relevés : il faut deux cycles, soit 10 minutes.
- **Toutes les machines n'apparaissent pas** en bande passante. Seules celles
  qui exposent un compteur — environ une sur dix — plus celles branchées seules
  sur un port de commutateur. Le produit refuse d'attribuer un débit quand
  plusieurs machines partagent un port.

---

# E. L'interface — 15 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| E1 | Équipements, faire défiler la liste | Les **titres de colonnes restent visibles**, sur fond opaque | ☐ |
| E2 | Laisser Alertes ouverte, lancer un scan ailleurs | La page **bouge sans que tu la recharges** | ☐ |
| E3 | Page **Topologie** | Le titre + un encart expliquant qu'il manque un commutateur | ☐ |
| E4 | Basculer thème clair / sombre | Tout reste lisible dans les deux | ☐ |

**E3 est important pour ta réunion.** La topologie **ne peut rien afficher** :
les raccordements se lisent dans la table d'adresses des commutateurs, et ton
parc n'en contient aucun d'administrable. L'écran doit le **dire**, pas rester
blanc. Si tu vois une page littéralement vide, sans même le titre, signale-le.

---

# F. Les protections — 15 minutes

| N° | Tu fais | Tu dois voir | |
|---|---|---|---|
| F1 | Arrêter le backend (Ctrl+C), parcourir les pages | Chaque page dit **« le serveur ne répond pas »** + bouton Réessayer | ☐ |
| F2 | Relancer le backend, cliquer Réessayer | Les données reviennent sans recharger | ☐ |
| F3 | Créer un compte, changer son rôle, le supprimer, puis ouvrir le Journal | **Trois lignes** avec ton nom et ce qui a changé | ☐ |
| F4 | Régénérer le jeton d'un site, revenir au Journal | Une ligne de plus — **sans** le jeton lui-même | ☐ |

**F1 est le test le plus important de la fiche.** Une page qui annoncerait
« tout le parc répond » alors que le serveur est éteint serait le pire défaut
possible pour ce produit : un outil de supervision qui rassure à tort est pire
qu'inutile.

---

# Ce que tu diras à 16h30

Remplace les X par tes chiffres de **B4**.

> La plateforme est fonctionnelle. Elle a découvert **47 équipements** sur le
> réseau sans aucune saisie manuelle, identifie le fabricant de **X %** d'entre
> eux et le type de **Y %**. Les imprimantes sont correctement classées, les
> postes aussi.
>
> Un audit complet a été mené hier et aujourd'hui : **cinq défauts trouvés et
> corrigés**, chacun mesuré avant correction. Le plus grave laissait
> **111 machines surveillées par personne** sans qu'aucune alerte ne le
> signale — et le contrôle automatique censé l'attraper validait cet état.
>
> Les cases vides sont volontaires : la plateforme refuse d'afficher une valeur
> qu'elle ne peut pas prouver. Un téléphone classé « routeur » parce que sa
> marque en fabrique serait pire qu'une case honnête.
>
> Il reste **quatre points ouverts**, documentés, dont aucun n'empêche une mise
> en service : la révocation immédiate des sessions, un réglage de proxy à faire
> au déploiement, les jetons d'agent stockés en clair, et une dépendance
> signalée dont la fonction vulnérable n'est jamais appelée.

**Pourquoi cette formulation tient :** elle annonce des limites. Un rapport qui
ne liste que des succès inspire moins confiance qu'un rapport qui sait où il en
est — et tu pourras répondre à la question suivante, quelle qu'elle soit.

---

## À me renvoyer

Les numéros en **KO** avec un mot sur ce que tu as vu. Les échecs
m'intéressent plus que les réussites, et « pas compris » est une réponse
valable — ça veut dire que la fiche est mal écrite, pas toi.

**Gel du code à 15h30.** Passé cette heure, on ne touche plus à rien : une
plateforme qu'on modifie encore à 16h n'est pas prête, même si le code est
meilleur.
