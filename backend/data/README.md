# Données embarquées

## `oui-ieee.json.gz` — registre OUI de l'IEEE

Correspondance entre les trois premiers octets d'une adresse MAC (l'OUI,
*Organizationally Unique Identifier*) et le fabricant de la carte réseau.

| | |
|---|---|
| Entrées | 53 559 |
| Taille | 517 Ko compressé (1,5 Mo décompressé) |
| Format | JSON gzip, `{ "A434D9": "Intel Corporate", ... }` |
| Clés | 6 caractères hexadécimaux majuscules, sans séparateur |

### Origine

Extrait du registre public MA-L de l'IEEE
(`https://standards-oui.ieee.org/oui/oui.csv`), via le paquet
[`oui-data`](https://www.npmjs.com/package/oui-data) (licence BSD-2-Clause).

Les **données** elles-mêmes sont publiques : l'IEEE publie ce registre
librement. Seule la mise en forme provient du paquet ci-dessus, qui n'est
**pas** une dépendance du projet — il n'a servi qu'à produire ce fichier.

Les raisons sociales ont été raccourcies à la première ligne, débarrassées
des suffixes juridiques (`Inc.`, `Ltd`, `GmbH`, `S.A.`…) pour l'affichage.

### Mettre à jour

Le fichier n'est qu'une **graine**. La table `OUI_FABRICANT` en base fait
foi, et se met à jour sans redéployer l'application :

```bash
cd backend

# depuis la graine embarquée (aucun accès Internet requis)
node tools/importer-oui.js

# depuis un fichier plus récent téléchargé ailleurs
node tools/importer-oui.js --fichier /chemin/vers/oui.csv

# directement depuis l'IEEE, si le serveur a Internet
node tools/importer-oui.js --telecharger
```

L'IEEE publie de nouvelles attributions chaque semaine. Une mise à jour
trimestrielle suffit largement : les blocs déjà attribués ne changent pas,
seuls de nouveaux s'ajoutent.
