/**
 * nomService.js
 * Résolution du nom d'une machine, par sources successives.
 *
 * La quasi-totalité des postes Windows n'expose pas SNMP : sans autre
 * source, la colonne « nom » reste vide sur la majeure partie du parc, et
 * une liste d'adresses IP ne dit à personne de quelle machine il s'agit.
 *
 * Cinq sources, par ordre de confiance :
 *
 *   1. sysName SNMP — le nom que la machine se donne. Le plus fiable,
 *      rarement disponible hors équipements réseau.
 *   2. DNS inverse — suppose que le DHCP enregistre ses baux auprès du
 *      DNS : la norme sur un domaine Active Directory, l'exception
 *      derrière une box d'opérateur.
 *   3. SMB — le nom annoncé par le partage de fichiers Windows pendant
 *      la négociation, avant toute authentification. Ajoutée en dernier,
 *      et seule source qui atteigne un poste où NetBIOS est désactivé.
 *      Voir le grand commentaire plus bas : elle n'est sollicitée que si
 *      le port 445 a déjà été trouvé ouvert.
 *   4. NetBIOS — un poste Windows répond sur le port 137 même sans
 *      domaine, sans DNS interne et sans SNMP.
 *   5. mDNS — seule source pour ce qui n'est ni poste Windows ni
 *      équipement SNMP : caméras, imprimantes, appareils Apple et
 *      Android.
 *
 * Aucune source n'invente : si les cinq échouent, le nom reste vide.
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

/* ═══════════════════════════════════════════════════════════════════════
   CINQUIÈME SOURCE : LE PARTAGE DE FICHIERS WINDOWS (SMB, PORT 445)

   POURQUOI ELLE A ÉTÉ AJOUTÉE. Mesuré sur le parc : 92 équipements, 67
   sans nom. Le DNS inverse ne donne RIEN — la box n'enregistre pas ses
   baux — NetBIOS nomme 20 machines, mDNS 3, SNMP 2. Les quatre sources
   existantes ont donné tout ce qu'elles pouvaient.

   Or ces mêmes postes muets ont massivement le port 445 ouvert — c'est
   d'ailleurs à cela qu'on les repère. Et pendant la négociation d'une
   connexion SMB, AVANT toute authentification, le serveur annonce
   lui-même son nom d'ordinateur et son domaine. C'est ce que lit
   `nmap --script smb-os-discovery`.

   COMMENT ÇA MARCHE, EN TROIS TEMPS.

     1. on ouvre une connexion et on propose les dialectes SMB2 ;
     2. on demande l'ouverture de session en présentant un jeton NTLM de
        type 1 — une simple annonce « voici ce que je sais faire », sans
        nom d'utilisateur ni mot de passe ;
     3. le serveur répond « il m'en faut plus » et joint un jeton NTLM de
        type 2. C'est ce jeton qui contient, en clair, le nom NetBIOS et
        le nom DNS de la machine.

   ON S'ARRÊTE LÀ. Aucune identification n'est tentée, aucun partage
   n'est ouvert, la connexion est refermée aussitôt. Ce qu'on lit est ce
   que la machine annonce à quiconque frappe à sa porte.

   CE QUE ÇA COÛTE, ET POURQUOI C'EST BORNÉ. Une connexion TCP laisse une
   trace dans les journaux du poste, là où NetBIOS et mDNS sont de
   simples questions en UDP. La sonde n'est donc lancée QUE sur les
   machines dont le port 445 a déjà été trouvé ouvert — voir le paramètre
   `smb` de resoudreNom, renseigné par le balayage. Sur tout le reste,
   rien n'est envoyé.
   ═══════════════════════════════════════════════════════════════════════ */

const net = require("net");
const PORT_SMB = 445;
const DELAI_SMB = 1500;

/** En-tête de session NetBIOS : un zéro, puis la longueur sur 3 octets. */
function enteteSession(longueur) {
  const b = Buffer.alloc(4);
  b[0] = 0x00;
  b.writeUIntBE(longueur, 1, 3);
  return b;
}

/** En-tête SMB2, 64 octets, tel que l'attend un serveur Windows. */
function enteteSmb2(commande, messageId) {
  const h = Buffer.alloc(64);
  h[0] = 0xfe;
  h.write("SMB", 1, "ascii");
  h.writeUInt16LE(64, 4); // StructureSize
  h.writeUInt16LE(0, 6); // CreditCharge
  h.writeUInt32LE(0, 8); // Status / ChannelSequence
  h.writeUInt16LE(commande, 12);
  h.writeUInt16LE(31, 14); // CreditRequest
  h.writeUInt32LE(0, 16); // Flags — c'est une requête, pas une réponse
  h.writeUInt32LE(0, 20); // NextCommand
  h.writeUInt32LE(messageId, 24); // MessageId : 64 bits, le poids faible suffit
  return h;
}

/** NEGOTIATE : « voici les dialectes que je parle ». */
function requeteNegociation() {
  const corps = Buffer.alloc(36 + 8);
  corps.writeUInt16LE(36, 0); // StructureSize
  corps.writeUInt16LE(4, 2); // DialectCount
  corps.writeUInt16LE(1, 4); // SecurityMode : signature activée
  corps.writeUInt32LE(0, 8); // Capabilities
  // ClientGuid (16 octets) laissé à zéro : il identifie un logiciel
  // client, pas une personne, et aucun serveur n'en exige un précis.
  corps.writeUInt16LE(0x0202, 36);
  corps.writeUInt16LE(0x0210, 38);
  corps.writeUInt16LE(0x0300, 40);
  // 3.1.1 (0x0311) est délibérément ABSENT : ce dialecte impose des
  // « contextes de négociation » supplémentaires, donc tout un préambule
  // à implémenter, pour exactement la même information au bout.
  corps.writeUInt16LE(0x0302, 42);

  const paquet = Buffer.concat([enteteSmb2(0x0000, 1), corps]);
  return Buffer.concat([enteteSession(paquet.length), paquet]);
}

/** Encodage DER : une étiquette, une longueur courte, un contenu. */
function der(etiquette, contenu) {
  return Buffer.concat([Buffer.from([etiquette, contenu.length]), contenu]);
}

/**
 * Jeton NTLM de type 1 — une annonce de capacités, rien d'autre.
 * Le drapeau REQUEST_TARGET (0x4) est celui qui compte : c'est lui qui
 * demande au serveur de joindre ses noms à sa réponse.
 */
function jetonNtlmType1() {
  const t = Buffer.alloc(32);
  t.write("NTLMSSP\0", 0, "binary");
  t.writeUInt32LE(1, 8); // type 1 : NEGOTIATE
  t.writeUInt32LE(0xa0088207, 12); // UNICODE|OEM|REQUEST_TARGET|NTLM|SIGN|ESS|128|56
  return t;
}

/** Le jeton NTLM, emballé dans un GSS-API/SPNEGO NegTokenInit. */
function jetonSpnego() {
  const OID_NTLM = Buffer.from([
    0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x02, 0x0a,
  ]);
  const OID_SPNEGO = Buffer.from([0x06, 0x06, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x02]);

  const mechTypes = der(0xa0, der(0x30, OID_NTLM));
  const mechToken = der(0xa2, der(0x04, jetonNtlmType1()));
  const negTokenInit = der(0xa0, der(0x30, Buffer.concat([mechTypes, mechToken])));

  return der(0x60, Buffer.concat([OID_SPNEGO, negTokenInit]));
}

/** SESSION_SETUP : « ouvrons une session », avec le jeton ci-dessus. */
function requeteOuvertureSession() {
  const jeton = jetonSpnego();
  const corps = Buffer.alloc(24);
  corps.writeUInt16LE(25, 0); // StructureSize
  corps.writeUInt8(0, 2); // Flags
  corps.writeUInt8(1, 3); // SecurityMode
  corps.writeUInt32LE(0, 4); // Capabilities
  corps.writeUInt32LE(0, 8); // Channel
  corps.writeUInt16LE(64 + 24, 12); // SecurityBufferOffset, depuis l'en-tête
  corps.writeUInt16LE(jeton.length, 14); // SecurityBufferLength

  const paquet = Buffer.concat([enteteSmb2(0x0001, 2), corps, jeton]);
  return Buffer.concat([enteteSession(paquet.length), paquet]);
}

/**
 * Extrait le nom de machine d'un jeton NTLM de type 2.
 *
 * Le jeton porte une liste de paires « identifiant / valeur » où chaque
 * nom est écrit en UTF-16. On retient le nom DNS s'il existe — c'est le
 * nom complet — et à défaut le nom NetBIOS, que le protocole limite à
 * 15 caractères.
 *
 * Fonction PURE : elle se vérifie sur un jeton fabriqué, sans réseau.
 */
function extraireNomSmb(tampon) {
  const debut = tampon.indexOf("NTLMSSP\0", 0, "binary");
  if (debut < 0 || debut + 48 > tampon.length) return null;
  if (tampon.readUInt32LE(debut + 8) !== 2) return null; // pas un type 2

  const longueurInfos = tampon.readUInt16LE(debut + 40);
  const decalageInfos = tampon.readUInt32LE(debut + 44);
  const depart = debut + decalageInfos;
  if (longueurInfos <= 0 || depart + longueurInfos > tampon.length) return null;

  let parNetbios = null;
  let parDns = null;
  let p = depart;
  const fin = depart + longueurInfos;

  while (p + 4 <= fin) {
    const identifiant = tampon.readUInt16LE(p);
    const longueur = tampon.readUInt16LE(p + 2);
    p += 4;
    if (identifiant === 0 || p + longueur > fin) break; // 0 = fin de liste

    if (identifiant === 1 || identifiant === 3) {
      const valeur = tampon.toString("utf16le", p, p + longueur).trim();
      if (valeur) {
        if (identifiant === 1) parNetbios = valeur;
        else parDns = valeur;
      }
    }
    p += longueur;
  }

  /* Le nom DNS est complet, le NetBIOS est tronqué : on préfère le
     premier. On ne garde que sa première étiquette, pour rester cohérent
     avec les autres sources — « PC-COMPTA », pas
     « PC-COMPTA.societe.local ». */
  const retenu = parDns || parNetbios;
  return retenu ? retenu.split(".")[0] : null;
}

/**
 * Demande son nom à une machine par SMB. Ne lève jamais, ne tente aucune
 * authentification, referme la connexion dès la réponse obtenue.
 */
function nomSmb(ip) {
  return new Promise((resoudre) => {
    let termine = false;
    let recu = Buffer.alloc(0);
    let negocie = false;

    const socket = new net.Socket();

    const finir = (valeur) => {
      if (termine) return;
      termine = true;
      clearTimeout(minuterie);
      try {
        socket.destroy();
      } catch {
        /* déjà fermée */
      }
      resoudre(valeur);
    };

    const minuterie = setTimeout(() => finir(null), DELAI_SMB);

    socket.on("error", () => finir(null));
    socket.on("close", () => finir(null));
    socket.setTimeout(DELAI_SMB);
    socket.on("timeout", () => finir(null));

    socket.on("data", (morceau) => {
      recu = Buffer.concat([recu, morceau]);

      /* Les messages SMB sont préfixés de leur longueur : on n'agit
         qu'une fois le message COMPLET arrivé. Réagir au premier paquet
         TCP marcherait neuf fois sur dix et échouerait la dixième, sur un
         réseau chargé — le genre de défaut qu'on ne reproduit jamais. */
      while (recu.length >= 4) {
        const longueur = recu.readUIntBE(1, 3);
        if (recu.length < 4 + longueur) return;

        const message = recu.subarray(4, 4 + longueur);
        recu = recu.subarray(4 + longueur);

        if (!negocie) {
          negocie = true;
          try {
            socket.write(requeteOuvertureSession());
          } catch {
            return finir(null);
          }
        } else {
          return finir(extraireNomSmb(message));
        }
      }
    });

    socket.connect(PORT_SMB, ip, () => {
      try {
        socket.write(requeteNegociation());
      } catch {
        finir(null);
      }
    });
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
async function resoudreNom(ip, sysName, options = {}) {
  const snmp = sysName ? String(sysName).trim() : null;
  if (snmp) return { nom: snmp, source: "snmp" };

  /* La sonde SMB n'est lancée que si l'appelant a constaté le port 445
     ouvert. Par défaut elle ne l'est PAS : une fonction de nommage ne
     doit pas ouvrir de connexion TCP à l'insu de qui l'appelle. */
  const [dns, netbios, mdns, smb] = await Promise.all([
    nomDns(ip),
    nomNetbios(ip),
    nomMdns(ip),
    options.smb ? nomSmb(ip) : Promise.resolve(null),
  ]);

  return choisirNom({ snmp, dns, netbios, mdns, smb });
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
function choisirNom({
  snmp = null,
  dns = null,
  netbios = null,
  mdns = null,
  smb = null,
} = {}) {
  const propre = (v) => {
    const t = v ? String(v).trim() : "";
    return t || null;
  };
  const parSnmp = propre(snmp);
  const parDns = propre(dns);
  const parNetbios = propre(netbios);
  const parMdns = propre(mdns);
  const parSmb = propre(smb);

  if (parSnmp) return { nom: parSnmp, source: "snmp" };

  // Un nom enregistré au DNS a été posé par l'administrateur du réseau :
  // il porte une intention, là où les autres sont auto-générés.
  if (parDns) return { nom: parDns, source: "dns" };

  /* SMB AVANT NETBIOS, et la raison tient en une phrase : les deux
     rapportent le nom que la machine se donne, mais SMB peut rendre le
     nom DNS complet là où NetBIOS est coupé à 15 caractères. Quand les
     deux répondent ils disent la même chose — SMB la dit mieux. */
  if (parSmb) return { nom: parSmb, source: "smb" };

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
  nomSmb,
  extraireNomSmb,
  requeteNegociation,
  requeteOuvertureSession,
  jetonSpnego,
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
