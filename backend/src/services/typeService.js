/**
 * typeService.js
 * Détermine la CATÉGORIE d'un équipement, à partir de tous les signaux
 * disponibles.
 *
 * POURQUOI UN SERVICE DÉDIÉ
 *
 * Le type était décidé à trois endroits sans vocabulaire commun :
 * `fingerprint()` depuis le texte SNMP, le résultat brut de nmap, et la
 * résolution OUI. Trois symptômes en découlaient :
 *
 *   • « detecte_nmap » et « equipement_snmp » s'affichaient comme des
 *     catégories, alors que ce sont des NOMS DE MÉTHODE ;
 *   • tout texte contenant « windows » donnait « serveur », y compris un
 *     poste sous Windows 11 ;
 *   • les signaux ne se complétaient pas : un équipement identifié par
 *     OUI restait sans type même quand un port ouvert le trahissait.
 *
 * Une seule fonction décide désormais, avec un vocabulaire fermé.
 *
 * RÈGLE DIRECTRICE : mieux vaut « inconnu » qu'une catégorie fausse.
 * Un administrateur réseau qui voit « serveur » sur un poste perd
 * confiance dans toute la colonne — davantage que s'il lisait « inconnu ».
 */

/**
 * Vocabulaire fermé. Toute valeur produite par ce service en fait partie.
 * Aucun nom de technique de détection n'y figure.
 */
const TYPES = {
  POSTE: "poste_travail",
  SERVEUR: "serveur",
  IMPRIMANTE: "imprimante",
  ROUTEUR: "routeur",
  SWITCH: "routeur/switch",
  PARE_FEU: "pare-feu",
  CAMERA: "camera",
  TELEPHONIE: "telephonie",
  INCONNU: "inconnu",
};

const TOUS_LES_TYPES = Object.values(TYPES);

/**
 * Ports dont la présence est à elle seule très indicative.
 *
 * Seuls les ports quasi mono-usage figurent ici. RDP (3389), SMB (445) ou
 * SSH (22) sont présents sur des postes comme sur des serveurs : ils ne
 * permettent aucune conclusion et sont volontairement absents.
 */
const PORTS_REVELATEURS = new Map([
  [9100, TYPES.IMPRIMANTE], // JetDirect / impression brute — quasi exclusivement des imprimantes
  [515, TYPES.IMPRIMANTE],  // LPD
  [631, TYPES.IMPRIMANTE],  // IPP
  [554, TYPES.CAMERA],      // RTSP — flux vidéo
]);

/**
 * Analyse un texte libre (sysDescr, sysName, résultat OS de nmap) et en
 * déduit une catégorie.
 *
 * @param {string} texte
 * @param {"snmp"|"nmap"} provenance  change l'interprétation de certains
 *        marqueurs : un agent SNMP installé sur du Linux évoque une machine
 *        administrée, alors que « Linux » détecté par nmap ne dit rien.
 * @returns {string|null} un type du vocabulaire, ou null si rien de sûr
 */
function typeDepuisTexte(texte, provenance = "snmp") {
  if (!texte) return null;
  const t = String(texte).toLowerCase();

  // ── Équipements réseau ────────────────────────────────────────────
  //
  // Réservé au texte SNMP : ces règles ne s'appliquent pas aux
  // estimations de nmap.
  //
  // Sur un parc réel, treize appareils — téléphones Android, objets
  // connectés — ont tous été classés « routeur ». Tous portaient la même
  // estimation nmap, « 3Com OfficeConnect 3CRWER100-75 wireless broadband
  // router », qui est le repli de nmap devant une petite pile réseau
  // embarquée : le mot « router » y figurait, la règle se déclenchait.
  //
  // La faute de fond : déduire une CATÉGORIE d'un NOM DE PRODUIT. Le
  // texte SNMP est ce que l'équipement déclare de lui-même ; l'estimation
  // nmap est une comparaison d'empreintes, qui propose le modèle le plus
  // ressemblant même quand rien ne ressemble vraiment.
  //
  // Ce qu'on perd : un vrai routeur sans SNMP retombe sur « inconnu ».
  // Compromis assumé, rattrapé par nmapDeviceType — qui annonce une
  // catégorie et non un modèle, et qui est consulté avant cette fonction.
  if (provenance === "snmp") {
    if (/fortigate|fortios|fortinet|palo alto|pan-os|sonicwall|watchguard|pfsense|opnsense|checkpoint|check point/.test(t))
      return TYPES.PARE_FEU;
    if (/\bios[- ]?xe\b|catalyst|procurve|aruba|\bswitch\b|powerconnect|ex\d{4}|nexus/.test(t))
      return TYPES.SWITCH;
    if (/routeros|mikrotik|\brouter\b|routeur|rv\d{3}|isr\d|edgerouter|draytek|vigor/.test(t))
      return TYPES.ROUTEUR;
    if (/unifi|ubiquiti|access point|wireless ap|\bwap\b/.test(t))
      return TYPES.SWITCH;
    if (/cisco ios|huawei|juniper|junos|d-link|tp-link|netgear|zyxel|extreme networks/.test(t))
      return TYPES.SWITCH; // constructeur réseau sans indice de produit plus précis
  }

  // ── Impression ────────────────────────────────────────────────────
  if (/laserjet|officejet|deskjet|jetdirect|\bnpi[0-9a-f]{6}\b|imprimante|\bprinter\b|print server|mfp|workcentre|imagerunner|bizhub|aficio|ecosys|phaser/.test(t))
    return TYPES.IMPRIMANTE;

  // ── Vidéosurveillance ─────────────────────────────────────────────
  if (/hikvision|dahua|axis (comm|q\d|p\d|m\d)|mobotix|\bipcam|network camera|\bnvr\b|\bdvr\b/.test(t))
    return TYPES.CAMERA;

  // ── Téléphonie ────────────────────────────────────────────────────
  if (/yealink|grandstream|polycom|\bsnom\b|\bvoip\b|sip phone|\bpbx\b|asterisk|aastra|gigaset/.test(t))
    return TYPES.TELEPHONIE;

  // ── Virtualisation et systèmes serveur ────────────────────────────
  if (/esxi|vmware|proxmox|hyper-v|xenserver|citrix hypervisor/.test(t))
    return TYPES.SERVEUR;

  // ── Windows : LE POINT CORRIGÉ ────────────────────────────────────
  //
  // L'ancienne règle donnait « serveur » dès que le texte contenait
  // « windows ». Acceptable tant que seul du matériel professionnel était
  // détecté, faux dès qu'on scanne un parc bureautique.
  //
  // Le sysDescr standard de Windows ne dit PAS s'il s'agit d'une édition
  // serveur ou poste : il donne la version NT (« Windows Version 6.3 »).
  // On ne conclut donc que sur des marqueurs explicites, généralement
  // apportés par nmap qui, lui, restitue le nom commercial.
  if (/windows server|windows nt server|win2k\d|windows 20(00|03|08|12|16|19|22|25)/.test(t))
    return TYPES.SERVEUR;
  if (/windows (xp|vista|7|8|8\.1|10|11)\b|windows nt workstation/.test(t))
    return TYPES.POSTE;
  if (/\bwindows\b/.test(t)) {
    // Version NT nue : indécidable. On ne devine pas.
    return null;
  }

  // ── macOS ─────────────────────────────────────────────────────────
  if (/mac ?os|macintosh|darwin/.test(t)) return TYPES.POSTE;

  // ── Unix / Linux ──────────────────────────────────────────────────
  //
  // Nuance selon la provenance : un agent SNMP installé sur une machine
  // Linux traduit une machine administrée — serveur ou appliance. La même
  // information venant de nmap ne dit rien : un poste, un téléphone
  // Android et un routeur domestique remontent tous « Linux ».
  if (/ubuntu|debian|centos|red ?hat|rhel|suse|fedora|freebsd|openbsd|solaris|\bunix\b/.test(t))
    return provenance === "snmp" ? TYPES.SERVEUR : null;
  if (/\blinux\b/.test(t)) return provenance === "snmp" ? TYPES.SERVEUR : null;

  return null;
}

/**
 * Traduit le vocabulaire « Device type » de nmap vers le nôtre.
 *
 * Toute valeur non reconnue renvoie null — et surtout PAS « detecte_nmap »,
 * qui est un nom de méthode et n'a rien à faire dans une colonne Type.
 */
const TYPES_NMAP = new Map([
  ["general purpose", null], // volontairement indécidable : poste OU serveur
  ["router", TYPES.ROUTEUR],
  ["broadband router", TYPES.ROUTEUR],
  ["bridge", TYPES.ROUTEUR],
  ["switch", TYPES.SWITCH],
  ["wap", TYPES.SWITCH],
  ["firewall", TYPES.PARE_FEU],
  ["printer", TYPES.IMPRIMANTE],
  ["print server", TYPES.IMPRIMANTE],
  ["webcam", TYPES.CAMERA],
  ["security-misc", TYPES.CAMERA],
  ["media device", null],
  ["voip phone", TYPES.TELEPHONIE],
  ["voip adapter", TYPES.TELEPHONIE],
  ["phone", TYPES.TELEPHONIE],
  ["pbx", TYPES.TELEPHONIE],
  ["storage-misc", TYPES.SERVEUR],
  ["specialized", null],
  ["power-device", null],
  ["terminal", null],
  ["remote management", null],
  ["game console", null],
  ["pda", null],
]);

function typeDepuisNmap(typeBrut) {
  if (!typeBrut) return null;
  // nmap peut renvoyer plusieurs types séparés par « | » : on prend le premier.
  const premier = String(typeBrut).split("|")[0].trim().toLowerCase();
  return TYPES_NMAP.has(premier) ? TYPES_NMAP.get(premier) : null;
}

/** Déduction par port ouvert, uniquement pour les ports mono-usage. */
function typeDepuisPorts(ports) {
  if (!Array.isArray(ports)) return null;
  for (const p of ports) {
    const numero = Number(typeof p === "object" ? p.port : p);
    if (PORTS_REVELATEURS.has(numero)) return PORTS_REVELATEURS.get(numero);
  }
  return null;
}

/**
 * Constructeurs dont toute la production relève d'un seul type.
 * Volontairement court : Realtek fabrique les cartes réseau de PC, de
 * téléviseurs et de routeurs — on n'en déduit rien. Hewlett-Packard
 * fabrique des imprimantes ET des serveurs ET des switches : rien non plus.
 */
const TYPE_PAR_FABRICANT = new Map([
  ["Axis Communications", TYPES.CAMERA],
  ["Axis", TYPES.CAMERA],
  ["Hikvision", TYPES.CAMERA],
  ["Dahua", TYPES.CAMERA],
  ["Mobotix", TYPES.CAMERA],
  ["Zebra Technologies", TYPES.IMPRIMANTE],
  ["Zebra", TYPES.IMPRIMANTE],
  ["Brother Industries", TYPES.IMPRIMANTE],
  ["Brother", TYPES.IMPRIMANTE],
  ["Lexmark International", TYPES.IMPRIMANTE],
  ["Lexmark", TYPES.IMPRIMANTE],
  ["Kyocera Document Solutions", TYPES.IMPRIMANTE],
  ["Kyocera", TYPES.IMPRIMANTE],
  ["Yealink", TYPES.TELEPHONIE],
  ["Yealink(Xiamen) Network Technology", TYPES.TELEPHONIE],
  ["Grandstream Networks", TYPES.TELEPHONIE],
  ["Grandstream", TYPES.TELEPHONIE],
  ["Snom Technology", TYPES.TELEPHONIE],
  ["Polycom", TYPES.TELEPHONIE],
  ["VMware", TYPES.SERVEUR],
  ["Synology", TYPES.SERVEUR],
  ["QNAP Systems", TYPES.SERVEUR],
  ["Fortinet", TYPES.PARE_FEU],
  ["Ubiquiti", TYPES.SWITCH],
  ["MikroTik", TYPES.ROUTEUR],
]);

/**
 * Nettoie un nom de fabricant pour la comparaison.
 *
 * Le registre IEEE écrit les raisons sociales complètes :
 * « Hangzhou Hikvision Digital Technology Co.,Ltd. ». Notre table, elle,
 * liste des marques : « Hikvision ». Une comparaison stricte ne trouve
 * donc jamais rien.
 */
function normaliserFabricant(nom) {
  return String(nom)
    .toLowerCase()
    // Accents : « Kyocera » et « Kyōcera » doivent se rejoindre.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Ponctuation et esperluettes -> espaces, pour que « Co.,Ltd. » ne
    // reste pas collé au nom de la marque.
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Formes juridiques et mots de remplissage, retirés avant comparaison.
 *
 * Sans cela, « Brother Industries Ltd » ne correspondrait pas à
 * « Brother » — et surtout, un mot générique comme « technology »
 * pourrait provoquer une correspondance entre deux marques sans rapport.
 */
const MOTS_VIDES = new Set([
  "co", "ltd", "limited", "inc", "incorporated", "corp", "corporation",
  "gmbh", "sa", "sas", "ag", "ab", "bv", "nv", "plc", "llc", "lp",
  "company", "group", "holdings", "international", "technologies",
  "technology", "tech", "systems", "system", "solutions", "electronics",
  "electronic", "digital", "networks", "network", "communications",
  "communication", "industries", "industry", "products", "device",
  "devices", "computer", "computers", "the", "and", "of",
]);

/**
 * Déduit un type à partir du nom du fabricant.
 *
 * Cette règle ne s'est jamais déclenchée avant le 22/08/2026 : elle
 * faisait une correspondance EXACTE, or le registre IEEE écrit
 * « Hangzhou Hikvision Digital Technology Co.,Ltd. » là où la table dit
 * « Hikvision ». Aucune clé ne correspondait, jamais. Sur un parc réel,
 * 44 équipements étaient classés « inconnu » — caméras et imprimantes
 * comprises — et le reclassement annonçait « 0 type corrigé sur 44 », ce
 * qui donnait l'impression qu'il n'y avait rien à corriger.
 *
 * On compare désormais sur les mots significatifs du nom, formes
 * juridiques retirées. La correspondance porte sur un mot entier et
 * jamais sur un fragment : sinon « Praxis Systems » deviendrait une
 * caméra à cause de « axis ». Cette règle reste la dernière consultée.
 */
function typeDepuisFabricant(fabricant) {
  if (!fabricant) return null;

  // Correspondance exacte d'abord : la moins coûteuse et la plus sûre.
  const direct = TYPE_PAR_FABRICANT.get(fabricant);
  if (direct) return direct;

  const mots = new Set(
    normaliserFabricant(fabricant)
      .split(" ")
      .filter((m) => m && !MOTS_VIDES.has(m))
  );
  if (mots.size === 0) return null;

  for (const [marque, type] of TYPE_PAR_FABRICANT) {
    const motsMarque = normaliserFabricant(marque)
      .split(" ")
      .filter((m) => m && !MOTS_VIDES.has(m));

    // Une marque réduite à des mots vides (« Systems ») ne doit jamais
    // servir de critère.
    if (motsMarque.length === 0) continue;

    // Tous les mots significatifs de la marque doivent être présents.
    // « Konica Minolta » ne correspond donc pas à un fabricant qui ne
    // contient que « Minolta ».
    if (motsMarque.every((m) => mots.has(m))) return type;
  }
  return null;
}

/**
 * Décide de la catégorie d'un équipement.
 *
 * ORDRE DE CONFIANCE, du plus sûr au moins sûr :
 *
 *   1. Texte SNMP — l'équipement se décrit lui-même.
 *   2. Port révélateur — un port 9100 ouvert, c'est une imprimante ;
 *      aucune interprétation possible.
 *   3. « Device type » de nmap — analyse de la pile réseau.
 *   4. OS détecté par nmap — nom commercial du système.
 *   5. Fabricant (OUI) — seulement pour les constructeurs mono-produit.
 *
 * Le port passe AVANT nmap parce qu'il est factuel : nmap déduit, le port
 * constate. Une imprimante qui répond « general purpose » à nmap mais
 * expose 9100 est une imprimante.
 *
 * @returns {{type:string, source:string}} `source` sert au diagnostic et
 *          n'est pas stocké : la colonne Type ne doit contenir qu'une
 *          catégorie.
 */
function determinerType({
  sysDescr = null,
  sysName = null,
  osDetecte = null,
  nmapDeviceType = null,
  ports = null,
  fabricant = null,
} = {}) {
  const texteSnmp = [sysDescr, sysName].filter(Boolean).join(" ");

  const parSnmp = typeDepuisTexte(texteSnmp, "snmp");
  if (parSnmp) return { type: parSnmp, source: "snmp" };

  const parPort = typeDepuisPorts(ports);
  if (parPort) return { type: parPort, source: "port" };

  const parNmapType = typeDepuisNmap(nmapDeviceType);
  if (parNmapType) return { type: parNmapType, source: "nmap_device" };

  const parNmapOs = typeDepuisTexte(osDetecte, "nmap");
  if (parNmapOs) return { type: parNmapOs, source: "nmap_os" };

  const parFabricant = typeDepuisFabricant(fabricant);
  if (parFabricant) return { type: parFabricant, source: "fabricant" };

  // Aucun signal exploitable. On ne devine pas.
  return { type: TYPES.INCONNU, source: "aucune" };
}

module.exports = {
  TYPES,
  TOUS_LES_TYPES,
  PORTS_REVELATEURS,
  determinerType,
  typeDepuisTexte,
  typeDepuisNmap,
  typeDepuisPorts,
  typeDepuisFabricant,
};
