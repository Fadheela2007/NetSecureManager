# Consommation de bande passante par équipement

**Point 2 des six travaux — terminé côté code, migration à exécuter.**

---

## Le défaut qui rendait la fonction inutilisable

Les compteurs SNMP étaient déjà collectés. Mais le débit d'un équipement
était calculé sur `interfaces[0]` — la première interface renvoyée par
l'agent.

Sur un switch 24 ports, la « consommation de l'équipement » était donc
celle du port 1. Un switch saturé sur le port 12 apparaissait au repos.
C'est le genre de défaut qui ne se voit pas en démonstration et qui se
paie en crédibilité au premier client qui connaît son réseau.

Second défaut, plus discret : le cache des compteurs précédents était
indexé par équipement. Deux interfaces du même switch écrasaient donc
mutuellement leur compteur, et la différence se faisait entre deux
interfaces différentes. Le chiffre obtenu était sans aucun rapport avec le
réel — mais plausible.

---

## Ce qui a été fait

### 1. Un service unique de calcul du débit

`backend/src/services/traficService.js` (nouveau) remplace deux
implémentations divergentes — une dans le cycle central, une dans l'agent.

| Traitement | Comportement |
|---|---|
| Cache des compteurs | Indexé par **(équipement, interface)**, plus par équipement |
| Portée du calcul | **Toutes** les interfaces, plus seulement la première |
| Delta négatif | Non mesuré (débordement de compteur 32 bits ou redémarrage) |
| Premier relevé | `NULL`, jamais `0` |
| Boucle locale | Mesurée, mais **exclue du total** |
| Taux d'utilisation | `max(entrant, sortant) ÷ vitesse du lien`, plafonné à 100 % |

### 2. Collecte de la vitesse du lien

`ifSpeed` (OID `1.3.6.1.2.1.2.2.1.5`) est désormais relevé et converti en
Mbit/s.

C'est l'ajout le plus important de tout le lot. « 50 000 kbit/s » ne veut
rien dire dans l'absolu : c'est 5 % d'un lien gigabit — donc rien — et
500 % d'un lien 10 Mbit/s — donc une saturation totale. Sans cette
donnée, la plateforme affichait des chiffres que personne ne pouvait
interpréter.

La valeur de saturation `4294967295` (liens > 4 Gbit/s, qui exigeraient
`ifHighSpeed`) est ignorée plutôt que prise pour argent comptant.

### 3. Stockage par port

`INTERFACE_RESEAU` reçoit `vitesse_mbps`, `trafic_entrant_kbps`,
`trafic_sortant_kbps` et `date_trafic`.

À la réception d'un push d'agent, ces colonnes sont mises à jour en
`COALESCE` et non en écrasement : un agent qui vient de redémarrer remonte
des débits `NULL`, ce qui viderait l'écran à chaque redémarrage. La
dernière mesure valide reste affichée, datée honnêtement par
`date_trafic`.

### 4. Deux routes

- `GET /api/bande-passante/classement?heures=&limite=` — les plus gros
  consommateurs. Le classement se fait sur la **moyenne** et non sur le
  pic : un pic isolé de sauvegarde ne doit pas masquer une machine qui
  sature le lien en permanence. Le pic est renvoyé à part, il répond à une
  autre question.
- `GET /api/equipements/:id/bande-passante?heures=` — historique de
  l'équipement + détail par port.

`GET /api/equipements/:id/interfaces` renvoie maintenant les colonnes de
débit, avec un repli silencieux tant que la migration n'est pas passée.
Son tri est passé de `nom` à `index_snmp` : en tri alphabétique,
« Gi0/10 » se plaçait entre « Gi0/1 » et « Gi0/2 ».

### 5. Écran « Bande passante »

Nouvelle entrée dans le menu. Classement, barre de proportion, sélection
d'un équipement pour dérouler son historique et le détail de ses ports.

Trois choix d'affichage qui méritent d'être signalés :

- **Le trou dans la courbe reste un trou** (`connectNulls={false}`).
  Relier les points masquerait une panne d'agent ou un équipement
  injoignable — exactement ce qu'on veut voir.
- **Le taux d'occupation par port** passe en ambre à 50 % et en rouge à
  80 %. C'est le seul chiffre lisible sans connaître le réseau.
- **Un bandeau annonce la couverture réelle** (« 4 équipements mesurés sur
  37 »). Sans lui, un classement court passe pour une panne alors qu'il
  traduit simplement l'absence de SNMP sur la majorité des postes.

### 6. Tests

`backend/tests/traficService.test.js` — **18 tests, tous au vert**
(`npm test` dans `backend/`).

Ils portent sur les cas où le calcul naïf se trompe *silencieusement* :

- débordement du compteur 32 bits (toutes les 34 s sur un gigabit chargé)
- redémarrage de l'équipement (compteurs à zéro)
- deux relevés au même instant (division par zéro)
- deux ports qui s'écrasent mutuellement
- boucle locale doublant la consommation d'un serveur
- `oublier("eq1")` ne doit pas emporter `eq12`
- taux d'utilisation : maximum et non somme, plafonné, `NULL` si vitesse inconnue

---

## À faire de votre côté

**1. Exécuter la migration** `backend/migrations/2026-08-18-bande-passante.sql`
dans MySQL Workbench. Six étapes, aucun `DROP`, chaque `ALTER` isolé pour
qu'une colonne déjà présente n'arrête pas le reste.

**2. Laisser tourner deux cycles de scan.** Le premier ne peut
mathématiquement rien mesurer — il n'y a pas de compteur précédent avec
quoi faire la différence. Un écran vide après un seul scan est normal.

**3. Vérifier le build** (`npm run build` dans `frontend/`). Je ne peux pas
le lancer ici : les `node_modules` du projet contiennent des binaires
compilés pour Windows, et mon environnement d'exécution est un Linux
isolé. J'ai contrôlé la syntaxe et le JSX de tous les fichiers modifiés,
mais ce n'est pas la même chose qu'un build réussi — je préfère le dire
que le laisser croire.

---

## Deux limites assumées

**La somme des ports d'un switch n'est pas son débit de transit.** Une
trame entrée par le port 3 et sortie par le port 7 est comptée deux fois.
Le chiffre reste l'indicateur utile pour repérer un équipement qui charge
le réseau, mais l'interface le libelle explicitement (« cumul des ports »)
pour éviter qu'il soit surinterprété devant un client.

**Pas d'historique par port.** `INTERFACE_RESEAU` ne garde que la dernière
mesure. Historiser chaque port multiplierait le volume par le nombre
d'interfaces : un seul switch 48 ports produirait 13 800 lignes par jour,
plus que 45 postes de travail réunis. Si le besoin se confirme, la bonne
réponse sera une table **agrégée** (moyenne horaire, purge à 90 jours),
pas une table de plus.

---

## Ce que je propose ensuite, sans que vous l'ayez demandé

Trois occasions d'améliorer la qualité perçue, par ordre de rapport
effet/effort :

1. **Une alerte de saturation de lien.** Le taux d'utilisation est
   maintenant calculé ; il ne manque qu'un seuil et l'hystérésis déjà en
   place ailleurs (déclenche à 90 %, ne résout qu'en dessous de 80 %).
   « Le port 12 du switch principal est à 94 % depuis 20 minutes » est la
   phrase qui vend une plateforme de supervision. Une demi-journée.

2. **Une vignette « top 3 consommateurs » sur le tableau de bord.** Les
   données et la route existent déjà. Deux heures, visible dès la première
   minute d'une démonstration.

3. **Un jeu de données de démonstration.** Aujourd'hui, montrer cet écran
   suppose un parc SNMP réel sous la main. Un script qui injecte 48 h de
   relevés crédibles permettrait de faire la démonstration sur n'importe
   quel poste, hors ligne. C'est ce qui manque le plus pour une démo de
   20 minutes maîtrisée.

Restent en attente de votre décision : le **choix du logo** (A/B/C/D — ma
recommandation reste B en logo et D en favicon), qui bloque la refonte
visuelle, et l'**architecture du blocage DNS**, qui est un chantier
d'infrastructure et non applicatif.
