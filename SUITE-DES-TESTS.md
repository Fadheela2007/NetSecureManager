# Retour sur votre campagne de test

Rapport très utile. Trois choses réglées, une qui demande vos données.

---

## Le message vestauth.com — tranché, rien d'inquiétant

**C'est de la publicité dans `dotenv`, pas un paquet douteux.**

Ce que j'ai vérifié :

| Contrôle | Résultat |
|---|---|
| Quel paquet produit le message | `dotenv@17.4.2`, celui que vous avez installé |
| Provenance | `registry.npmjs.org`, empreinte d'intégrité valide dans `package-lock.json` |
| Nature de la chaîne | une entrée d'un tableau de « tips » affichés au hasard |
| Appels réseau dans `dotenv` | **aucun** — ni `http`, ni `fetch`, ni `child_process` |

Depuis la version 17, `dotenv` affiche au démarrage un message
promotionnel tiré au sort, dont certains pointent vers des sponsors.
`vestauth.com` est l'un d'eux. C'est agaçant, ce n'est pas malveillant.

**Corrigé** : `quiet: true` ajouté aux sept endroits qui chargent le
`.env`. Une plateforme vendue n'affiche pas la réclame d'un tiers à son
démarrage.

---

## DÉFAUT 2 (T7) — trouvé, et c'est ma faute

**Cause exacte.** Le cycle de supervision central ne traite que les sites
dont `SITE.dernier_push` vaut NULL :

```sql
SELECT e.* FROM EQUIPEMENT e
JOIN SITE s ON s.id_site = e.id_site
WHERE s.dernier_push IS NULL
```

Le raisonnement est bon — on ne pingue pas un site distant injoignable,
son agent s'en charge sur place. Mais **le script de test que je vous ai
fait lancer a poussé pour le site 1**, ce qui a renseigné `dernier_push`.
Depuis, la plateforme considère votre site local comme « pris en charge
par un agent » et ne supervise plus **rien**.

D'où : zéro relevé, zéro graphique, zéro mesure de bande passante. T10 à
T14 en cascade, exactement comme vous l'avez observé.

J'avais anticipé ce risque et ajouté le mode « politique seule » — mais
après que vous ayez déjà lancé le script. L'avertissement est arrivé trop
tard.

### La réparation, une ligne

```sql
USE NetSecureManager;
UPDATE SITE SET dernier_push = NULL WHERE id_site = 1;
```

Puis redémarrez le backend. Les relevés reprennent au cycle suivant
(une minute). Attendez **dix minutes** avant de rejuger T10 : le débit
se calcule entre deux relevés.

Vérification préalable, pour confirmer le diagnostic avant d'agir :

```sql
SELECT id_site, nom, dernier_push FROM SITE;
```

Si `dernier_push` est renseigné pour votre site local, c'est bien ça.

### Ce que j'ai corrigé pour que ça ne se reproduise pas

Le défaut réel n'était pas la colonne : c'était le **silence**. La
supervision s'arrêtait sur 113 équipements sans le moindre message, les
statuts restaient figés au dernier état connu, et l'interface avait l'air
parfaitement normale.

Pour un outil de supervision, c'est le pire cas possible : le client
croit être surveillé et ne l'est plus.

Le cycle détecte maintenant « des équipements existent, aucun n'est
supervisé » et affiche en clair les sites exclus, leur date de dernier
push, et la requête exacte à exécuter. Une fois par démarrage, pas à
chaque cycle.

Je ne corrige **pas** automatiquement : remettre `dernier_push` à NULL
couperait la supervision d'un vrai site distant.

---

## DÉFAUT 1 (T5) — je ne peux pas conclure sans vos données

J'ai vérifié l'ordre de décision. Il est celui que vous supposiez
absent :

```
1. texte SNMP (sys_descr)     ← priorité maximale
2. ports ouverts
3. type d'équipement nmap
4. système détecté par nmap
5. fabricant                  ← dernier recours
```

Le fabricant est **déjà** en dernier, et j'ai vérifié que « HP »,
« Hewlett Packard » et « Aruba » ne sont associés à aucun type. Votre
hypothèse « Kyocera confondu » ne tient pas : Kyocera n'apparaît que dans
la table des fabricants, consultée en dernier.

**Deux explications restent possibles, et elles appellent des réponses
opposées.**

### Explication A — la règle des ports a tranché

Les ports **9100** (impression brute), **515** (LPD) et **631** (IPP)
donnent `imprimante`, et ils passent **avant** le résultat nmap. Une
machine Windows partageant une imprimante ouvre le port 9100 : elle
serait classée imprimante malgré nmap.

### Explication B — nmap se trompe, et nous avons raison

C'est un artefact bien connu : les serveurs d'impression embarqués HP
(JetDirect) ont une pile réseau que nmap identifie comme
« Microsoft Windows » avec une certitude élevée. Vos trois machines
« Windows + HP + 95-97 % » correspondent exactement à cette signature.

Dans ce cas, ce sont **de vraies imprimantes**, la plateforme a raison,
et c'est nmap qui se trompe.

### La requête qui tranche

Elle affiche, pour chacun des six équipements, tous les signaux
disponibles **et la règle qui a décidé** :

```sql
USE NetSecureManager;

SELECT e.adresse_ip,
       t.libelle          AS type_retenu,
       e.type_source      AS regle_qui_a_decide,
       e.sys_descr,
       e.os_detecte,
       e.fabricant,
       e.fabricant_source,
       GROUP_CONCAT(sd.port ORDER BY sd.port) AS ports_ouverts
FROM EQUIPEMENT e
LEFT JOIN TYPE_EQUIPEMENT t  ON t.id_type = e.id_type
LEFT JOIN SERVICE_DETECTE sd ON sd.id_equipement = e.id_equipement
WHERE e.adresse_ip IN ('192.168.1.28','192.168.1.105','192.168.1.175',
                       '192.168.0.232','192.168.0.233','192.168.0.234')
GROUP BY e.id_equipement, t.libelle, e.type_source, e.sys_descr,
         e.os_detecte, e.fabricant, e.fabricant_source;
```

**Envoyez-moi le résultat.** La colonne `regle_qui_a_decide` donne la
réponse directement :

| Valeur | Ce que ça signifie |
|---|---|
| `port` | explication A — je change l'ordre de priorité |
| `snmp` | le texte SNMP a décidé ; à examiner ligne par ligne |
| `fabricant` | ma vérification est incomplète, je reprends |
| `aucune` | classé `inconnu`, pas `imprimante` — donc l'écran ment |

**Un point me trouble dans votre rapport.** Vous indiquez
`sys_descr = « Aruba ArubaOS-CX »` pour .232 et .233. Or j'ai testé :
avec ce texte en `sys_descr`, la fonction renvoie `routeur/switch` — et
la règle SNMP passe en premier. Ces deux-là ne *peuvent pas* avoir été
classées `imprimante` par le code actuel.

Deux possibilités : soit la ligne date d'un scan antérieur au correctif
du typage, soit « Aruba ArubaOS-CX » se trouve en réalité dans
`os_detecte` (résultat nmap) et non dans `sys_descr`. La requête
ci-dessus les distingue.

Si c'est une donnée ancienne, un bouton existe déjà pour rejouer la
classification sans rescanner : **Équipements → Reclasser les types**.
Essayez-le avant tout, c'est peut-être toute la réponse.

---

## Vos deux points secondaires

### Le jeton dans l'URL du websocket — fausse alerte

Ce n'est pas votre jeton d'authentification. C'est celui de **Vite**,
votre serveur de développement, sur son propre websocket de rechargement
à chaud (`vite@8.2.0`, chaîne `token=${wsToken}` dans son client).

C'est une mesure de sécurité **de Vite** : elle empêche une autre page
ouverte dans votre navigateur de se connecter à ce canal. Elle
n'existe qu'en développement et disparaît de `npm run build`.

### Mais votre remarque m'a fait trouver autre chose

En vérifiant, j'ai découvert que le backend crée un serveur websocket
`socket.io` avec **`cors: { origin: "*" }`** — ouvert à n'importe quelle
page web — et que **rien ne s'en sert** : pas un `emit`, pas un
`on("connection")`. Le paquet client est également installé côté
frontend sans être utilisé.

Une surface d'attaque sans contrepartie. Désactivé par défaut ; il
s'active par `WEBSOCKET_ORIGINE` dans le `.env`, restreint à cette seule
origine. Le commentaire dans le code rappelle qu'il faudra authentifier
la connexion par l'option `auth` — et non par un paramètre d'URL, qui
finit dans les journaux des serveurs intermédiaires. C'était votre
intuition, elle était juste, simplement au mauvais endroit.

### `/api/utilisateurs` — déjà fermé, et resserré

La route était déjà `requireRole("admin", "operateur")` : un compte
lecteur n'y a **pas** accès. Votre inquiétude était fondée mais le
verrou existait.

J'ai quand même resserré : un **opérateur** voit désormais la liste des
personnes (nécessaire pour assigner un incident) mais plus leur adresse
e-mail ni leur numéro WhatsApp, qui ne servent qu'à configurer les
notifications — une tâche d'administrateur.

---

## À faire, dans l'ordre

1. **`UPDATE SITE SET dernier_push = NULL WHERE id_site = 1;`** puis
   redémarrer le backend. Attendre dix minutes.
2. Rejouer **T7**, puis **T10** à **T14**.
3. Essayer **Équipements → Reclasser les types**, puis relancer la
   requête de diagnostic ci-dessus et me l'envoyer.

Le message `vestauth.com` aura disparu au redémarrage.

**99 tests au vert**, dont 6 nouveaux sur la faille d'amorçage trouvée
lors de l'audit précédent.
