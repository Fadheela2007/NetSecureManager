# Test général, module par module

**NetSecureManager — 9 septembre 2026.** Compte 1 h 30 pour tout.
Adapté à **ton réseau** : 90 équipements, 7 imprimantes, aucun commutateur
administrable, pas de DNS inverse.

> Chaque module dit **ce qu'il fait** (pour que tu puisses l'expliquer),
> **comment le tester**, **ce que tu dois voir**, et **ce qui est normal chez
> toi même si ça ressemble à un défaut**.

---

## Préparation

```powershell
# Fenêtre 1 — backend, à laisser ouverte
cd C:\Users\LENOVO\Documents\NetSecureManager\backend
npm start

# Fenêtre 2 — recompiler l'interface (indispensable)
cd C:\Users\LENOVO\Documents\NetSecureManager\frontend
npm run build
```

Puis **Ctrl + Maj + R** dans le navigateur.

---

# 1. Découverte du parc

**Ce qu'il fait.** Trouve tout ce qui est branché sur une plage réseau, sans
aucune saisie. Quatre techniques se complètent : ping, table ARP, sonde SNMP,
et nmap en dernier recours.

**Test.** Tableau de bord → **Détecter mes réseaux** → cliquer la plage
proposée → **Scanner cette plage**.

**Attendu.** Un compteur de durée apparaît sous le bouton. À la fin, une liste
avec adresse IP, nom, fabricant, type.

**Normal chez toi.** Le scan dure une dizaine de minutes : ton réglage
`SCAN_CONCURRENCE=3` analyse trois machines à la fois, pour rester discrète sur
le réseau de l'entreprise. Un `/23` prend le double d'un `/24`.

**Test du garde-fou.** Saisir `10.0.0.0/8` → refus immédiat, message clair,
serveur toujours vivant. ☐

---

# 2. Identification

**Ce qu'il fait.** Trouver une adresse IP ne suffit pas. Trois questions : le
**nom** (SNMP, DNS inverse, NetBIOS, mDNS), le **fabricant** (adresse
matérielle, registre IEEE de 39 911 préfixes), le **type** (texte SNMP, port
révélateur, nmap, marque).

**Test.**
```powershell
node tools\couverture.js
```

**Attendu.** Les pourcentages, puis **quelle méthode a trouvé quoi**. Note ces
chiffres : ils vont dans ton rapport.

**Normal chez toi.**
- Beaucoup de **noms vides** : leur serveur DHCP n'enregistre pas ses baux dans
  le DNS. Zéro sur douze en DNS inverse. C'est leur réseau, pas ta plateforme —
  et c'est une remarque à faire à ton encadreur.
- Beaucoup de **types « inconnu »** : un appareil sans SNMP, sans port
  révélateur et sans signature nmap ne donne aucun signal. Le produit refuse de
  deviner.
- Des **fabricants manquants** : les téléphones changent volontairement
  d'adresse matérielle à chaque réseau. ☐

---

# 3. Supervision continue

**Ce qu'il fait.** Interroge chaque équipement toutes les 5 minutes, enregistre
un relevé, décide s'il faut alerter. Deux garde-fous : trois échecs consécutifs
avant de déclarer une panne, et dédoublonnage des alertes.

**Test.**
```powershell
node tools\diagnostic-supervision.js
```

**Attendu.** Site 1 en **CYCLE CENTRAL**, des relevés récents (moins de 10 min).

**C'est le verrou.** Si ce test échoue, arrête-toi : les modules 4, 6 et 9 en
dépendent tous, et tu croirais à dix défauts là où il n'y en a qu'un. ☐

---

# 4. Alertes et incidents

**Ce qu'il fait.** Une **alerte** est un fait technique. Un **incident** est une
alerte qu'on a décidé de traiter — titre, responsable, statut. Le passage est
automatique au-delà d'un niveau de criticité.

**Test.**
```powershell
node tools\diagnostic-alertes.js
```
Puis page **Alertes** : acquitter une alerte, vérifier qu'elle sort de la liste.

**Attendu.** **0 fantôme.** Les alertes restantes concernent des machines qui
avaient répondu avant de disparaître.

**Normal chez toi.** Des alertes sur des portables et des téléphones partis du
réseau : elles sont exactes, la machine n'est pas en panne, elle est partie.
Une machine marquée « FAUSSE » qui répond à 87 ms est une carte Wi-Fi qui
sortait de veille — le cycle suivant referme l'alerte. ☐

---

# 5. Notifications par courriel

**Ce qu'il fait.** Envoie les alertes et les rapports par courriel. TLS exigé
depuis l'audit : plutôt échouer que partir en clair.

**Test.** Page Tableau de bord → **Export PDF**, puis un envoi manuel de rapport
si ton compte est administrateur global.

**Attendu.** Le PDF se télécharge. Pour le courriel, vérifier la boîte de
réception.

**Si rien n'arrive** : regarde la fenêtre du backend, le message dit pourquoi
(SMTP injoignable, identifiants refusés). Ce n'est pas silencieux. ☐

---

# 6. Bande passante

**Ce qu'il fait.** Mesure le débit par SNMP directement, ou — pour les machines
qui n'exposent rien — via le compteur du **port de commutateur** sur lequel
elles sont branchées.

**Test.** Page **Bande passante**. Regarder le bloc « Débit du parc dans le
temps », puis comparer le total au classement en dessous.

**Attendu.** Une courbe. Le total est **supérieur ou égal** à la plus grosse
ligne du classement.

**Normal chez toi.**
- « Aucune mesure » au début : le débit se calcule par **différence entre deux
  relevés**, il faut deux cycles, soit 10 minutes.
- **Toutes les machines n'y sont pas** : seules celles qui exposent un
  compteur, environ une sur dix. Le produit refuse d'attribuer un débit quand
  plusieurs machines partagent un port de commutateur.
- **Pas de courbe processeur** : tes appareils SNMP sont des imprimantes, et la
  table de charge processeur est facultative dans la norme. Vérifié appareil
  par appareil. ☐

---

# 7. Multi-sites et agents distants

**Ce qu'il fait.** Le serveur central ne peut pas atteindre le réseau d'une
agence distante. Un agent installé sur place scanne localement et transmet,
authentifié par un jeton propre au site.

**Test sans installer d'agent.** Page **Sites** → un site → **Mise en service**.

**Attendu.** Le jeton, l'état de la remontée, et les commandes d'installation
**prêtes à coller**, avec le jeton déjà inséré.

**Puis :** clique **Régénérer le jeton**. Un avertissement doit dire que
l'ancien est révoqué. Va ensuite au Journal : la ligne doit y être, **sans le
jeton lui-même**.

**Normal chez toi.** Aucun agent n'a jamais transmis — tes deux sites sont
supervisés par le cycle central. C'est cohérent. ☐

---

# 8. Contrôle d'accès web

**Ce qu'il fait.** Bloque des catégories de sites, via le résolveur DNS du site
piloté par l'agent. Le serveur compile la liste, l'agent l'applique et
**confirme ce qu'il a réellement installé**.

**Test.**
```powershell
node tools\importer-listes-web.js    # si les catégories sont vides
```
Page **Accès web** → créer une politique → cocher deux ou trois catégories →
enregistrer → **Aperçu**.

**Attendu.** L'aperçu montre **exactement** les domaines qui seraient bloqués,
avant toute activation. C'est la fonction la plus convaincante de cette page.

**Ce qui n'est pas testable aujourd'hui, et il faut le dire :** le blocage réel
exige **dnsmasq sur une machine Linux**, plus le DHCP du site distribuant
l'agent comme serveur DNS, plus des règles anti-contournement sur le routeur.
Sans la deuxième condition rien n'est bloqué ; sans la troisième tout se
contourne. **C'est une condition d'installation documentée, pas une fonction
manquante.**

**Ce que ce module ne fait pas, délibérément :** aucun historique de navigation
ne remonte. Seulement des compteurs par site, par jour et par catégorie — la
donnée nominative n'existe pas en base. C'est un argument de vente, pas une
limitation. ☐

---

# 9. Rapports et disponibilité

**Ce qu'il fait.** Taux de disponibilité sur 30 jours, exports PDF et Excel, et
envoi planifié par courriel. C'est la partie que ton client montre à sa
direction.

**Test.** Tableau de bord → **Export PDF**, puis **Export Excel**.

**Attendu.** Deux fichiers qui s'ouvrent, avec les mêmes chiffres. Les deux
formats partagent la même collecte : ils ne peuvent pas se contredire. ☐

---

# 10. Cartographie réseau

**Ce qu'il fait.** Montre quelle machine est branchée sur quel port de
commutateur, lu dans la table d'adresses des commutateurs eux-mêmes.

**Test.** Page **Topologie**.

**Attendu chez toi :** le titre, puis un encart expliquant que **les 90
équipements sont inventoriés et supervisés, mais que leur emplacement physique
reste inconnu** faute de commutateur administrable.

**Ce n'est pas un défaut.** Ton parc ne contient aucun routeur ni commutateur
administrable — l'information n'existe nulle part sur ce réseau. La page refuse
d'inventer un schéma. Si tu vois une page **littéralement blanche**, sans même
le titre, c'est autre chose : signale-le. ☐

---

# 11. Utilisateurs, rôles et cloisonnement

**Ce qu'il fait.** Trois rôles (admin, opérateur, lecteur) et une portée par
site — **deux axes indépendants**. Un admin rattaché au site 2 est
administrateur du site 2, pas de la plateforme.

**Test.** Page **Utilisateurs** → créer un compte opérateur → changer son rôle →
le supprimer.

**Attendu.** Les trois actions fonctionnent, et **le Journal montre les trois
lignes** avec ton nom et ce qui a changé (« rôle → operateur », pas « compte
modifié »).

**Test du garde-fou.** Essaie de supprimer le dernier administrateur global :
refus explicite. ☐

---

# 12. Journal d'activité

**Ce qu'il fait.** Enregistre qui a fait quoi. Sa vraie utilité : répondre
« qui a régénéré ce jeton » six mois plus tard, quand un site ne remonte plus.

**Test.** Après les modules 7 et 11, ouvrir la page **Journal**.

**Attendu.** Les créations et suppressions de comptes, la régénération de
jeton, les changements de réglage, les scans lancés. Avec ton nom et l'heure.

**Ce module ne traçait rien de tout cela avant l'audit** — c'est une des cinq
corrections d'aujourd'hui, et une de celles qu'un acheteur vérifie en premier. ☐

---

# 13. Réinitialisation

**Ce qu'il fait.** Vide la plateforme pour repartir propre après une phase
d'essai.

**Test — ne pas exécuter avant ta réunion.** Ouvre l'écran, vérifie qu'il
demande une **phrase de confirmation**, qu'il affiche les **volumes réels** qui
seraient effacés, et qu'un administrateur rattaché à un site ne peut pas vider
le journal global.

**Regarde, ne clique pas.** Tu as déjà perdu ton parc une fois hier avec cet
écran — il fonctionne, c'est prouvé. ☐

---

# 14. L'interface elle-même

**Ce qu'il fait.** Trois états sur chaque écran : les données, le vide expliqué,
et l'erreur. Plus un rafraîchissement automatique.

**Test A — l'interface bouge seule.** Laisse la page Alertes ouverte et lance
un scan ailleurs. Elle doit se mettre à jour **sans que tu la recharges**.

**Test B — les colonnes tiennent.** Page Équipements, fais défiler : les titres
restent visibles sur fond opaque.

**Test C — les deux thèmes.** Bascule clair / sombre : tout reste lisible.

**Test D — le plus important de toute la fiche.** Arrête le backend (Ctrl+C) et
parcours les pages. **Chaque page doit dire « le serveur ne répond pas »** avec
un bouton Réessayer.

> Une page qui annoncerait « tout le parc répond » alors que le serveur est
> éteint serait le pire défaut possible pour ce produit : un outil de
> supervision qui rassure à tort est pire qu'inutile.

Relance le backend, clique **Réessayer** : les données reviennent sans
rechargement. ☐

---

## Grille à me renvoyer

| Module | OK / KO | Ce que tu as vu |
|---|---|---|
| 1 Découverte | | |
| 2 Identification | | |
| 3 Supervision | | |
| 4 Alertes | | |
| 5 Notifications | | |
| 6 Bande passante | | |
| 7 Multi-sites | | |
| 8 Accès web | | |
| 9 Rapports | | |
| 10 Cartographie | | |
| 11 Utilisateurs | | |
| 12 Journal | | |
| 13 Réinitialisation | | |
| **14 Interface** | | |

Les KO m'intéressent plus que les OK. « Pas compris » est une réponse valable :
ça veut dire que la fiche est mal écrite, pas toi.

**Gel du code à 15h30.**
