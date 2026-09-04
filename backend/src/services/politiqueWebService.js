/**
 * politiqueWebService.js
 * Compilation d'une politique de blocage web en liste de domaines
 * effective, et génération des configurations qui l'appliquent.
 *
 * CE MODULE NE VOIT AUCUNE DONNÉE DE NAVIGATION.
 *
 * Il transforme une politique (catégories + règles manuelles) en
 * fichiers de configuration. Il ne reçoit ni requête DNS, ni adresse IP
 * de poste, ni nom d'utilisateur. La séparation est volontaire : le seul
 * endroit du code qui pourrait tracer quelqu'un n'existe pas.
 */

/**
 * Points d'accès DNS-over-HTTPS connus.
 *
 * POURQUOI CETTE LISTE EXISTE — c'est le point qui décide si le produit
 * tient sa promesse.
 *
 * Le blocage DNS classique suppose que le poste utilise le résolveur
 * qu'on lui a donné. Or Firefox active DoH par défaut dans plusieurs
 * pays, Chrome le propose en un clic, et Windows 11 le gère nativement.
 * Un poste en DoH envoie ses requêtes DNS chiffrées vers Cloudflare ou
 * Google, en HTTPS sur le port 443 : notre résolveur ne les voit jamais
 * passer et la politique devient décorative.
 *
 * Vendre « contrôle des accès web » sans traiter ce point, c'est vendre
 * quelque chose qu'un adolescent contourne en trois clics — et le
 * découvrir en démonstration devant l'acheteur.
 *
 * LIMITE ASSUMÉE, à dire au client : cette liste couvre les fournisseurs
 * grand public, ceux que les navigateurs utilisent par défaut. Elle ne
 * couvre pas un DoH auto-hébergé sur un domaine quelconque — rien ne
 * distingue ce trafic d'une visite de site web ordinaire. Contre
 * quelqu'un de déterminé et compétent, aucun filtrage DNS ne tient ; la
 * réponse à ce niveau de menace est le proxy d'entreprise, pas le DNS.
 * Le filtrage DNS traite l'usage courant, ce qui est déjà l'essentiel du
 * besoin réel.
 */
const RESOLVEURS_DOH = [
  // Cloudflare
  { hote: "cloudflare-dns.com", ips: ["1.1.1.1", "1.0.0.1"] },
  { hote: "mozilla.cloudflare-dns.com", ips: ["1.1.1.1", "1.0.0.1"] },
  { hote: "security.cloudflare-dns.com", ips: ["1.1.1.2", "1.0.0.2"] },
  // Google
  { hote: "dns.google", ips: ["8.8.8.8", "8.8.4.4"] },
  // Quad9
  { hote: "dns.quad9.net", ips: ["9.9.9.9", "149.112.112.112"] },
  // OpenDNS / Cisco
  { hote: "doh.opendns.com", ips: ["208.67.222.222", "208.67.220.220"] },
  // AdGuard
  { hote: "dns.adguard-dns.com", ips: ["94.140.14.14", "94.140.15.15"] },
  // NextDNS
  { hote: "dns.nextdns.io", ips: [] },
];

/**
 * Normalise un domaine saisi à la main.
 *
 * Les administrateurs collent ce qu'ils ont sous la main : une URL
 * complète, une ligne de fichier hosts, un domaine avec un point final.
 * Refuser ces saisies serait pédant ; les accepter telles quelles
 * produirait des règles qui ne correspondent à rien et un blocage qui
 * n'a pas lieu — sans le moindre message d'erreur.
 *
 * @returns {string|null} le domaine nettoyé, ou null s'il est inexploitable
 */
function normaliserDomaine(saisie) {
  if (typeof saisie !== "string") return null;

  let d = saisie.trim().toLowerCase();
  if (!d) return null;

  // Ligne de fichier hosts : « 0.0.0.0 pub.exemple.com »
  const hosts = d.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1)\s+(\S+)/);
  if (hosts) d = hosts[1];

  // Commentaire de fin de ligne
  d = d.split("#")[0].trim();
  if (!d) return null;

  // URL complète : on ne garde que l'hôte
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.split("/")[0].split("?")[0];

  // Identifiants, port, point final
  d = d.split("@").pop();
  d = d.split(":")[0];
  d = d.replace(/\.+$/, "");

  // « *.exemple.com » : le blocage porte déjà sur les sous-domaines,
  // l'étoile est donc redondante — mais la refuser serait absurde.
  d = d.replace(/^\*\./, "");
  // « www. » n'est pas retiré : bloquer www.exemple.com sans bloquer
  // exemple.com est un choix légitime que l'administrateur doit pouvoir
  // exprimer.

  if (!d) return null;

  // Un domaine valide : des étiquettes alphanumériques séparées par des
  // points, au moins deux. « localhost » et les adresses IP sont
  // écartés : ils ne se bloquent pas par DNS.
  if (!/^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/.test(d)) {
    return null;
  }
  return d;
}

/**
 * Vrai si `domaine` est égal ou sous-domaine de `parent`.
 *
 * LE PIÈGE À ÉVITER : une comparaison par `endsWith` fait correspondre
 * « notfacebook.com » à « facebook.com », et bloque un site sans aucun
 * rapport. La correspondance doit s'arrêter sur une frontière
 * d'étiquette, c'est-à-dire un point.
 */
function estSousDomaine(domaine, parent) {
  if (domaine === parent) return true;
  return domaine.endsWith(`.${parent}`);
}

/**
 * Décide du sort d'un domaine selon les règles manuelles.
 *
 * PRÉCÉDENCE, dans l'ordre :
 *   1. la règle manuelle la plus SPÉCIFIQUE (domaine le plus long)
 *   2. à spécificité égale, « autoriser » l'emporte
 *
 * Le point 1 permet d'écrire « bloquer exemple.com » puis « autoriser
 * boutique.exemple.com » — le cas courant. Sans classement par
 * spécificité, ces deux règles se contrediraient selon leur ordre
 * d'insertion en base, ce qui est le pire des comportements : le
 * résultat dépendrait de l'ordre des clics.
 *
 * Le point 2 est le principe de prudence : en cas d'ambiguïté réelle, on
 * laisse passer. Un site bloqué à tort empêche quelqu'un de travailler
 * et génère un ticket ; un site autorisé à tort ne casse rien.
 *
 * @returns {'bloquer'|'autoriser'|null} null = aucune règle manuelle
 */
function verdictManuel(domaine, reglesManuelles) {
  let meilleure = null;
  let longueur = -1;

  for (const r of reglesManuelles) {
    if (!estSousDomaine(domaine, r.domaine)) continue;
    const l = r.domaine.length;
    if (l > longueur) {
      longueur = l;
      meilleure = r.action;
    } else if (l === longueur && r.action === "autoriser") {
      meilleure = "autoriser";
    }
  }
  return meilleure;
}

/**
 * Compile une politique en liste de domaines à bloquer.
 *
 * @param {object} politique
 * @param {Array<string>} politique.domainesCategories  domaines issus des catégories actives
 * @param {Array<{domaine:string, action:string}>} politique.reglesManuelles
 * @returns {{ bloquer: string[], autoriser: string[], stats: object }}
 */
function compilerPolitique({ domainesCategories = [], reglesManuelles = [] } = {}) {
  // Normalisation d'abord : deux écritures du même domaine doivent se
  // rejoindre avant qu'on raisonne dessus.
  const manuelles = [];
  const rejetees = [];
  for (const r of reglesManuelles) {
    const d = normaliserDomaine(r.domaine);
    if (!d) {
      rejetees.push(r.domaine);
      continue;
    }
    manuelles.push({ domaine: d, action: r.action === "autoriser" ? "autoriser" : "bloquer" });
  }

  const bloquer = new Set();
  const autoriser = new Set();

  // 1. Les catégories, filtrées par les exceptions manuelles.
  let exclusParException = 0;
  for (const brut of domainesCategories) {
    const d = normaliserDomaine(brut);
    if (!d) continue;

    if (verdictManuel(d, manuelles) === "autoriser") {
      exclusParException++;
      continue;
    }
    bloquer.add(d);
  }

  // 2. Les règles manuelles elles-mêmes.
  for (const r of manuelles) {
    if (r.action === "bloquer") {
      bloquer.add(r.domaine);
      // Un ajout manuel prime : si le même domaine figurait aussi en
      // exception, la boucle précédente l'a déjà écarté des catégories,
      // et verdictManuel a tranché entre les deux règles.
    } else {
      autoriser.add(r.domaine);
      bloquer.delete(r.domaine);
    }
  }

  // 3. Compaction : inutile de bloquer « pub.exemple.com » si
  // « exemple.com » est déjà bloqué — le blocage porte sur les
  // sous-domaines. Sur une liste de 300 000 entrées, cette réduction
  // allège nettement la configuration du résolveur, donc sa mémoire et
  // son temps de rechargement.
  //
  // Exception : on ne compacte QUE si aucune exception manuelle ne vit
  // sous le domaine parent. Sinon « bloquer exemple.com » écraserait
  // « autoriser boutique.exemple.com », que dnsmasq ne saurait pas
  // rétablir.
  // L'ORDRE DE PARCOURS EST CRITIQUE. Un domaine parent doit être examiné
  // AVANT ses sous-domaines, sinon il n'est pas encore dans `finale` au
  // moment où on teste si l'enfant est couvert, et l'enfant reste dans la
  // liste. Un tri alphabétique ne le garantit pas :
  // « cdn.pub.exemple.com » précède « exemple.com ».
  //
  // On trie donc par nombre d'étiquettes croissant : « exemple.com » (2)
  // avant « pub.exemple.com » (3) avant « cdn.pub.exemple.com » (4).
  const listeBloquer = [...bloquer].sort((a, b) => {
    const na = a.split(".").length;
    const nb = b.split(".").length;
    return na !== nb ? na - nb : a.localeCompare(b);
  });

  // ── COÛT DU CALCUL — la première version ne tenait pas à l'échelle ──
  //
  // Elle comparait chaque domaine à tous ceux déjà retenus
  // (`finale.some(...)`), soit près de 5 milliards de comparaisons sur
  // 95 000 entrées. Mesuré : 11 s pour 30 000 domaines, donc environ
  // deux minutes pour une liste publicité réelle. L'agent abandonnait sur
  // « timeout of 60000ms exceeded », et le serveur restait bloqué tout ce
  // temps — un seul agent suffisait à figer la plateforme entière.
  //
  // Le défaut ne se voyait pas sur les jeux d'essai : quelques dizaines
  // de domaines s'y compilent instantanément. Il n'apparaissait qu'avec
  // une vraie liste.
  //
  // On inverse donc le raisonnement. Plutôt que de chercher « lequel des
  // domaines retenus est un parent de celui-ci ? », on ENGENDRE les
  // parents possibles — « a.b.c.d » n'en a que trois : « b.c.d », « c.d »,
  // « d » — et on regarde s'ils sont déjà retenus. Un nom de domaine
  // dépasse rarement cinq étiquettes : le travail par domaine devient
  // constant, et le total linéaire.
  const ancetres = (domaine) => {
    const parts = domaine.split(".");
    const liste = [];
    // On s'arrête avant la dernière étiquette : « com » n'est pas un
    // parent qu'on puisse bloquer, et le TLD seul n'est jamais dans la
    // liste de toute façon.
    for (let i = 1; i <= parts.length - 2; i++) {
      liste.push(parts.slice(i).join("."));
    }
    return liste;
  };

  // Domaines bloqués qui abritent une exception : on ne les compactera
  // pas, sinon dnsmasq perdrait le moyen de rétablir l'exception.
  const ensembleBloquer = new Set(listeBloquer);
  const parentsAvecException = new Set();
  for (const a of autoriser) {
    for (const parent of ancetres(a)) {
      if (ensembleBloquer.has(parent)) parentsAvecException.add(parent);
    }
  }

  const finale = [];
  const conserves = new Set();
  let compactes = 0;

  for (const d of listeBloquer) {
    let couvert = false;
    for (const parent of ancetres(d)) {
      if (conserves.has(parent) && !parentsAvecException.has(parent)) {
        couvert = true;
        break;
      }
    }
    if (couvert) {
      compactes++;
      continue;
    }
    conserves.add(d);
    finale.push(d);
  }

  return {
    // Retour à l'ordre alphabétique pour la sortie : le fichier de
    // configuration est relu par des humains qui y cherchent un domaine.
    bloquer: finale.sort(),
    autoriser: [...autoriser].sort(),
    stats: {
      domaines_categories: domainesCategories.length,
      regles_manuelles: manuelles.length,
      rejetees: rejetees.length,
      exemples_rejetes: rejetees.slice(0, 5),
      exclus_par_exception: exclusParException,
      compactes,
      total_bloques: finale.length,
    },
  };
}

/**
 * Génère la configuration dnsmasq correspondant à une politique.
 *
 * Pourquoi dnsmasq : présent dans tous les dépôts Linux, configuration
 * en texte, rechargement sans coupure, et surtout la syntaxe
 * `address=/domaine/` qui applique déjà la correspondance par frontière
 * d'étiquette — exactement la sémantique décidée plus haut, sans avoir à
 * l'implémenter nous-mêmes.
 *
 * @param {object} compilee  résultat de compilerPolitique
 * @param {object} options   { ipBlocage, resolveursAmont, version, nomSite }
 */
function genererDnsmasq(compilee, options = {}) {
  const {
    // Adresse renvoyée pour un domaine bloqué. Pointer vers l'agent
    // lui-même (et non 0.0.0.0) permet de servir une page d'explication
    // au lieu d'une erreur de connexion incompréhensible.
    ipBlocage = "0.0.0.0",
    resolveursAmont = ["9.9.9.9", "1.1.1.1"],
    version = 0,
    nomSite = "",
  } = options;

  const lignes = [
    "# ─────────────────────────────────────────────────────────────",
    "# Fichier GÉNÉRÉ par NetSecureManager — ne pas modifier à la main.",
    "# Toute modification sera écrasée à la prochaine mise à jour de la",
    "# politique. Pour changer une règle : interface -> Accès web.",
    `# Site : ${nomSite || "—"}`,
    `# Version de politique : ${version}`,
    `# Généré le : ${new Date().toISOString()}`,
    `# Domaines bloqués : ${compilee.bloquer.length}`,
    "# ─────────────────────────────────────────────────────────────",
    "",
    "# Ne jamais transmettre les noms sans domaine ni les adresses",
    "# privées inversées aux résolveurs publics : c'est une fuite",
    "# d'information sur le réseau interne du client.",
    "domain-needed",
    "bogus-priv",
    "",
    "# Résolveurs amont, interrogés pour tout ce qui n'est pas bloqué.",
    "no-resolv",
    ...resolveursAmont.map((ip) => `server=${ip}`),
    "",
    "# Les exceptions sont déclarées AVANT les blocages : dnsmasq retient",
    "# la correspondance la plus spécifique, mais l'ordre rend le fichier",
    "# lisible pour l'administrateur qui vient vérifier une règle.",
  ];

  for (const d of compilee.autoriser) {
    lignes.push(`server=/${d}/#`);
  }

  lignes.push(
    "",
    "# ── Domaines bloqués (sous-domaines inclus) ──",
    "#",
    "# DEUX LIGNES PAR DOMAINE, et la seconde est indispensable.",
    "#",
    "# `address=/domaine/0.0.0.0` ne répond qu'aux questions IPv4. Une",
    "# question IPv6 (enregistrement AAAA) sur le même domaine était",
    "# transmise aux résolveurs publics, qui renvoyaient la vraie adresse.",
    "#",
    "# Or tous les navigateurs actuels préfèrent l'IPv6 quand elle est",
    "# disponible. Le site s'ouvrait donc normalement, alors que la",
    "# vérification en IPv4 montrait un blocage parfait. Constaté sur",
    "# doubleclick.net : A bloqué, AAAA répondant 2a00:1450:4006:809::200e.",
    "#",
    "# `::` est l'équivalent IPv6 de 0.0.0.0 : une adresse qui ne mène",
    "# nulle part.",
    ""
  );
  for (const d of compilee.bloquer) {
    lignes.push(`address=/${d}/${ipBlocage}`);
    lignes.push(`address=/${d}/::`);
  }

  lignes.push("");
  return lignes.join("\n");
}

/**
 * Génère les règles de pare-feu qui empêchent le contournement.
 *
 * SANS CES RÈGLES, LE BLOCAGE DNS EST DÉCORATIF. Trois contournements
 * tiennent en trente secondes :
 *   1. changer le DNS de sa machine pour 8.8.8.8 ;
 *   2. activer DNS-over-HTTPS dans le navigateur ;
 *   3. utiliser DNS-over-TLS (port 853).
 *
 * Les règles ci-dessous ferment les trois. Elles s'appliquent sur le
 * ROUTEUR du site, pas sur l'agent : l'agent n'est pas sur le chemin du
 * trafic, il ne peut rien bloquer lui-même. C'est la partie
 * infrastructure du chantier, et elle demande une intervention chez le
 * client — la plateforme produit les règles, elle ne peut pas les
 * appliquer à distance sur un matériel qu'elle ne connaît pas.
 *
 * @param {string} ipAgent  adresse du résolveur autorisé
 * @param {string} format   'iptables' | 'pfsense' | 'mikrotik' | 'cisco'
 */
function genererReglesPareFeu(ipAgent, format = "iptables") {
  const ipsDoh = [...new Set(RESOLVEURS_DOH.flatMap((r) => r.ips))];

  const entete = [
    "# ─────────────────────────────────────────────────────────────",
    "# Règles anti-contournement — NetSecureManager",
    "#",
    "# À APPLIQUER SUR LE ROUTEUR OU LE PARE-FEU DU SITE.",
    "# L'agent n'est pas sur le chemin du trafic : il ne peut pas les",
    "# appliquer lui-même. Sans elles, la politique DNS se contourne en",
    "# changeant un réglage dans le navigateur.",
    "#",
    `# Résolveur autorisé : ${ipAgent}`,
    "# ─────────────────────────────────────────────────────────────",
    "",
  ];

  if (format === "iptables") {
    return [
      ...entete,
      "# 1. DNS classique : seul le résolveur de l'agent est joignable.",
      `iptables -A FORWARD -p udp --dport 53 -d ${ipAgent} -j ACCEPT`,
      `iptables -A FORWARD -p tcp --dport 53 -d ${ipAgent} -j ACCEPT`,
      "iptables -A FORWARD -p udp --dport 53 -j REJECT",
      "iptables -A FORWARD -p tcp --dport 53 -j REJECT",
      "",
      "# 2. DNS-over-TLS (port 853) : aucun usage légitime ici.",
      "iptables -A FORWARD -p tcp --dport 853 -j REJECT",
      "iptables -A FORWARD -p udp --dport 853 -j REJECT",
      "",
      "# 3. DNS-over-HTTPS : les fournisseurs grand public, par adresse.",
      "#    Le blocage porte sur le port 443 de ces adresses précises,",
      "#    pas sur le domaine : en DoH, le nom est déjà chiffré.",
      ...ipsDoh.map((ip) => `iptables -A FORWARD -p tcp --dport 443 -d ${ip} -j REJECT`),
      "",
      "# Rendre les règles persistantes :",
      "#   apt install iptables-persistent && netfilter-persistent save",
      "",
    ].join("\n");
  }

  if (format === "mikrotik") {
    return [
      ...entete,
      "# 1. DNS classique",
      `/ip firewall filter add chain=forward protocol=udp dst-port=53 dst-address=${ipAgent} action=accept comment="DNS agent NSM"`,
      `/ip firewall filter add chain=forward protocol=tcp dst-port=53 dst-address=${ipAgent} action=accept comment="DNS agent NSM"`,
      '/ip firewall filter add chain=forward protocol=udp dst-port=53 action=reject comment="Blocage DNS externe"',
      '/ip firewall filter add chain=forward protocol=tcp dst-port=53 action=reject comment="Blocage DNS externe"',
      "",
      "# 2. DNS-over-TLS",
      '/ip firewall filter add chain=forward protocol=tcp dst-port=853 action=reject comment="Blocage DoT"',
      "",
      "# 3. DNS-over-HTTPS",
      `/ip firewall address-list add list=doh-publics address=${ipsDoh.join(" ; /ip firewall address-list add list=doh-publics address=")}`,
      '/ip firewall filter add chain=forward protocol=tcp dst-port=443 dst-address-list=doh-publics action=reject comment="Blocage DoH"',
      "",
    ].join("\n");
  }

  // pfSense et Cisco : la configuration se fait par interface graphique
  // ou par un dialecte trop variable d'une version à l'autre pour être
  // généré à l'aveugle. On donne la consigne, pas un script faux.
  return [
    ...entete,
    "# Ce format ne se génère pas de façon fiable : la syntaxe varie",
    "# d'une version à l'autre, et une règle de pare-feu fausse coupe le",
    "# réseau du client. Voici les trois règles à créer à la main, dans",
    "# cet ordre :",
    "#",
    `#  1. AUTORISER  toute source -> ${ipAgent}        ports 53 TCP+UDP`,
    "#  2. REFUSER    toute source -> toute destination  ports 53 TCP+UDP",
    "#  3. REFUSER    toute source -> toute destination  port 853 TCP+UDP",
    "#  4. REFUSER    toute source -> les adresses ci-dessous, port 443 :",
    ...ipsDoh.map((ip) => `#       ${ip}`),
    "#",
    "# L'ordre compte : la règle 1 doit précéder la règle 2, sinon plus",
    "# aucune résolution DNS ne fonctionne sur le site.",
    "",
  ].join("\n");
}

module.exports = {
  normaliserDomaine,
  estSousDomaine,
  verdictManuel,
  compilerPolitique,
  genererDnsmasq,
  genererReglesPareFeu,
  RESOLVEURS_DOH,
};
