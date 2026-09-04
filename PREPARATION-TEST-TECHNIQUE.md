# Préparation — test avec des connaisseurs de l'informatique

Document de travail, à garder hors du dépôt public (voir la fin).

Ce n'est pas la même chose que la démonstration commerciale. Là-bas vous
convainquez ; demain vous **encaissez la critique**. Un public technique ne
juge pas seulement si c'est joli — il va essayer de vous prendre en défaut.
C'est bon signe : mieux vaut qu'ils trouvent les trous demain, entre amis,
qu'un client dans trois semaines.

---

## Ce qui change par rapport à la démonstration client

Vous pouvez parler technique. Dites « scan », « SNMP », « CIDR » sans les
traduire. Ne récitez pas le scénario des 20 minutes tel quel — ici,
l'objectif est qu'ils **manipulent**, pas qu'ils écoutent.

Donnez-leur les mains sur le clavier à un moment. Un testeur qui clique
lui-même trouve dix fois plus de défauts qu'un testeur qui regarde.

---

## Avant qu'ils arrivent — à faire ce soir

1. **Redémarrez tout depuis zéro** : backend, agent, base. Un produit qui
   marche parce que quelqu'un a bricolé une session ouverte depuis trois
   jours, ça se voit à l'usage.
2. **Lancez la suite de tests** : `npm test` dans `backend/`. Elle doit
   afficher 248 tests au vert. S'il y a un rouge, ne partez pas dessus
   demain.
3. **Régénérez le jeton de l'agent** une dernière fois, et relancez l'agent
   avec le nouveau. Vérifiez que le cycle passe et que la politique web
   s'applique.
4. **Un scan complet propre**, pour que le parc soit rempli quand ils
   arrivent — ne les faites pas attendre 72 secondes en silence à leur
   première impression.
5. Gardez ce fichier ouvert dans un onglet, pas affiché à l'écran partagé.

---

## Les questions qu'ils vont poser, et les réponses honnêtes

Ne bluffez sur aucune. Un public technique qui vous prend en flagrant délit
d'exagération ne vous croira plus sur rien d'autre ensuite.

**« C'est chiffré entre l'agent et le serveur central ? »**
Aujourd'hui, non par défaut : l'exemple de configuration utilise
`http://localhost:5000/api` en développement, et rien n'impose HTTPS. C'est
un prérequis identifié avant tout déploiement hors du réseau local — un
agent qui pousse des identifiants réseau sur Internet en clair n'est pas
défendable. Pour l'instant, l'architecture cible un agent sur le même
réseau local que ce qu'il supervise, ou un tunnel/VPN vers le central. Ne
le cachez pas si on vous le demande.

**« Le mot de passe, c'est bcrypt ? Quel coût ? »**
Oui, bcrypt, coût 10 — la valeur par défaut recommandée actuellement.
Cohérent sur toute la plateforme (`auth.js`, `utilisateurs.js`).

**« Et si quelqu'un essaie de bruteforcer le login ? »**
Un limiteur de tentatives existe, par adresse IP et par compte, avec un
seuil plus permissif sur le compte pour ne pas permettre de verrouiller
l'administrateur de quelqu'un d'autre. Limite honnête : l'état est en
mémoire, pas partagé entre plusieurs serveurs, et remis à zéro à chaque
redémarrage. Assumé à l'échelle visée aujourd'hui.

**« Le JWT expire quand ? »**
Durée configurable par variable d'environnement (`JWT_EXPIRES_IN`), pas de
révocation immédiate côté serveur si un jeton est volé avant expiration —
c'est la limite classique d'un jeton stateless. Pas de rafraîchissement
automatique construit pour l'instant.

**« Le cloisonnement multi-site, c'est vérifié où ? »**
Côté serveur, sur chaque route, via `porteeSite` — pas seulement filtré à
l'affichage. Un accès direct par ID à un équipement d'un autre site renvoie
404, pas 403, pour ne pas confirmer que l'équipement existe. Vérifié par un
outil dédié qui compare ce qu'un compte restreint reçoit à ce qui existe
réellement en base (`verifier-cloisonnement.js`).

**« Le scan, ça ne va pas faire sonner l'IDS du client ? »**
Concurrence plafonnée à 5 hôtes en parallèle par défaut (réglable, capé à
20), délibérément pour rester sous les seuils de déclenchement habituels.
`nmap -F` réduit aussi le nombre de ports sondés par rapport à un scan
complet. Documenté, pas deviné — mesuré sur machines réelles.

**« Comment il classe un équipement sans SNMP ? »**
Par ordre de confiance décroissante : texte SNMP en premier (l'équipement
se décrit lui-même), puis l'OUI de l'adresse MAC (le vrai fabricant de la
carte réseau), puis l'estimation d'OS par nmap en dernier recours. Une
case vide plutôt qu'une supposition quand aucun signal fiable n'existe —
règle appliquée partout dans le produit, pas seulement ici.

**« Qu'est-ce qui se passe si deux switches non administrables ? »**
L'attribution de bande passante par port ne fonctionne que sur un switch
administrable en SNMP. Sans lui, la plateforme garde l'inventaire et les
pannes, mais pas la consommation par machine. C'est un prérequis à
vérifier chez le client avant de vendre cette fonction précise — vous
l'aviez déjà noté vous-même.

**« Et la réinitialisation de mot de passe si l'admin l'oublie ? »**
Aucune réinitialisation en libre-service aujourd'hui — un administrateur
change le mot de passe d'un autre compte depuis la page Utilisateurs. Si
l'administrateur unique est bloqué, il existe un outil en ligne de
commande (`tools/creer-admin.js`) qui crée un compte administrateur
directement en base, pour qui a accès au serveur. Un vrai mécanisme par
courriel est prévu, pas construit encore.

**« C'est testé sur une vraie installation, pas juste votre PC ? »**
Répondez franchement si ce n'est pas encore fait : « pas encore sur une
machine vierge, c'est la prochaine étape avant le premier déploiement
client ». Ne prétendez pas l'inverse — un testeur technique demande
souvent une démonstration d'installation, justement.

---

## Ce qu'il faut les laisser essayer de casser

Donnez-leur ces pistes plutôt que d'attendre qu'ils les trouvent seuls —
ça montre que vous connaissez vos propres limites, ce qui rassure plus
qu'un produit qui prétend n'en avoir aucune :

- se connecter avec un mauvais mot de passe plusieurs fois de suite (voir
  si le limiteur réagit) ;
- ouvrir l'inspecteur du navigateur pendant qu'un compte non-admin est
  connecté, et vérifier qu'aucun champ sensible ne sort dans les réponses
  réseau (c'est ce que fait `verifier-secrets.js` — vous pouvez même le
  lancer devant eux, c'est un bon effet) ;
- essayer d'accéder à l'équipement d'un autre site en modifiant l'URL ;
- débrancher un appareil et chronométrer vraiment le délai avant l'alerte,
  au lieu de le raconter.

---

## Ce que vous, vous devez vérifier avant qu'ils le remarquent

- Le taux de disponibilité affiché juste après un scan : toujours 100 %,
  et un technicien le sait. Ne le présentez pas comme une mesure encore
  significative à ce stade.
- La page Réinitialisation : ne l'ouvrez pas sans le vouloir en cherchant
  un autre écran.
- Les 248 tests, le nombre exact — s'ils demandent une preuve, montrez le
  terminal, pas une capture d'écran ancienne.

---

## À faire de ce fichier

Document de préparation interne, pas un livrable. Ajoutez à `.gitignore` :

```
PREPARATION-TEST-*.md
```
