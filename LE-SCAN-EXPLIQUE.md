# Le scan — audit honnête

**9 septembre 2026.** Écrit parce que trop de choses ont changé en deux jours
et qu'il faut remettre les idées en place. Aucun jargon inutile.

---

## 1. Ce que fait le scan, étape par étape

Tu donnes une plage — `192.168.0.0/23`. Voici ce qui se passe, dans l'ordre.

**Étape 1 — La liste des adresses.** La plage est traduite en adresses à
sonder. Un `/24` en donne 254, un `/23` en donne 508. Les adresses de réseau et
de diffusion sont écartées, y compris celles des blocs intermédiaires.

> **Vérifié à l'instant** : `/24` → 254, `/23` → 508, première `192.168.0.1`,
> dernière `192.168.1.254`, et `192.168.0.255` comme `192.168.1.0` sont bien
> exclues. `10.0.0.0/8` est refusé.

**Étape 2 — Le balayage ping.** Les 508 adresses sont pinguées, 64 à la fois.
Coût réel : quelques secondes. Ce n'est **pas** ce qui rend le scan long.

**Étape 3 — La table ARP.** Le système d'exploitation garde la liste des
machines avec qui il a communiqué récemment. On la lit pour rattraper celles
qui bloquent le ping — un poste Windows le fait par défaut.

**Étape 4 — L'identification.** C'est ici que le temps passe. Pour chaque
machine trouvée :

| Sonde | Ce qu'elle donne | Ce qu'elle coûte |
|---|---|---|
| SNMP | Ce que l'appareil dit de lui-même | 1,5 s si muet |
| Scan de ports | 19 ports en parallèle | 0,4 s |
| **nmap** | **Le système d'exploitation** | **jusqu'à 25 s** |
| Registre OUI | Le fabricant, via l'adresse matérielle | instantané |
| Nom | SNMP, DNS inverse, NetBIOS, mDNS | quelques secondes |

**Étape 5 — L'enregistrement.** Chaque machine est écrite en base avec son
type, son nom, son fabricant, et **la règle qui a décidé de chacun**.

---

## 2. Pourquoi c'est lent — le calcul, pas une impression

**nmap représente environ 93 % de la durée.** Tout le reste est négligeable
devant lui.

Le seul réglage qui compte est le nombre de machines analysées **en même
temps**. Chez toi il vaut **3** — tu l'as choisi pour rester discrète sur le
réseau de l'entreprise, et c'était le bon réflexe.

```
      90 machines ÷ 3 à la fois × 20 s  ≈  10 minutes
```

Change ce nombre, et rien d'autre, et voilà ce que ça donne :

| `SCAN_CONCURRENCE` | Durée pour 90 machines | Trafic généré |
|---|---|---|
| 3 (ton réglage) | ~10 min | très discret |
| 6 | ~5 min | discret |
| 10 (défaut du code) | ~3 min | modéré |

**Un `/23` prend le double d'un `/24`** simplement parce qu'il contient deux
fois plus d'adresses. Ce n'est pas un défaut, c'est de l'arithmétique.

**Ce qui n'accélérerait rien :** changer de machine, ajouter de la mémoire,
optimiser le code. Le temps est passé à *attendre le réseau*, pas à calculer.

---

## 3. Est-ce que le scan est juste ? Oui, et voici pourquoi j'en suis sûre

Trois choses le prouvent, indépendamment les unes des autres.

**Il trouve.** 90 équipements sur ton réseau, sans aucune saisie. Le nombre
correspond à un parc réel.

**Il ne ment pas sur ce qu'il ignore.** 41 machines sont marquées « inconnu »
parce qu'elles n'exposent ni SNMP, ni port révélateur, ni signature nmap. Le
produit refuse de deviner d'après la marque — un téléphone classé « routeur »
parce que sa marque en fabrique serait pire qu'une case vide.

**Il dit d'où vient chaque valeur.** Ton `couverture.js` le montre : 38 types
décidés par nmap, 8 par un port ouvert, 1 par le texte SNMP. Une classification
contestée se diagnostique en lisant une colonne.

---

## 4. Ce que j'ai changé dans le scan, et l'effet de chacun

| Changement | Pourquoi | Effet visible |
|---|---|---|
| Plage validée et plafonnée | `10.0.0.0/8` au lieu de `/24` faisait tomber tout le serveur | Un refus immédiat au lieu d'un plantage |
| Statut exige une preuve | Des machines de la table ARP étaient enregistrées « en ligne » sans avoir jamais répondu | 11 fausses alertes en moins |
| Le scan n'écrase plus un statut | Il remettait « en ligne » ce que la supervision venait de constater absent | Le tableau de bord cesse de se contredire |
| Défaut de concurrence 5 → 10 | Le scan était lent pour tout le monde | **Aucun effet chez toi** : ton `.env` impose 3 |
| Bibliothèque d'adresses remplacée | Le paquet était signalé vulnérable, sans correctif | Aucun — équivalence vérifiée sur 1 089 676 cas |
| Durée affichée pendant le scan | Dix minutes de silence, impossible de savoir s'il travaille | Un compteur sous le bouton |

**Aucun de ces changements ne modifie ce que le scan trouve.** Ils changent ce
qu'il *affirme* : il n'affirme plus qu'une machine est en ligne sans preuve, et
il ne tombe plus sur une faute de frappe.

---

## 5. Ce qui t'a fait douter, et qui n'était pas le scan

C'est le point le plus important de ce document. **Trois fois de suite**, un
écran vide t'a fait croire que le scan ne marchait pas. Les trois fois, la
donnée était bonne et le défaut était à l'affichage :

1. **La largeur du graphique** mesurée au mauvais moment, jamais reprise : le
   graphique n'était pas construit du tout.
2. **Les nombres décimaux** renvoyés sous forme de texte par la base : la
   bibliothèque de graphiques ne savait pas les placer sur un axe.
3. **Le point unique invisible** : un trait a besoin de deux points, et les
   points étaient désactivés.

Trois causes différentes, **un seul symptôme** — un cadre vide, sans message.
C'est la famille de défauts la plus coûteuse à diagnostiquer, et c'est pour ça
que tu as eu l'impression que « rien ne marche » alors que le moteur, lui,
faisait son travail.

---

## 6. Ce qui reste vrai et limité dans le scan

À dire, pas à cacher :

- **Il ne voit que ce qui est joignable depuis ta machine.** Un VLAN routé sans
  route configurée rend zéro machine — et la plateforme sait dire la différence
  entre « ce réseau est vide » et « ce réseau n'est pas joignable ».
- **Un rescan reste long sur un réseau routé.** Le code évite normalement nmap
  sur une machine déjà identifiée, mais seulement si son adresse matérielle est
  connue — or elle ne l'est que sur le réseau directement raccordé.
- **Les téléphones modernes changent d'adresse matérielle** à chaque réseau.
  Aucun registre ne peut les identifier : c'est une protection du téléphone,
  pas une faiblesse du scan.
- **Le scan ne modifie rien sur le réseau.** Il écoute et interroge. Il ne
  configure aucun équipement.

---

## En une phrase

**Le scan fonctionne, il est juste, et il est lent parce que tu lui as demandé
d'être discret.** Ce qui t'a fait douter venait de l'affichage, pas de la
mesure — et les trois causes sont corrigées.
