/**
 * nomService.js
 * Résolution du nom d'une machine, par sources successives.
 *
 * La quasi-totalité des postes Windows n'expose pas SNMP : sans autre
 * source, la colonne « nom » reste vide sur la majeure partie du parc, et
 * une liste d'adresses IP ne dit à personne de quelle machine il s'agit.
 *
 * Quatre sources, par ordre de confiance :
 *
 *   1. sysName SNMP — le nom que la machine se donne. Le plus fiable,
 *      rarement disponible hors équipements réseau.
 *   2. DNS inverse — suppose que le DHCP enregistre ses baux auprès du
 *      DNS : la norme sur un domaine Active Directory, l'exception
 *      derrière une box d'opérateur.
 *   3. NetBIOS — un poste Windows répond sur le port 137 même sans
 *      domaine, sans DNS interne et sans SNMP.
 *   4. mDNS — seule source pour ce qui n'est ni poste Windows ni
 *      équipement SNMP : caméras, imprimantes, appareils Apple et
 *      Android.
 *
 * Aucune source n'invente : si les quatre échouent, le nom reste vide.
 * Une case vide est honnête, un nom faux ne l'est pas.
 */
const dgram = require("dgram");
const dns = require("dns").promises;

const PORT_NETBIOS = 137;
const PORT_MDNS = 5353;
const DELAI_DNS = 1500;
const DELAI_NETBIOS = 1200;
const DELAI_MDNS = 1200;

/**
 * Encodage des noms NetBIOS (RFC 1001, « first level encoding »).
 *
 * Chaque octet du nom est coupé en deux quartets, et chaque quartet est
 * additionné à 'A'. Le nom est d'abord complété à 16 octets. Un octet
 * devient donc deux lettres, et les 16 octets deviennent 32 lettres.
 *
 * Pour une requête d'état de nœud, le nom demandé est « * » suivi de 15
 * octets nuls — ce qui donne toujours « CKAAAA…AA ».
 */
function encoderNomNetbios(nom) {
  const brut = Buffer.alloc(16, 0);
  Buffer.from(nom, "ascii").copy(brut, 0, 0, Math.min(nom.length, 16));

  const encode = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    encode[i * 2] = 0x41 + (brut[i] >> 4);
    encode[i * 2 + 1] = 0x41 + (brut[i] & 0x0f);
  }
  return encode;
}

/** Requête NBSTAT : « quels noms portes-tu ? » */
function construireRequeteNetbios() {
  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(0x4e53, 0); // identifiant de transaction, arbitraire
  entete.writeUInt16BE(0x0000, 2); // pas de récursion demandée
  entete.writeUInt16BE(0x0001, 4); // une question
  // Le reste de l'en-tête (réponses, autorité, additionnel) reste à zéro.

  const nom = encoderNomNetbios("*");
  const question = Buffer.concat([
    Buffer.from([nom.length]), // longueur de l'étiquette : 32
    nom,
    Buffer.from([0x00]), // fin du nom
    Buffer.from([0x00, 0x21]), // type NBSTAT
    Buffer.from([0x00, 0x01]), // classe IN
  ]);

  return Buffer.concat([entete, question]);
}

/**
 * Extrait le nom de machine de la réponse NBSTAT.
 *
 * La réponse répète la question, puis liste les noms enregistrés. On
 * cherche celui dont le suffixe vaut 0x00 (service station de travail)
 * et qui est unique — le drapeau de groupe distingue le nom de la
 * machine de celui du domaine ou du groupe de travail, qui apparaissent
 * dans la même liste et se ressembleraient sinon.
 */
/**
 * Avance jusqu'après un nom encodé, quelle que soit sa forme.
 *
 * Un nom est une suite d'étiquettes préfixées par leur longueur et
 * terminée par un octet nul. Il peut aussi être remplacé par un
 * pointeur de compression (deux bits de poids fort à 1), qui tient sur
 * deux octets au lieu de trente-quatre.
 */
function sauterNom(tampon, position) {
  while (position < tampon.length) {
    const longueur = tampon[position];
    if (longueur === 0) return position + 1;
    if ((longueur & 0xc0) === 0xc0) return position + 2; // pointeur
    position += 1 + longueur;
  }
  return position;
}

/**
 * Extrait le nom de machine de la réponse NBSTAT.
 *
 * CE QUI N'ALLAIT PAS. La première version calculait la position des
 * données par une addition d'octets supposés. Elle renvoyait
 * « SKTOP-A89OVC3 » là où la machine s'appelle « DESKTOP-A89OVC3 » :
 * deux caractères mangés, sans que rien ne signale l'erreur — un nom
 * tronqué reste un nom d'apparence plausible.
 *
 * La cause : toutes les piles NetBIOS ne répètent pas la question dans
 * leur réponse, et certaines compressent le nom sur deux octets au lieu
 * de trente-quatre. Aucun décalage fixe ne peut donc être juste pour
 * tout le monde.
 *
 * On lit désormais la structure réelle : le nombre de questions et de
 * réponses est déclaré dans l'en-tête, et chaque nom est franchi selon
 * sa forme effective.
 */
function extraireNomNetbios(reponse) {
  if (!reponse || reponse.length < 12) return null;

  const nbQuestions = reponse.readUInt16BE(4);
  const nbReponses = reponse.readUInt16BE(6);
  if (nbReponses < 1) return null;

  let position = 12;

  // Question éventuellement répétée : nom, puis type et classe.
  for (let i = 0; i < nbQuestions; i++) {
    position = sauterNom(reponse, position);
    position += 4;
  }

  // Enregistrement de réponse : nom, type, classe, durée de vie,
  // longueur des données.
  position = sauterNom(reponse, position);
  position += 2 + 2 + 4; // type, classe, durée de vie
  if (position + 2 > reponse.length) return null;
  position += 2; // longueur des données

  if (position >= reponse.length) return null;
  const nombreDeNoms = reponse[position];
  position += 1;

  for (let i = 0; i < nombreDeNoms; i++) {
    // Chaque entrée : 15 octets de nom, 1 de suffixe, 2 de drapeaux.
    if (position + 18 > reponse.length) break;

    const nom = reponse
      .toString("ascii", position, position + 15)
      .replace(/\0/g, "")
      .trim();
    const suffixe = reponse[position + 15];
    const drapeaux = reponse.readUInt16BE(position + 16);
    const estGroupe = (drapeaux & 0x8000) !== 0;

    if (suffixe === 0x00 && !estGroupe && nom) return nom;

    position += 18;
  }
  return null;
}

/**
 * Interroge le service de noms NetBIOS d'une machine.
 * Renvoie null en cas d'échec — le cas le plus fréquent est le pare-feu
 * du poste, ce qui n'a rien d'anormal et ne mérite pas de journal.
 */
function nomNetbios(ip) {
  return new Promise((resoudre) => {
    let termine = false;
    const socket = dgram.createSocket("udp4");

    const finir = (valeur) => {
      if (termine) return;
      termine = true;
      clearTimeout(minuterie);
      try {
        socket.close();
      } catch {
        /* déjà fermée */
      }
      resoudre(valeur);
    };

    const minuterie = setTimeout(() => finir(null), DELAI_NETBIOS);

    socket.on("message", (message) => {
      try {
        finir(extraireNomNetbios(message));
      } catch {
        finir(null);
      }
    });

    socket.on("error", () => finir(null));

    try {
      const requete = construireRequeteNetbios();
      socket.send(requete, 0, requete.length, PORT_NETBIOS, ip, (err) => {
        if (err) finir(null);
      });
    } catch {
      finir(null);
    }
  });
}

/* =====================================================================
   mDNS — RFC 6762

   Le mDNS est du DNS ordinaire diffusé sur le réseau local, sans
   serveur : on demande à la cantonade « qui est 192.168.0.18 ? » et
   l'appareil concerné répond lui-même.

   On interroge l'adresse directement plutôt que le groupe de diffusion
   224.0.0.251 : une requête ciblée ne réveille qu'une machine, et sa
   réponse arrive sans qu'on ait à trier celles de tout le réseau.
   ===================================================================== */

/** Encode un nom DNS : « 18.0.168.192.in-addr.arpa » → étiquettes préfixées. */
function encoderNomDns(nom) {
  const morceaux = [];
  for (const etiquette of nom.split(".")) {
    if (!etiquette) continue;
    const octets = Buffer.from(etiquette, "ascii");
    morceaux.push(Buffer.from([octets.length]), octets);
  }
  morceaux.push(Buffer.from([0x00]));
  return Buffer.concat(morceaux);
}

/** « 192.168.0.18 » → « 18.0.168.192.in-addr.arpa » */
function nomInverse(ip) {
  return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
}

/**
 * Requête PTR : « quel nom porte cette adresse ? »
 *
 * LE BIT QU (RFC 6762 §5.4). Le bit de poids fort de la classe demande
 * une réponse en point à point plutôt qu'en diffusion. Sans lui, un
 * appareil conforme répond sur le groupe de diffusion 224.0.0.251 — et
 * notre socket, lié à un port éphémère, ne l'entend jamais.
 *
 * C'est exactement ce qui faisait échouer la première version : la
 * requête partait, l'appareil répondait, mais à une adresse que nous
 * n'écoutions pas. Un silence indiscernable d'une absence de réponse.
 */
function construireRequeteMdns(ip) {
  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(0x0000, 0); // le mDNS veut un identifiant nul
  entete.writeUInt16BE(0x0000, 2); // pas de récursion
  entete.writeUInt16BE(0x0001, 4); // une question

  const classe = Buffer.alloc(2);
  classe.writeUInt16BE(0x8001, 0); // bit QU + classe IN

  return Buffer.concat([
    entete,
    encoderNomDns(nomInverse(ip)),
    Buffer.from([0x00, 0x0c]), // type PTR
    classe,
  ]);
}

/**
 * Lit un nom DNS à une position donnée, en suivant les pointeurs de
 * compression. Le compteur de sauts empêche une réponse malveillante ou
 * corrompue de faire boucler la lecture indéfiniment sur elle-même.
 */
function lireNomDns(tampon, position, sautsRestants = 10) {
  const etiquettes = [];
  while (position < tampon.length) {
    const longueur = tampon[position];
    if (longueur === 0) break;
    if ((longueur & 0xc0) === 0xc0) {
      if (sautsRestants <= 0 || position + 1 >= tampon.length) break;
      const cible = ((longueur & 0x3f) << 8) | tampon[position + 1];
      const suite = lireNomDns(tampon, cible, sautsRestants - 1);
      if (suite) etiquettes.push(suite);
      break;
    }
    if (position + 1 + longueur > tampon.length) break;
    etiquettes.push(tampon.toString("utf8", position + 1, position + 1 + longueur));
    position += 1 + longueur;
  }
  return etiquettes.join(".");
}

/**
 * Un nom mDNS est-il celui d'un APPAREIL, et non autre chose ?
 *
 * CE QUI N'ALLAIT PAS. Le mDNS annonce deux catégories de noms dans les
 * mêmes enregistrements : les appareils (« CAMERA-ENTREE.local ») et
 * les services qu'ils rendent (« _printer._tcp.local »). Sans tri, la
 * liste d'équipements se serait remplie de « _printer », « _http »,
 * « _ipps » — des types de service présentés comme des noms de machine.
 *
 * C'est la même faute que le nom hérité de nmap : une donnée réelle,
 * mais rangée dans un champ qui n'est pas le sien. Elle est d'autant
 * plus trompeuse ici qu'elle a l'air d'un nom.
 *
 * Trois familles sont donc écartées :
 *   • les types de service, reconnaissables au tiret bas initial ;
 *   • les noms de résolution inverse, qui ne sont que l'adresse ;
 *   • les noms vides après nettoyage.
 */
function estNomDappareil(nom) {
  if (!nom) return false;
  const propre = String(nom).trim();
  if (!propre) return false;
  if (propre.startsWith("_")) return false; // type de service
  if (/\.arpa\.?$/i.test(propre)) return false; // résolution inverse
  if (/^_/.test(propre.split(".")[0])) return false;
  return true;
}

/**
 * Extrait le nom d'hôte d'une réponse mDNS.
 *
 * On accepte les réponses PTR (le nom demandé) comme les enregistrements
 * A ou AAAA que certains appareils joignent spontanément — c'est
 * fréquent, et le nom y figure aussi. Les types de service sont écartés
 * (voir estNomDappareil).
 */
function extraireNomMdns(reponse) {
  if (!reponse || reponse.length < 12) return null;

  const nbQuestions = reponse.readUInt16BE(4);
  const nbReponses = reponse.readUInt16BE(6);
  if (nbReponses < 1) return null;

  let position = 12;
  for (let i = 0; i < nbQuestions; i++) {
    position = sauterNom(reponse, position);
    position += 4;
  }

  for (let i = 0; i < nbReponses; i++) {
    if (position >= reponse.length) break;

    const nomEnregistrement = lireNomDns(reponse, position);
    position = sauterNom(reponse, position);
    if (position + 10 > reponse.length) break;

    const type = reponse.readUInt16BE(position);
    const longueurDonnees = reponse.readUInt16BE(position + 8);
    const debutDonnees = position + 10;
    if (debutDonnees + longueurDonnees > reponse.length) break;

    let candidat = null;
    if (type === 0x000c) {
      candidat = lireNomDns(reponse, debutDonnees); // PTR : le nom est la donnée
    } else if (type === 0x0001 || type === 0x001c) {
      candidat = nomEnregistrement; // A / AAAA : le nom est celui de l'enregistrement
    }

    if (estNomDappareil(candidat)) {
      // Le suffixe « .local » est retiré comme l'est un domaine : dans
      // une liste où tout le monde le porte, il ne distingue rien.
      const court = candidat.replace(/\.local\.?$/i, "").split(".")[0].trim();
      // Un second contrôle après découpage : « PC._sub.local » passe le
      // premier filtre mais peut se réduire à une étiquette de service.
      if (court && estNomDappareil(court)) return court;
    }

    position = debutDonnees + longueurDonnees;
  }
  return null;
}

/**
 * Interroge un appareil en mDNS.
 *
 * Le socket est lié à un port éphémère plutôt qu'au port 5353 : ce
 * dernier est très souvent déjà occupé — par Bonjour sous Windows,
 * avahi-daemon sous Linux — et s'y lier ferait échouer la résolution
 * sur les machines où ce service tourne, c'est-à-dire beaucoup.
 */
function nomMdns(ip) {
  return new Promise((resoudre) => {
    let termine = false;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    const finir = (valeur) => {
      if (termine) return;
      termine = true;
      clearTimeout(minuterie);
      try {
        socket.close();
      } catch {
        /* déjà fermée */
      }
      resoudre(valeur);
    };

    const minuterie = setTimeout(() => finir(null), DELAI_MDNS);

    socket.on("message", (message) => {
      try {
        const nom = extraireNomMdns(message);
        if (nom) finir(nom);
        // Une réponse sans nom exploitable n'est pas une raison
        // d'abandonner : d'autres peuvent suivre avant le délai.
      } catch {
        /* réponse illisible, on attend la suivante */
      }
    });

    socket.on("error", () => finir(null));

    try {
      const requete = construireRequeteMdns(ip);
      socket.send(requete, 0, requete.length, PORT_MDNS, ip, (err) => {
        if (err) finir(null);
      });
    } catch {
      finir(null);
    }
  });
}

/**
 * Nom par résolution DNS inverse.
 * Le suffixe de domaine est retiré : dans une liste où toutes les
 * machines partagent le même domaine, il n'ajoute rien et consomme la
 * largeur de colonne.
 */
async function nomDns(ip) {
  try {
    const noms = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rejeter) => setTimeout(() => rejeter(new Error("délai")), DELAI_DNS)),
    ]);
    if (!noms || noms.length === 0) return null;
    const nom = String(noms[0]).trim();
    if (!nom || nom === ip) return null;
    return nom.split(".")[0] || null;
  } catch {
    return null;
  }
}

/**
 * Nom d'une machine, par ordre de confiance décroissant.
 *
 * Les trois méthodes réseau sont lancées EN PARALLÈLE, et non l'une
 * après l'autre : chacune a son propre délai d'attente, et sur un parc
 * de plusieurs centaines de machines dont beaucoup ne répondront à
 * aucune, les enchaîner tripleraient la durée du scan pour rien.
 *
 * L'ordre de préférence s'applique aux RÉSULTATS, pas aux appels : on
 * interroge tout le monde en même temps, puis on retient la meilleure
 * réponse obtenue.
 */
async function resoudreNom(ip, sysName) {
  const snmp = sysName ? String(sysName).trim() : null;
  if (snmp) return { nom: snmp, source: "snmp" };

  const [dns, netbios, mdns] = await Promise.all([
    nomDns(ip),
    nomNetbios(ip),
    nomMdns(ip),
  ]);

  return choisirNom({ snmp, dns, netbios, mdns });
}

/**
 * Départage les réponses obtenues. Fonction PURE : aucune entrée-sortie,
 * donc entièrement vérifiable par des tests.
 *
 * La séparer de resoudreNom n'est pas de la coquetterie : la règle
 * d'arbitrage est la partie qui peut se tromper silencieusement, et
 * c'est précisément celle qu'on ne peut pas tester tant qu'elle est
 * mêlée à des appels réseau.
 */
function choisirNom({ snmp = null, dns = null, netbios = null, mdns = null } = {}) {
  const propre = (v) => {
    const t = v ? String(v).trim() : "";
    return t || null;
  };
  const parSnmp = propre(snmp);
  const parDns = propre(dns);
  const parNetbios = propre(netbios);
  const parMdns = propre(mdns);

  if (parSnmp) return { nom: parSnmp, source: "snmp" };

  // Un nom enregistré au DNS a été posé par l'administrateur du réseau :
  // il porte une intention, là où les autres sont auto-générés.
  if (parDns) return { nom: parDns, source: "dns" };

  // NetBIOS plafonne à 15 caractères — c'est une limite du protocole,
  // pas de l'appareil. Quand le mDNS renvoie un nom PLUS LONG dont le
  // NetBIOS est le début, on tient la version complète du même nom :
  // aucune raison de garder la version amputée.
  //
  // Constaté sur le parc : NetBIOS « HP694AA2 » là où le mDNS annonçait
  // « HPA8B13B694AA2 » pour la même imprimante. La condition de préfixe
  // garde ce remplacement sûr — deux noms différents ne se substituent
  // jamais l'un à l'autre.
  if (parNetbios && parMdns) {
    const court = parNetbios.toLowerCase();
    const long = parMdns.toLowerCase();
    if (long.length > court.length && long.startsWith(court)) {
      return { nom: parMdns, source: "mdns" };
    }
  }

  if (parNetbios) return { nom: parNetbios, source: "netbios" };
  if (parMdns) return { nom: parMdns, source: "mdns" };
  return { nom: null, source: null };
}

module.exports = {
  resoudreNom,
  choisirNom,
  nomDns,
  nomNetbios,
  nomMdns,
  // Exportés pour les tests : ces encodages binaires sont le genre de
  // code qu'on ne peut pas vérifier à l'œil.
  encoderNomNetbios,
  construireRequeteNetbios,
  extraireNomNetbios,
  encoderNomDns,
  nomInverse,
  construireRequeteMdns,
  extraireNomMdns,
  estNomDappareil,
  lireNomDns,
  sauterNom,
};
