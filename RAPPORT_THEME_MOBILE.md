# Mode clair/sombre et adaptation mobile — rapport

**Date :** 12 août 2026
**Périmètre :** consigne 3. Aucune modification fonctionnelle, aucune requête backend touchée, aucune migration SQL.

**Vérifications :** frontend compile en 498 ms (22 fichiers), `oxlint` 0 erreur et 4 avertissements — les mêmes `exhaustive-deps` préexistants qu'avant cette session. Contrastes calculés sur les 32 paires texte/fond réellement utilisées.

---

## Trois bugs CSS préexistants trouvés en chemin

La consigne demandait de vérifier chaque page dans les deux thèmes. En le faisant, j'ai découvert que **trois éléments ne fonctionnaient déjà pas**, thème clair ou pas.

### 1. 🔴 La page de connexion référençait 10 variables inexistantes

`Login.css` utilisait `--panel`, `--border`, `--brass`, `--brass-dim`, `--text`, `--text-dim`, `--text-faint`, `--danger`, `--ink-900`, `--ink-950`. **Aucune n'a jamais été définie nulle part.**

Une variable CSS non définie ne déclenche aucune erreur : la propriété est simplement ignorée. La carte de connexion n'avait donc ni fond, ni bordure, et son texte prenait la couleur héritée. C'est la première page que voit un utilisateur.

**Corrigé** par des alias vers les jetons réels, valables dans les deux thèmes. Deux valeurs codées en dur ont aussi été rattachées au thème : le dégradé de fond, et surtout la couleur du texte du bouton (`#1a1405`, un brun sombre) qui serait devenu illisible sur le bleu foncé du thème clair.

### 2. Le formulaire de scan n'avait aucun style

`ScanLauncher.jsx` utilise les classes `.scan-launcher`, `.error`, `.success` — **aucune n'existait**. Le formulaire s'affichait en HTML brut au milieu du tableau de bord stylé.

**Corrigé** : styles ajoutés, alignés sur les cartes existantes, et empilement vertical sous 640 px.

### 3. `.pulse-dot` n'existait pas

`StatusDot` et `NetworkMark` appliquent cette classe pour faire clignoter les points de statut. Elle n'était définie nulle part : les points étaient statiques.

**Corrigé**, avec respect de `prefers-reduced-motion`.

### Et `App.css` n'était que du boilerplate Vite

`.hero`, `.counter`, `#next-steps`, `.ticks`… — aucune de ces classes n'apparaît dans le code de NetSecureManager, et elles référençaient elles aussi des variables inexistantes. Remplacé par ce qui sert réellement (tiroir mobile, cibles tactiles, conteneurs de graphiques).

---

## Le thème clair n'est pas une inversion

Vous insistiez sur ce point, et c'est là que se joue la lisibilité. Les couleurs de statut du thème sombre sont conçues pour briller sur du noir ; sur du blanc, elles s'effondrent.

| Rôle | Sombre | Clair | Ratio du sombre s'il avait été conservé |
|---|---|---|---|
| Alerte | `#f5b942` | `#8a5300` | **1,8:1** — illisible |
| En ligne | `#35c759` | `#157f3c` | 2,1:1 |
| Hors ligne | `#ff4d4d` | `#c02a26` | 3,1:1 |
| Accent | `#4da3ff` | `#0059c9` | 2,4:1 |

L'ambre est le cas le plus net : à 1,8:1 sur blanc, un message d'avertissement aurait été pratiquement invisible — précisément le type de message qu'il ne faut pas rater.

Autre choix : le fond de page clair est `#f4f6fa`, un gris très légèrement bleuté, et non du blanc pur. Moins d'éblouissement sur un écran de bureau, et les cartes blanches se détachent au lieu de se fondre.

---

## Contrastes — mesurés, pas estimés

J'ai calculé les ratios WCAG pour les 16 paires réellement utilisées, dans les deux thèmes.

| Paire | Sombre | Clair | Seuil |
|---|---|---|---|
| Texte principal / fond | 17,88:1 | 16,23:1 | 4,5 |
| Texte principal / carte | 16,61:1 | 17,56:1 | 4,5 |
| **Texte secondaire / fond** | **6,52:1** | **5,58:1** | 4,5 |
| **Texte secondaire / carte** | **6,05:1** | **6,03:1** | 4,5 |
| **Texte secondaire / champ** | **5,54:1** | **5,24:1** | 4,5 |
| Accent / carte | 6,96:1 | 6,42:1 | 4,5 |
| Statut OK / carte | 8,24:1 | 5,08:1 | 3,0 |
| Statut critique / carte | 5,59:1 | 5,83:1 | 3,0 |
| Statut alerte / carte | 10,36:1 | 6,33:1 | 3,0 |
| Texte sur bouton d'accent | 7,50:1 | 6,42:1 | 4,5 |

**Toutes les paires de texte passent le niveau AA dans les deux thèmes.** Le `--color-mute` que vous signaliez est la valeur la plus basse, à 5,24:1 dans son pire cas — au-dessus du seuil de 4,5, avec de la marge.

### Le seul point sous mon seuil

La **bordure du thème sombre** (`#273142` sur `#10151f`) est à **1,40:1**. C'est faible : les cartes se distinguent à peine du fond.

**Je ne l'ai pas changée.** C'est la valeur d'origine de votre thème, WCAG n'impose aucun minimum pour un séparateur décoratif, et la modifier changerait l'apparence que vous avez choisie. Si vous trouvez les cartes trop peu détachées, une seule ligne suffit dans `index.css` :

```css
[data-theme="dark"] { --color-line: #313d52; }  /* porte le ratio à ~1,9:1 */
```

Le thème clair est à 1,41:1 sur la même paire, ce qui est visuellement suffisant sur fond clair — le blanc pur des cartes tranche déjà sur le gris de la page.

### Une couleur codée en dur qui aurait cassé

`TopologyPage.jsx` définissait ses trois couleurs de statut en dur (`#34d399`, `#fb7185`, `#8892b0`). Elles seraient restées celles du thème sombre en thème clair — un vert et un rose pâles sur fond blanc. Rattachées aux variables.

---

## Adaptation mobile

### Barre latérale

Sous 768 px, elle sort du flux et devient un tiroir superposé, ouvert par un bouton hamburger dans l'en-tête. Fermeture par la croix, par le voile, ou automatiquement au choix d'une page — sinon le tiroir resterait ouvert par-dessus le contenu qu'on vient de demander.

Au-dessus de 768 px, `md:relative md:translate-x-0` la remet exactement dans son état d'origine : **aucun changement sur écran large.**

### Tableaux : défilement horizontal, pas cartes empilées

Vous laissiez le choix. **J'ai retenu le défilement horizontal**, pour trois raisons :

1. Les tableaux d'ici sont **denses et comparatifs** — on lit la colonne Statut de haut en bas pour repérer ce qui ne va pas. Empiler en cartes détruit cette lecture verticale.
2. Une carte par équipement sur 50 équipements donne une page interminable.
3. Le passage en cartes demanderait de restructurer 6 composants — soit beaucoup de surface de risque pour une consigne « aucune modification fonctionnelle ».

Une ombre latérale en dégradé indique qu'il reste du contenu à droite, sans ajouter d'élément au DOM. Les 6 tableaux (Équipements, Tableau de bord, Plages, Utilisateurs, Sites, Interfaces) sont enveloppés.

**Si vous préférez les cartes empilées**, c'est faisable, mais autant en faire une consigne à part.

### Graphiques et topologie

Les graphiques Recharts passaient déjà par `ResponsiveContainer` : il ne manquait que `max-width: 100%` sur leur conteneur.

La topologie était en `width={900} height={600}` fixes et débordait. Elle utilise maintenant `viewBox` avec `width="100%"` et `preserveAspectRatio` : le schéma se réduit proportionnellement, avec un plancher à 18 rem en dessous duquel le conteneur défile plutôt que de rendre les nœuds illisibles.

### Fenêtre de détail

Plein écran sous 640 px (marges et arrondis supprimés, hauteur pleine), boîte centrée au-delà. Le voile `bg-black/60` codé en dur est devenu une variable — en thème clair, un voile noir à 60 % était inutilement brutal.

### Cibles tactiles

44 px minimum sur les boutons de navigation, la bascule de thème et la fermeture — c'est le minimum recommandé pour le doigt.

---

## Bascule de thème

- Bouton dans l'en-tête, à droite du sélecteur de site. Icône soleil ou lune selon la cible.
- **Persistance** dans `localStorage`, dans un `try/catch` : en navigation privée stricte, l'écriture échoue et le thème reste simplement valable pour la session.
- **Préférence système respectée au premier lancement** via `prefers-color-scheme`. Tant que l'utilisateur n'a pas choisi lui-même, un changement de thème système est suivi en direct.
- **Pas d'éclair au chargement** : `initialiserTheme()` est appelée dans `main.jsx` avant le premier rendu.

Le thème est porté par `data-theme` sur `<html>`, et `index.css` redéfinit les variables en fonction. **Aucun composant ne connaît le thème courant** — c'est ce qui a permis de tout faire sans toucher une seule classe Tailwind.

`theme.js` a été séparé de `BasculeTheme.jsx` pour que ce dernier n'exporte qu'un composant : sans cela, Vite perdait le rafraîchissement à chaud sur ce fichier.

---

## Choix faits à votre place

| Choix | Décision | Motif |
|---|---|---|
| Fond clair | `#f4f6fa`, pas blanc pur | Moins d'éblouissement, cartes qui se détachent |
| Couleurs de statut | Assombries pour le clair | L'ambre d'origine tombe à 1,8:1 sur blanc |
| Tableaux mobiles | Défilement horizontal | Préserve la lecture verticale comparative |
| Bordure sombre à 1,40:1 | **Conservée** | Valeur d'origine, non requise par WCAG |
| Point de rupture | 768 px | Aligné sur `md:` de Tailwind, déjà utilisé |
| Correction de `Login.css` | Faite | Sans elle, le thème clair n'a aucun effet sur la page de connexion |
| Style de `.scan-launcher` | Ajouté | La classe existait sans définition |
| `App.css` | Boilerplate remplacé | Aucune de ses classes n'était utilisée |

---

## Fichiers

**Créés** — `src/theme.js`, `src/Components/BasculeTheme.jsx`

**Modifiés** — `src/index.css` (palettes, alias, `.pulse-dot`, `.scan-launcher`, `.table-scroll`), `src/App.css` (remplacé), `src/main.jsx`, `src/App.jsx` (en-tête responsive, tiroir), `src/Components/` : `Sidebar.jsx`, `Login.css`, `TopologyPage.jsx`, `EquipementDetail.jsx`, et les 6 composants dont les tableaux ont été enveloppés.

**Aucun fichier backend touché. Aucune migration SQL.**

---

## À vérifier de visu

Ce que je ne peux pas faire à votre place — je n'ai pas de navigateur pour regarder le rendu.

1. **Les deux thèmes sur chaque page** : Tableau de bord, Équipements, Plages, Alertes, Incidents, Topologie, Utilisateurs, Configuration, Journal, Sites, et la fiche de détail.
2. **La page de connexion** — c'est celle qui change le plus, puisqu'elle ne s'affichait pas correctement avant.
3. **Le formulaire de scan** sur le tableau de bord, jusqu'ici non stylé.
4. **Sous 768 px** (les outils de développement du navigateur suffisent) : le tiroir s'ouvre, se ferme au choix d'une page, les tableaux défilent, la topologie se réduit, la fiche de détail occupe l'écran.
5. **Rechargement après bascule** : le thème doit être conservé, sans éclair de couleur au chargement.
