# État du projet — NetSecureManager
**Mis à jour le 14 septembre 2026.**

Ce document remplace treize fichiers qui disaient chacun une partie de la même chose, à des
dates différentes. Il n'en existe plus qu'un : celui-ci. La liste de ce qu'il remplace est à
la fin.

---

## En une page

**Ce que c'est.** Une plateforme de supervision réseau multi-sites : elle découvre les
équipements d'un réseau d'entreprise, surveille leur état en continu, alerte quand quelque
chose tombe, et le justifie. Serveur central en Node/Express + MySQL, interface React, agents
déployables sur les sites distants et sur les postes.

**Où elle en est.** Fonctionnelle et testée sur un réseau d'entreprise réel : 2 sites,
111 équipements découverts au siège, supervision toutes les 5 minutes. Deux audits complets
(8 et 14 septembre) n'ont trouvé ni injection SQL, ni XSS, ni injection de commande, ni secret
en dur.

**Ce qui la distingue.** Chaque équipement inscrit à l'inventaire porte sa **preuve
d'existence** — « refus de connexion sur le port 445, le 9 septembre à 13h42 ». Zabbix, Nagios,
Centreon et Checkmk montrent un hôte et son état ; aucun ne dit pourquoi cet hôte figure dans la
liste. C'est par là qu'entrent les adresses fantômes, et c'est l'argument le plus solide du
produit.

**Ce qui reste.** Rien qui empêche de montrer le produit. Une décision d'architecture
(révocation des jetons), un réglage de déploiement (`trust proxy`), et une liste de confort.

---

## 1. Ce qui est livré, et vérifié

**Découverte du parc.** Ping, table ARP, sonde SNMP v2c et v3, scan de 19 ports, nmap en
dernier recours. Chaque machine inscrite a donné au moins un signe de vie — une adresse vue
dans le seul cache ARP n'entre pas à l'inventaire.

**Identification.** Nom (SNMP, puis DNS inverse, puis NetBIOS, puis mDNS), fabricant par
registre OUI (39 911 préfixes), type par vocabulaire fermé. Chaque valeur porte la règle qui l'a
décidée. Le registre OUI a fait passer l'identification de ~23 % à **96 %** des équipements sur
le test en entreprise.

**Supervision continue.** Ping périodique, relevé SNMP, seuils de charge avec hystérésis.
Quatre protections contre les fausses alertes : seuil d'échecs consécutifs, preuve contraire
cherchée avant d'alerter (un port TCP qui répond = la machine marche), « jamais vu » traité
comme « inconnu » et non « en panne », et valeur haute permanente reconnue comme le
fonctionnement normal d'une machine.

**Alertes et incidents.** Dédoublonnage avec compteur d'occurrences, acquittement, escalade en
incident filtrée par criticité, assignation à une personne.

**Multi-sites.** Agent par site avec son propre jeton, détection d'agent muet, et surtout :
**c'est l'agent qui déclare le statut**, pas le serveur — lui seul sait distinguer « j'ai sondé
et ça n'a pas répondu » de « je n'ai pas regardé ».

**Bande passante.** Mesure SNMP directe, complétée par l'attribution port-de-switch → machine
(BRIDGE-MIB), qui couvre les neuf machines sur dix n'exposant aucun compteur. Total du parc et
courbe dans le temps ; les équipements de transit sont exclus du total pour ne pas compter deux
fois.

**Contrôle des accès web.** Blocage DNS par catégories et règles manuelles, règles de pare-feu
fournies pour empêcher le contournement. Les statistiques sont agrégées par (site, jour,
catégorie) : ni IP, ni domaine, ni utilisateur — **ces colonnes n'existent pas en base**.

**Observation DNS** *(14/09)*. Les domaines contactés par machine, agrégés sur l'agent avant
envoi. Activation réservée aux administrateurs, tracée et datée. Purge automatique au-delà de la
rétention configurée (90 jours à défaut).

**Certificats TLS et failles connues** *(10/09)*. Ce qui expire, ce qui est auto-signé, ce qui
accepte encore du TLS ancien. Rapprochement des versions lues avec le NVD, qui dit « 3 failles
publiées, à vérifier » et jamais « cette machine est vulnérable ».

**Intérieur des machines** *(14/09)*. Programmes en cours et logiciels installés, lus par SNMP
pendant le scan, sans rien installer. Ne couvre que les machines qui répondent en SNMP ; un
poste Windows ordinaire demande l'agent de poste.

**Sécurité.** Authentification JWT, trois rôles appliqués côté serveur, cloisonnement par site
sur toutes les écritures et les lectures sensibles, 404 plutôt que 403 hors périmètre,
limitation des tentatives de connexion, journal d'activité, écran de réinitialisation à cinq
garde-fous.

**Rapports.** PDF et Excel, avec une feuille « Méthode » qui dit comment le taux de
disponibilité est calculé **et quelles sont ses limites**.

---

## 2. Ce qui reste ouvert

### En attente d'une décision de ta part

| Sujet | La question | Ce qui est recommandé |
|---|---|---|
| **Révocation des jetons** | Un compte rétrogradé ou supprimé garde ses droits jusqu'à 8 h. | Un compteur `UTILISATEUR.version_jeton` dans le jeton, comparé à chaque requête. Touche à l'authentification : à faire avec la base sous la main. |
| **`trust proxy`** | Derrière nginx, tous les utilisateurs partagent une adresse IP : la limitation de connexion protège tout le monde ou personne. | `app.set("trust proxy", 1)` s'il y a exactement un proxy devant. À fixer au moment de l'architecture de déploiement, pas avant. |
| **Messages d'erreur internes** | Onze réponses HTTP 500 renvoient le message d'erreur MySQL au client. | Correctif prêt, six fichiers. À lancer quand tu veux. |

### Par valeur décroissante

1. **Péremption du cache d'OS.** Sur un VLAN routé, aucune adresse MAC n'est visible depuis le
   serveur : le cache ne s'applique jamais et chaque rescan repaye nmap en entier. C'est le
   levier restant sur la durée du scan.
2. **Limitation de débit** sur `/api/agent/*` et les routes de scan (`express-rate-limit`,
   une dizaine de lignes).
3. **`crypto.timingSafeEqual`** sur la comparaison des jetons d'agent (dix lignes), puis, si
   décidé, stocker une empreinte plutôt que le jeton en clair.
4. **Grouper les écritures du push d'agent.** Une requête SQL par équipement, par relevé et par
   interface : plus de 1 500 allers-retours pour un site de 500 machines. Pas un problème à
   l'échelle actuelle ; c'est la limite de montée en charge à connaître avant de promettre un
   gros parc.
5. **Filtrer le menu latéral par rôle** — un lecteur voit « Utilisateurs » et « Configuration »
   et obtient un refus en cliquant.
6. **Index sur `RELEVE.date_releve`** — les écrans de bande passante à l'échelle du parc ne
   peuvent pas utiliser l'index actuel.
7. **Découper `routes/scan.js`** (2 300 lignes) et supprimer `frontend/src/api.js`.

### Fonctions prévues, non faites

- **Notifications WhatsApp.** Retirées volontairement : Meta n'autorise le texte libre que
  pendant 24 h après qu'une personne a écrit au numéro de l'entreprise. Une alerte part à trois
  heures du matin sans que personne n'ait rien écrit — c'est exactement le cas interdit. Le
  rétablir demande un compte Meta Business vérifié et un modèle « Utility » approuvé.
- **Interface pour régler la fréquence des rapports planifiés** (aujourd'hui en base).
- **Débit multi-interfaces sur les commutateurs.**
- **Catégorie « mobile »** pour les téléphones, aujourd'hui classés « inconnu ».
- **Aucun test automatisé côté interface** (32 fichiers de tests côté serveur).

### Un point technique encore ouvert : le sujet T5

Lors de la campagne de test du 24 août, trois machines sont ressorties classées « Windows » avec
un fabricant HP et une certitude nmap de 95-97 %. Deux explications restent possibles, et elles
appellent des réponses opposées :

- **A — la règle des ports a tranché.** Les ports 9100, 515 et 631 donnent « imprimante » et
  passent avant nmap. Une machine Windows qui partage une imprimante ouvre le port 9100 : elle
  serait classée imprimante à tort.
- **B — nmap se trompe, et la plateforme a raison.** Les serveurs d'impression embarqués HP
  (JetDirect) ont une pile réseau que nmap identifie comme « Microsoft Windows » avec une
  certitude élevée. Ce sont alors de **vraies imprimantes**.

L'ordre de décision a été vérifié : le fabricant est déjà consulté en dernier, et « HP »,
« Hewlett Packard » et « Aruba » ne sont associés à aucun type. Trancher demande de regarder,
sur ces machines précises, tous les signaux disponibles et la règle qui a décidé — la colonne
`type_source` existe pour ça.

---

## 3. Ce qui a été réglé, et qu'il est inutile de rouvrir

Ces points reviennent régulièrement dans les anciens documents. Ils sont **corrigés** :

- Création de compte administrateur ouverte à tous → `/register` ne répond que si la table des
  comptes est vide, et le rôle n'est plus lu depuis la requête.
- CORS ouvert à toutes les origines → liste blanche `FRONTEND_URL`.
- Aucune limitation sur les tentatives de connexion → blocage par adresse, ralentissement
  progressif par compte, empreinte factice contre l'énumération par chronométrage.
- Secret JWT de repli écrit dans le code → supprimé, le démarrage échoue sans `JWT_SECRET`.
- Mot de passe SMTP pouvant partir en clair → `requireTLS: true`.
- Cloisonnement contourné sur le contrôle d'accès web → corrigé sur les trois routes.
- Le journal d'activité aveugle sur l'essentiel → création, modification et suppression de
  compte, rotation de jeton, changement de seuil, activation de politique : tout est tracé.
- La dépendance `ip`, signalée « haute » sans correctif publié → remplacée par
  `services/adressesIp.js`, équivalence vérifiée sur 1 089 676 comparaisons.
- **Les quatre tables inexploitées** → il n'y en a plus. Les 23 tables du schéma sont toutes
  lues ou écrites par le code (vérifié le 14/09).
- Le total de bande passante qui était une moyenne → somme des moyennes par équipement.
- Un site déclaré « agent local » sans agent, supervisé par personne en silence → réglage
  explicite `supervision_par_agent` + avertissement au démarrage.
- L'en-tête du tableau Équipements invisible → fond posé sur les cellules et non sur `<thead>`.
- Le blocage web qui ne s'appliquait pas → résolveur DNS par site, retour d'état de l'agent.

---

## 4. Où trouver quoi

| Question | Document |
|---|---|
| Comment j'installe et je démarre ? | `README.md` |
| Comment ça marche, pour un responsable informatique ? | `ARCHITECTURE-EXPLIQUEE.md` |
| Comment le scan trouve les machines ? | `LE-SCAN-EXPLIQUE.md` |
| Je montre le produit à un client | `DEMONSTRATION-20-MINUTES.md` |
| Je le montre à des techniciens qui vont chercher la faille | `PREPARATION-TEST-TECHNIQUE.md` |
| Je veux tout tester, point par point | `TESTER-LA-PLATEFORME.md` |
| Je veux tester un module précis | `TEST-PAR-MODULE.md` |
| J'installe un agent sur un site distant | `INSTALLATION_SITE_DISTANT.md` |
| J'installe l'agent sur un poste | `INSTALLER-AGENT-POSTE.md` |
| Je déploie l'agent sur tout un parc Windows | `DEPLOYER-PAR-GPO.md` |
| Qu'a trouvé le dernier audit ? | `AUDIT-COMPLET-2026-09-14.md` |
| Qu'avait trouvé le précédent, et qu'a-t-on corrigé ? | `AUDIT-COMPLET-2026-09-08.md` |
| Le rapport pour l'encadreur de stage | `RAPPORT-ENCADREUR.md` |
| Où en est le projet ? | **ce document** |

---

## 5. Ce que ce document remplace

Ces treize fichiers disaient tous, à des dates différentes, une partie de ce qui est écrit
ci-dessus. Leur contenu encore valable a été repris ; le reste était dépassé.

| Fichier | Pourquoi il n'a plus lieu d'être |
|---|---|
| `A-FAIRE.md` | mode d'emploi d'étapes toutes réalisées (migrations passées, blocage web en service) |
| `OU-EN-EST-LE-PROJET.md` | état au 8 septembre, remplacé par l'audit du 14 |
| `OU-EN-SUIS-JE.md` | mise en service du blocage web, terminée |
| `RESTE_A_FAIRE_revu.md` | relecture d'audit du 8 août — tous ses points rouges sont corrigés |
| `VALIDATION-FINALE.md` | protocole d'une journée de test précise, passée |
| `RAPPORT-SEMAINE-2026-08-28.md` | journal de travail d'une semaine d'août |
| `SUITE-DES-TESTS.md` | réponses à la campagne du 24 août ; T7 corrigé, T5 repris ci-dessus |
| `FICHE-TEST.md` | grille courte, doublon de `TEST-PAR-MODULE.md` |
| `RAPPORT_TABLES_INEXPLOITEES.md` | son constat ne tient plus : aucune table n'est inexploitée |
| `RAPPORT_AUDIT.md` | audit du 8 août, remplacé deux fois depuis |
| `RAPPORT_ALIGNEMENT_SCHEMA.md`, `RAPPORT_DISPONIBILITE.md`, `RAPPORT_FIABILITE.md`, `RAPPORT_GESTION_UTILISATEURS.md`, `RAPPORT_OUI_FABRICANT.md`, `RAPPORT_RAPPORTS_PLANIFIES.md`, `RAPPORT_RELEVES_AGENT.md`, `RAPPORT_SEUILS_PERFORMANCE.md`, `RAPPORT_SUPERVISION_DISTANTE.md`, `RAPPORT_THEME_MOBILE.md`, `RAPPORT_TYPES_COHERENTS.md`, `RAPPORT-bande-passante.md` | rapports écrits fonction par fonction en août, au moment où chacune était construite. Ce qu'ils décrivent est en service et documenté ci-dessus ; ce qu'ils annonçaient comme à faire est fait. |
| `CLAUDE.md` | fichier vide depuis mai |
