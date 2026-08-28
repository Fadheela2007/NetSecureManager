/**
 * discoveryService.js
 * Moteur de découverte réseau : scanne une plage CIDR, détecte les hôtes actifs,
 * et interroge chacun en SNMP pour identifier son type/fabricant sans configuration
 * manuelle préalable de la part de l'utilisateur.
 *
 * Dépendances : npm install ping net-snmp ip
 */

const ping = require("ping");
const snmp = require("net-snmp");
const ipLib = require("ip");
const net = require("net");
const dgram = require("dgram");
const { exec } = require("child_process");
const { chargerRegistre, resoudreAvecRegistre } = require("./ouiService");
const { determinerType, typeDepuisTexte } = require("./typeService");
const { resoudreNom } = require("./nomService");
const { parLots } = require("./parLots");

const OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0";
const OID_SYS_NAME = "1.3.6.1.2.1.1.5.0";
const OID_SYS_UPTIME = "1.3.6.1.2.1.1.3.0";
const PORTS_COURANTS = {
  21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS",
  80: "HTTP", 110: "POP3", 143: "IMAP", 161: "SNMP", 443: "HTTPS",
  445: "SMB", 3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 8080: "HTTP-alt",
  // Ports ajoutés pour la classification : ils sont quasi mono-usage et
  // permettent de catégoriser un équipement muet en SNMP comme en nmap.
  // Le coût est nul, scanPorts teste tous les ports en parallèle.
  515: "LPD", 554: "RTSP", 631: "IPP", 9100: "JetDirect",
};

function listHostsFromCidr(cidr) {
  const subnet = ipLib.cidrSubnet(cidr);
  const hosts = [];
  const start = ipLib.toLong(subnet.firstAddress);
  const end = ipLib.toLong(subnet.lastAddress);
  for (let i = start; i <= end; i++) {
    hosts.push(ipLib.fromLong(i));
  }
  return hosts;
}

async function pingSweep(hosts, concurrency = 30) {
  const alive = [];
  for (let i = 0; i < hosts.length; i += concurrency) {
    const batch = hosts.slice(i, i + concurrency);
    // Un ping qui rejette ne doit pas annuler tout le lot : on neutralise l'échec.
    const results = await Promise.all(
      batch.map((ip) =>
        ping.promise.probe(ip, { timeout: 1 }).catch(() => ({ alive: false, host: ip }))
      )
    );
    results.forEach((r) => {
      if (r && r.alive) alive.push({ ip: r.host, latency: r.time });
    });
  }
  return alive;
}

function snmpProbe(ip, community = "public", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, community, { timeout: timeoutMs, retries: 0 });
    const oids = [OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_NAME, OID_SYS_UPTIME];

    session.get(oids, (error, varbinds) => {
      session.close();
      if (error) return resolve(null);
      const result = {};
      varbinds.forEach((vb, idx) => {
        if (!snmp.isVarbindError(vb)) {
          const key = ["sysDescr", "sysObjectID", "sysName", "sysUptime"][idx];
          result[key] = vb.value.toString();
        }
      });
      resolve(result);
    });

    session.on("error", () => resolve(null));
  });
}

/**
 * Interrogation SNMPv3, avec authentification (et chiffrement optionnel).
 */
function snmpProbeV3(ip, { username, authKey, authProtocol = "SHA", privKey, privProtocol }, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const options = {
      port: 161,
      retries: 0,
      timeout: timeoutMs,
      version: snmp.Version3,
    };

    const authProtocolMap = { MD5: snmp.AuthProtocols.md5, SHA: snmp.AuthProtocols.sha };
    const privProtocolMap = { DES: snmp.PrivProtocols.des, AES: snmp.PrivProtocols.aes };

    const user = {
      name: username,
      level: privKey ? snmp.SecurityLevel.authPriv : snmp.SecurityLevel.authNoPriv,
      authProtocol: authProtocolMap[authProtocol] || snmp.AuthProtocols.sha,
      authKey,
    };
    if (privKey) {
      user.privProtocol = privProtocolMap[privProtocol] || snmp.PrivProtocols.des;
      user.privKey = privKey;
    }

    const session = snmp.createV3Session(ip, user, options);
    const oids = [OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_NAME, OID_SYS_UPTIME];

    session.get(oids, (error, varbinds) => {
      session.close();
      if (error) return resolve(null);
      const result = {};
      varbinds.forEach((vb, idx) => {
        if (!snmp.isVarbindError(vb)) {
          const key = ["sysDescr", "sysObjectID", "sysName", "sysUptime"][idx];
          result[key] = vb.value.toString();
        }
      });
      resolve(result);
    });

    session.on("error", () => resolve(null));
  });
}
function fingerprint(snmpData) {
  if (!snmpData) {
    return { type: "inconnu", fabricant: null };
  }

  const descr = (snmpData.sysDescr || "").toLowerCase();
  const nom = (snmpData.sysName || "").toLowerCase();
  const texte = `${descr} ${nom}`;

  // Réseau / infrastructure
  if (texte.includes("cisco")) return { type: "routeur/switch", fabricant: "Cisco" };
  if (texte.includes("huawei")) return { type: "routeur/switch", fabricant: "Huawei" };
  if (texte.includes("juniper")) return { type: "routeur", fabricant: "Juniper" };
  if (texte.includes("mikrotik")) return { type: "routeur", fabricant: "Mikrotik" };
  if (texte.includes("ubiquiti") || texte.includes("unifi")) return { type: "routeur/switch", fabricant: "Ubiquiti" };
  if (texte.includes("aruba")) return { type: "routeur/switch", fabricant: "Aruba (HPE)" };
  if (texte.includes("fortinet") || texte.includes("fortigate")) return { type: "pare-feu", fabricant: "Fortinet" };
  if (texte.includes("d-link")) return { type: "routeur/switch", fabricant: "D-Link" };
  if (texte.includes("tp-link")) return { type: "routeur/switch", fabricant: "TP-Link" };
  if (texte.includes("netgear")) return { type: "routeur/switch", fabricant: "Netgear" };

  // Serveurs / postes
  if (texte.includes("windows")) return { type: "serveur", fabricant: "Microsoft" };
  if (texte.includes("linux")) return { type: "serveur", fabricant: "Linux" };
  if (texte.includes("vmware") || texte.includes("esxi")) return { type: "serveur", fabricant: "VMware" };

  // Imprimantes — reconnaît aussi les noms d'hôte génériques type NPIxxxxx (HP)
  if (texte.includes("printer") || texte.includes("laserjet") || texte.includes("hp jetdirect"))
    return { type: "imprimante", fabricant: "HP" };
  if (texte.includes("npi") || texte.includes("jetdirect"))
    return { type: "imprimante", fabricant: "HP" };
  if (texte.includes("xerox")) return { type: "imprimante", fabricant: "Xerox" };
  if (texte.includes("epson")) return { type: "imprimante", fabricant: "Epson" };
  if (texte.includes("brother")) return { type: "imprimante", fabricant: "Brother" };
  if (texte.includes("canon")) return { type: "imprimante", fabricant: "Canon" };
  if (texte.includes("kyocera")) return { type: "imprimante", fabricant: "Kyocera" };
  if (texte.includes("ricoh")) return { type: "imprimante", fabricant: "Ricoh" };
  if (texte.includes("konica") || texte.includes("minolta")) return { type: "imprimante", fabricant: "Konica Minolta" };
  if (texte.includes("lexmark")) return { type: "imprimante", fabricant: "Lexmark" };

  // Téléphonie IP / caméras
  if (texte.includes("axis")) return { type: "camera", fabricant: "Axis" };
  if (texte.includes("hikvision")) return { type: "camera", fabricant: "Hikvision" };
  if (texte.includes("polycom") || texte.includes("yealink")) return { type: "telephonie", fabricant: "VoIP" };

  if (!descr) return { type: "inconnu", fabricant: null };
  return { type: "equipement_snmp", fabricant: "inconnu" };
}

function fabricantFromOsString(osString) {
  if (!osString) return null;
  const s = osString.toLowerCase();
  if (s.includes("windows") || s.includes("microsoft")) return "Microsoft";
  if (s.includes("android")) return "Google (Android)";
  if (s.includes("linux")) return "Linux";
  if (s.includes("ios") || s.includes("mac os") || s.includes("apple")) return "Apple";
  if (s.includes("cisco")) return "Cisco";
  return null;
}

/**
 * Détection d'OS via nmap (signature TCP/IP), complémentaire à la détection
 * SNMP. Nécessite nmap installé sur la machine, et des droits administrateur
 * sous Windows pour la détection -O.
 */
function nmapFingerprint(ip, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(`nmap -O --osscan-guess ${ip}`, { timeout: timeoutMs }, (error, stdout) => {
      if (error || !stdout) return resolve(null);

      const matchOs = stdout.match(/OS details: (.+)/) || stdout.match(/Aggressive OS guesses: (.+)/);
      const matchDevice = stdout.match(/Device type: (.+)/);

      if (!matchOs) return resolve(null);
      resolve({
        os_detecte: matchOs[1].split(",")[0].trim(),
        type_detecte: matchDevice ? matchDevice[1].trim() : null,
      });
    });
  });
}

/**
 * Envoie un paquet magique Wake-on-LAN en broadcast UDP sur le réseau local.
 * Ne fonctionne que si la machine cible a le WoL activé (BIOS + carte réseau)
 * et si elle est sur le même segment réseau que le serveur qui envoie ceci.
 */
function wakeOnLan(macAddress) {
  return new Promise((resolve, reject) => {
    const mac = macAddress.replace(/[:-]/g, "");
    if (mac.length !== 12) {
      return reject(new Error("Adresse MAC invalide"));
    }

    const macBuffer = Buffer.from(mac, "hex");
    const magicPacket = Buffer.concat([
      Buffer.alloc(6, 0xff),
      Buffer.concat(Array(16).fill(macBuffer)),
    ]);

    const socket = dgram.createSocket("udp4");
    socket.on("error", (err) => {
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(magicPacket, 0, magicPacket.length, 9, "255.255.255.255", (err) => {
        socket.close();
        if (err) reject(err);
        else resolve(true);
      });
    });
  });
}

/**
 * Lit la table ARP du système d'exploitation (remplie automatiquement par
 * Windows/Linux dès qu'une communication locale a eu lieu). Complète le ping
 * pour détecter des appareils qui bloquent l'ICMP mais existent bien sur le
 * réseau local.
 */
function readArpTable() {
  return new Promise((resolve) => {
    exec("arp -a", (error, stdout) => {
      if (error) return resolve([]);

      const entries = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const match = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F-]{17})\s+(\w+)/);
        if (match && match[2].toLowerCase() !== "ff-ff-ff-ff-ff-ff") {
          entries.push({ ip: match[1], mac: match[2], type: match[3] });
        }
      }
      resolve(entries);
    });
  });
}

/**
 * Croise le résultat du ping sweep avec la table ARP : ajoute les appareils
 * vus en ARP mais absents du ping (probablement un pare-feu qui bloque ICMP).
 */
async function arpComplement(cidr, aliveHostsFromPing, arpEntries = null) {
  // arpEntries peut être fourni par l'appelant pour éviter de relire la table ARP.
  const entrees = arpEntries || (await readArpTable());
  const ipsDejaVues = new Set(aliveHostsFromPing.map((h) => h.ip));

  // Test d'appartenance réel au sous-réseau : le test par préfixe sur les
  // 3 premiers octets était faux pour tout masque autre que /24 (ex: /23).
  const subnet = ipLib.cidrSubnet(cidr);
  const complements = entrees.filter(
    (e) => subnet.contains(e.ip) && !ipsDejaVues.has(e.ip)
  );

  return complements.map((e) => ({ ip: e.ip, mac: e.mac, viaArp: true }));
}

/**
 * @param {function} [onProgress]  (etape, courant, total) — appelé pendant
 *   le scan. Sur une plage large, l'identification des machines se compte
 *   en minutes : sans retour d'avancement, l'agent lancé à la main reste
 *   muet assez longtemps pour qu'on le croie planté. Optionnel : le cycle
 *   central ne le fournit pas.
 */
async function scanRange({ cidr, snmpCommunity = "public", snmpV3 = null, onProgress = null }) {
  const avancer = typeof onProgress === "function" ? onProgress : () => {};

  const hosts = listHostsFromCidr(cidr);
  avancer("balayage", 0, hosts.length);
  const aliveHosts = await pingSweep(hosts);

  // Table ARP lue UNE SEULE FOIS par scan : elle sert à la fois à compléter le
  // ping sweep et à retrouver la MAC de n'importe quel hôte découvert.
  const toutesLesEntreesArp = await readArpTable();

  // Complète avec les appareils vus en ARP mais qui n'ont pas répondu au ping
  const arpSupplement = await arpComplement(cidr, aliveHosts, toutesLesEntreesArp);
  const tousLesHotes = [...aliveHosts, ...arpSupplement.map((a) => ({ ip: a.ip, latency: null }))];

  // Registre OUI chargé UNE fois pour tout le scan : la résolution du
  // fabricant par adresse MAC devient alors une simple lecture en mémoire,
  // sans requête ni accès réseau par équipement.
  let registreOui = null;
  try {
    registreOui = await chargerRegistre();
  } catch (err) {
    console.error("Registre OUI indisponible, fabricants non résolus par MAC:", err.message);
  }

  // ─────────────────────────────────────────────────────────────────
  // IDENTIFICATION PAR LOTS DE 5.
  //
  // Chaque machine coûte : SNMP (1,5 s de délai d'attente si muette),
  // nmap (jusqu'à 15 s, seulement si SNMP n'a pas conclu) et un scan de
  // ports. En séquentiel, 25 machines actives sur un /23 demandaient
  // plusieurs minutes — dont la quasi-totalité passée à ATTENDRE des
  // délais d'expiration, processeur et réseau au repos.
  //
  // POURQUOI 5 ET PAS PLUS. Le facteur limitant n'est pas notre machine
  // mais le réseau supervisé, qu'on ne doit surtout pas perturber : un
  // outil de supervision qui dégrade ce qu'il observe est inutilisable.
  // Chiffres réels à 5 en parallèle (détail dans RAPPORT-scan-parallele.md) :
  //   • jusqu'à 5 processus nmap simultanés, soit ~500 à 1 500 paquets/s
  //     au total, ~0,5 Mbit/s — 0,05 % d'un lien gigabit ;
  //   • jusqu'à 95 connexions TCP ouvertes en pointe (19 ports × 5 hôtes),
  //     mais brèves : 400 ms de délai d'attente, et réparties car les
  //     hôtes d'un lot n'atteignent pas cette phase en même temps ;
  //   • aucune charge sur les machines cibles : un SYN sur un port fermé
  //     coûte un RST.
  //
  // Monter à 20 ou 50 diviserait encore le temps, mais changerait la
  // NATURE du trafic : 50 balayages de ports simultanés ressemblent à une
  // reconnaissance hostile. Les pare-feux et les sondes de détection
  // d'intrusion les bloquent — le scan renverrait alors MOINS de
  // résultats en étant plus agressif. 5 garde le trafic sous les seuils
  // de déclenchement usuels tout en divisant la durée par 5.
  //
  // Réglable par SCAN_CONCURRENCE dans le .env, plafonné à 20 : sur un
  // parc très large et un réseau qu'on maîtrise, monter peut se justifier.
  // Le plafond empêche qu'une valeur saisie à la légère (500) transforme
  // l'agent en outil d'attaque.
  //
  // Les lots sont séquentiels entre eux : jamais plus de 5 machines
  // interrogées à la fois, quelle que soit la taille de la plage.
  // ─────────────────────────────────────────────────────────────────
  const CONCURRENCE_IDENTIFICATION = Number(process.env.SCAN_CONCURRENCE) > 0
    ? Math.min(20, Number(process.env.SCAN_CONCURRENCE))
    : 5;

  /**
   * Identifie une machine. Ne lève jamais : un hôte qui fait échouer SNMP
   * ou nmap ne doit pas emporter son lot avec lui (Promise.all rejette au
   * premier échec — d'où la capture ICI et non autour du lot).
   *
   * @returns {object|null} l'équipement, ou null s'il n'a pas pu être analysé
   */
  async function analyserHote(host) {
    try {
      const snmpData = snmpV3
        ? await snmpProbeV3(host.ip, snmpV3)
        : await snmpProbe(host.ip, snmpCommunity);

      const fp = fingerprint(snmpData);
      let osDetecte = null;
      let nmapDeviceType = null;
      const fabricantSnmp = fp.fabricant;
      let fabricantNmap = null;

      // nmap en dernier recours seulement : coûteux (jusqu'à 15 s par hôte).
      // On l'appelle si le texte SNMP n'a pas permis de conclure — ce qui
      // couvre l'absence de réponse SNMP comme une réponse inexploitable.
      const typeSnmp = typeDepuisTexte(
        [snmpData?.sysDescr, snmpData?.sysName].filter(Boolean).join(" "),
        "snmp"
      );
      if (!typeSnmp) {
        const nmapResult = await nmapFingerprint(host.ip);
        if (nmapResult) {
          osDetecte = nmapResult.os_detecte;
          nmapDeviceType = nmapResult.type_detecte;
          fabricantNmap = fabricantFromOsString(nmapResult.os_detecte);
        }
      }

      // Ports scannés AVANT la classification : un port 9100 ouvert
      // catégorise à lui seul une imprimante muette en SNMP comme en nmap.
      // Le résultat est réutilisé par routes/scan.js pour SERVICE_DETECTE,
      // il n'est donc pas scanné deux fois.
      let portsOuverts = [];
      try {
        portsOuverts = await scanPorts(host.ip);
      } catch (err) {
        console.error(`Scan de ports de ${host.ip} échoué:`, err.message);
      }

      const arpMatch = toutesLesEntreesArp.find((a) => a.ip === host.ip);
      const mac = arpMatch ? arpMatch.mac : null;
      const parOui = registreOui ? resoudreAvecRegistre(mac, registreOui) : null;

      // ─────────────────────────────────────────────────────────────
      // PRIORITÉ DES SOURCES : SNMP > OUI > nmap.
      //
      // SNMP en premier : l'équipement se décrit lui-même, c'est le vrai
      // constructeur de la machine.
      //
      // OUI avant nmap, et c'est le point qui mérite justification. Le
      // « fabricant » déduit de nmap vient du système d'exploitation :
      // « Microsoft », « Linux », « Apple ». Or « Linux » n'est pas un
      // fabricant, et « Microsoft » désigne l'éditeur de l'OS, pas le
      // constructeur du matériel. L'OUI, lui, donne un vrai constructeur
      // de carte réseau — « Dell », « Intel », « Hewlett-Packard ».
      // L'information de nmap n'est pas perdue pour autant : elle vit
      // déjà dans `os_detecte`, qui est sa place légitime.
      //
      // Limite assumée : l'OUI identifie la CARTE réseau. Un serveur Dell
      // avec une carte Intel remontera « Intel ». D'où le champ
      // `fabricant_source`, qui permet à l'interface de nuancer.
      // ─────────────────────────────────────────────────────────────
      let fabricant = null;
      let fabricantSource = null;

      if (fabricantSnmp && fabricantSnmp !== "inconnu") {
        fabricant = fabricantSnmp;
        fabricantSource = "snmp";
      } else if (parOui && parOui.fabricant) {
        fabricant = parOui.fabricant;
        fabricantSource = "oui";
      } else if (fabricantNmap) {
        fabricant = fabricantNmap;
        fabricantSource = "nmap";
      }

      // Une seule décision, prise sur l'ensemble des signaux : voir
      // services/typeService.js pour l'ordre de confiance et sa
      // justification. Le service ne produit jamais autre chose qu'une
      // catégorie du vocabulaire fermé, ou « inconnu ».
      const classification = determinerType({
        sysDescr: snmpData ? snmpData.sysDescr : null,
        sysName: snmpData ? snmpData.sysName : null,
        osDetecte,
        nmapDeviceType,
        ports: portsOuverts,
        fabricant,
      });

      // ─────────────────────────────────────────────────────────────
      // NOM DE LA MACHINE — même raisonnement que pour le fabricant.
      //
      // CE QUI N'ALLAIT PAS : à défaut de SNMP, le nom retombait sur
      // `osDetecte`, l'estimation de système d'exploitation de nmap.
      // La liste affichait donc des lignes comme « 3Com OfficeConnect
      // 3CRWER100-75 wireless broadband router (96%) » dans la colonne
      // « nom » — un modèle avec son taux de confiance, jamais un nom.
      //
      // C'est exactement l'erreur déjà écartée pour le fabricant : une
      // donnée rangée dans un champ qui n'est pas le sien. L'estimation
      // de nmap n'est pas perdue, elle vit dans `os_detecte`.
      //
      // ORDRE DE CONFIANCE :
      //   1. sysName SNMP — le nom que la machine se donne elle-même ;
      //   2. DNS inverse  — le nom que le réseau lui reconnaît ;
      //   3. NetBIOS      — le nom que le poste annonce lui-même ;
      //   4. rien.
      //
      // Voir services/nomService.js pour le détail. Les sources réseau
      // ne sont interrogées que si SNMP n'a rien donné.
      // ─────────────────────────────────────────────────────────────
      const { nom, source: nomSource } = await resoudreNom(
        host.ip,
        snmpData ? snmpData.sysName : null
      );

      return {
        adresse_ip: host.ip,
        adresse_mac: mac,
        latence_ms: host.latency,
        sys_descr: snmpData ? snmpData.sysDescr : null,
        nom: nom || null,
        nom_source: nomSource,
        type_detecte: classification.type,
        type_source: classification.source,
        fabricant,
        fabricant_source: fabricantSource,
        mac_aleatoire: parOui ? parOui.aleatoire : false,
        os_detecte: osDetecte,
        // Transmis pour éviter un second scan de ports côté routes/scan.js.
        services: portsOuverts,
        statut: "up",
        derniere_decouverte: new Date(),
      };
    } catch (err) {
      console.error(`Analyse de ${host.ip} échouée, hôte ignoré:`, err.message);
      return null;
    }
  }

  const analyses = await parLots(
    tousLesHotes,
    CONCURRENCE_IDENTIFICATION,
    (host) => analyserHote(host),
    (traites, total) => avancer("identification", traites, total)
  );

  // Les hôtes dont l'analyse a échoué renvoient null : on les écarte ici
  // plutôt que d'insérer des trous dans la liste. L'ordre des adresses
  // est conservé (voir parLots.js).
  return analyses.filter(Boolean);
}

/**
 * Tente de comprendre pourquoi un équipement ne répond plus au ping,
 * en testant s'il répond au moins sur un port TCP courant.
 */
function testPort(ip, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { resolve(false); });
    socket.connect(port, ip);
  });
}

async function diagnosePanne(ip) {
  const ports = [80, 443, 22, 3389, 8080];
  for (const port of ports) {
    if (await testPort(ip, port)) {
      return {
        code: "pare_feu_probable",
        detail: `Ne répond plus au ping, mais le port ${port} reste actif — probablement un pare-feu qui bloque le ping.`,
      };
    }
  }
  return {
    code: "injoignable_total",
    detail: "Aucune réponse (ping et ports courants) — l'équipement semble réellement injoignable ou éteint.",
  };
}

async function scanPorts(ip) {
  const ports = Object.keys(PORTS_COURANTS).map(Number);
  const resultats = await Promise.all(
    ports.map(async (port) => ({
      port,
      ouvert: await testPort(ip, port, 400),
    }))
  );
  return resultats
    .filter((r) => r.ouvert)
    .map((r) => ({ port: r.port, nom_service: PORTS_COURANTS[r.port] }));
}

const OID_HR_PROCESSOR_LOAD = "1.3.6.1.2.1.25.3.3.1.2";
const OID_HR_STORAGE_DESCR = "1.3.6.1.2.1.25.2.3.1.3";
const OID_IF_IN_OCTETS = "1.3.6.1.2.1.2.2.1.10";
const OID_IF_OUT_OCTETS = "1.3.6.1.2.1.2.2.1.16";
// Inventaire des interfaces (IF-MIB) : nom et états administratif/opérationnel.
const OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2";
// Capacité nominale du lien, en bits/s. Sans elle, un débit brut n'est pas
// interprétable : 50 000 kbit/s valent 5 % d'un lien gigabit et 500 % d'un
// lien 10 Mbit/s. C'est la donnée qui rend le taux d'utilisation possible.
const OID_IF_SPEED = "1.3.6.1.2.1.2.2.1.5";
const OID_IF_PHYS_ADDRESS = "1.3.6.1.2.1.2.2.1.6";
const OID_IF_ADMIN_STATUS = "1.3.6.1.2.1.2.2.1.7";
const OID_IF_OPER_STATUS = "1.3.6.1.2.1.2.2.1.8";

/* ─────────────────────────────────────────────────────────────────────
   TABLES DE COMMUTATION (BRIDGE-MIB)

   Elles permettent de savoir QUELLE MACHINE est branchée sur QUEL PORT,
   et donc d'attribuer la consommation d'un port à une machine qui
   n'expose elle-même aucun SNMP. Voir services/attributionPortService.js
   pour ce qu'on en fait et ce qu'on refuse d'en déduire.

   Deux variantes coexistent dans la nature :
     • dot1dTpFdbPort  — BRIDGE-MIB classique, switches simples
     • dot1qTpFdbPort  — Q-BRIDGE-MIB, switches gérant les VLAN
   Beaucoup de matériels récents ne remplissent QUE la seconde. On
   interroge les deux et on garde ce qui répond.
   ───────────────────────────────────────────────────────────────────── */
const OID_DOT1D_TP_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2";
const OID_DOT1Q_TP_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2";
const OID_DOT1D_BASE_PORT_IFINDEX = "1.3.6.1.2.1.17.1.4.1.2";

/**
 * Parcourt une sous-arborescence SNMP et renvoie les couples (OID, valeur).
 *
 * `snmpTable()` ne convient pas ici : il suppose un index simple, alors
 * que la table d'apprentissage est indexée par l'adresse MAC — six
 * nombres accolés à l'OID — et parfois précédée du numéro de VLAN. Il
 * faut donc les OID bruts pour en extraire la MAC.
 */
function snmpParcours(ip, community, oid, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let session;
    const resultats = [];
    try {
      session = snmp.createSession(ip, community, { timeout: timeoutMs, retries: 0 });
    } catch {
      return resolve([]);
    }
    let termine = false;
    const finir = (valeur) => {
      if (termine) return;
      termine = true;
      try {
        session.close();
      } catch {
        /* déjà fermée */
      }
      resolve(valeur);
    };

    session.on("error", () => finir([]));
    try {
      session.subtree(
        oid,
        (varbinds) => {
          for (const vb of varbinds) {
            if (!snmp.isVarbindError(vb)) resultats.push({ oid: vb.oid, valeur: vb.value });
          }
        },
        (err) => finir(err ? [] : resultats)
      );
    } catch {
      finir([]);
    }
  });
}

/**
 * Extrait l'adresse MAC des SIX DERNIERS nombres d'un OID.
 *
 * On prend les six derniers et non les six suivant la base : en
 * Q-BRIDGE-MIB, l'index commence par le numéro de VLAN. Prendre depuis
 * la base donnerait une MAC décalée d'un octet — une adresse
 * parfaitement formée, et fausse.
 */
function macDepuisOid(oid) {
  const morceaux = String(oid).split(".").map(Number);
  if (morceaux.length < 6) return null;
  const octets = morceaux.slice(-6);
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets.map((o) => o.toString(16).padStart(2, "0")).join(":");
}

/**
 * Lit la table de commutation d'un switch.
 *
 * @returns {{fdb: Array<{mac,portPont}>, portVersIfIndex: Object, exploitable: boolean, raison: string|null}}
 */
async function tableCommutation(ip, community = "public") {
  const [fdb1d, fdb1q, basePorts] = await Promise.all([
    snmpParcours(ip, community, OID_DOT1D_TP_FDB_PORT),
    snmpParcours(ip, community, OID_DOT1Q_TP_FDB_PORT),
    snmpParcours(ip, community, OID_DOT1D_BASE_PORT_IFINDEX),
  ]);

  const brut = fdb1d.length > 0 ? fdb1d : fdb1q;

  const fdb = [];
  for (const { oid, valeur } of brut) {
    const mac = macDepuisOid(oid);
    const portPont = Number(valeur);
    if (mac && Number.isFinite(portPont) && portPont > 0) fdb.push({ mac, portPont });
  }

  const portVersIfIndex = {};
  for (const { oid, valeur } of basePorts) {
    const portPont = Number(String(oid).split(".").pop());
    const ifIndex = Number(valeur);
    if (Number.isFinite(portPont) && Number.isFinite(ifIndex) && ifIndex > 0) {
      portVersIfIndex[portPont] = ifIndex;
    }
  }

  if (fdb.length === 0) {
    return { fdb, portVersIfIndex, exploitable: false, raison: "aucune table d'adresses MAC" };
  }
  if (Object.keys(portVersIfIndex).length === 0) {
    // ON NE SUPPOSE PAS que le numéro de port du pont vaut l'ifIndex.
    // C'est vrai sur beaucoup de matériels, faux sur beaucoup d'autres —
    // et quand c'est faux, on attribue le trafic d'une prise à une
    // machine branchée ailleurs. Un chiffre faux sans le moindre signal
    // vaut moins que pas de chiffre du tout.
    return {
      fdb,
      portVersIfIndex,
      exploitable: false,
      raison: "table de correspondance des ports absente (dot1dBasePortIfIndex)",
    };
  }

  return { fdb, portVersIfIndex, exploitable: true, raison: null };
}

// ifAdminStatus / ifOperStatus : 1 = up, 2 = down, 3 = testing.
function etatInterface(valeur) {
  const n = Number(valeur);
  if (n === 1) return "up";
  if (n === 2) return "down";
  return "inconnu";
}

/**
 * Formate une adresse MAC issue de ifPhysAddress (Buffer ou chaîne brute)
 * au format XX-XX-XX-XX-XX-XX, cohérent avec ce que renvoie readArpTable().
 * Renvoie null si la valeur est absente ou inexploitable.
 */
function formaterMacSnmp(valeur) {
  if (!valeur) return null;
  let octets;
  if (Buffer.isBuffer(valeur)) {
    octets = [...valeur];
  } else if (typeof valeur === "string" && valeur.length > 0) {
    octets = [...Buffer.from(valeur, "binary")];
  } else {
    return null;
  }
  if (octets.length !== 6) return null;
  if (octets.every((o) => o === 0)) return null;
  return octets.map((o) => o.toString(16).padStart(2, "0").toUpperCase()).join("-");
}

function snmpTable(ip, community, oid, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let session;
    try {
      session = snmp.createSession(ip, community, { timeout: timeoutMs, retries: 0 });
    } catch {
      return resolve({});
    }
    session.on("error", () => resolve({}));
    session.table(oid, 20, (error, table) => {
      session.close();
      resolve(error ? {} : table || {});
    });
  });
}

/**
 * Relevé SNMP d'un équipement.
 *
 * @param {object} [options]
 * @param {boolean} [options.avecInventaire=false]
 *   Récupère en plus le nom, la MAC et les états admin/opérationnel de chaque
 *   interface (3 interrogations SNMP supplémentaires).
 *
 *   VOLONTAIREMENT DÉSACTIVÉ PAR DÉFAUT : le cycle de supervision tourne
 *   chaque minute sur tout le parc. Passer de 4 à 7 tables SNMP par
 *   équipement (+75 %) allongerait chaque cycle sans bénéfice réel — le nom
 *   et le VLAN d'une interface ne changent qu'à la reconfiguration d'un
 *   switch, pas d'une minute à l'autre. L'inventaire est donc collecté
 *   pendant les scans (routes/scan.js), qui sont explicites et peu fréquents.
 *   Le cron continue de ne lire que les compteurs de trafic, indispensables
 *   au calcul du débit.
 */
async function snmpMetrics(ip, community = "public", { avecInventaire = false } = {}) {
  const tablesBase = [
    snmpTable(ip, community, OID_HR_PROCESSOR_LOAD),
    snmpTable(ip, community, OID_HR_STORAGE_DESCR.slice(0, -2)),
    snmpTable(ip, community, OID_IF_IN_OCTETS),
    snmpTable(ip, community, OID_IF_OUT_OCTETS),
  ];

  const tablesInventaire = avecInventaire
    ? [
        snmpTable(ip, community, OID_IF_DESCR),
        snmpTable(ip, community, OID_IF_ADMIN_STATUS),
        snmpTable(ip, community, OID_IF_OPER_STATUS),
        snmpTable(ip, community, OID_IF_PHYS_ADDRESS),
        snmpTable(ip, community, OID_IF_SPEED),
      ]
    : [];

  const resultats = await Promise.all([...tablesBase, ...tablesInventaire]);
  const [cpuTable, storageTable, inTable, outTable] = resultats;
  const [descrTable, adminTable, operTable, macTable, speedTable] = avecInventaire
    ? resultats.slice(4)
    : [null, null, null, null, null];

  const charges = Object.values(cpuTable || {}).map((row) => row[2]).filter((v) => typeof v === "number");
  const cpuPercent = charges.length ? charges.reduce((a, b) => a + b, 0) / charges.length : null;

  let ramPercent = null;
  for (const row of Object.values(storageTable || {})) {
    const descr = (row[3] || "").toString().toLowerCase();
    if (descr.includes("physical memory") || descr === "ram") {
      const taille = Number(row[5]);
      const utilise = Number(row[6]);
      if (taille > 0) ramPercent = (utilise / taille) * 100;
      break;
    }
  }

  // Les index proviennent des compteurs de trafic ; en mode inventaire on
  // complète avec ceux vus dans ifDescr (une interface peut apparaître dans
  // l'une et pas dans l'autre selon l'agent SNMP).
  const indexes = new Set(Object.keys(inTable || {}));
  if (avecInventaire) {
    Object.keys(descrTable || {}).forEach((i) => indexes.add(i));
  }

  const interfaces = [...indexes].map((idx) => {
    const base = {
      index: Number(idx),
      inOctets: Number((inTable || {})[idx]?.[10]) || 0,
      outOctets: Number((outTable || {})[idx]?.[16]) || 0,
    };

    if (!avecInventaire) return base;

    const nomBrut = (descrTable || {})[idx]?.[2];
    const vitesseBits = Number((speedTable || {})[idx]?.[5]);
    return {
      ...base,
      nom: nomBrut ? nomBrut.toString().trim() : null,
      adresseMac: formaterMacSnmp((macTable || {})[idx]?.[6]),
      etatAdmin: etatInterface((adminTable || {})[idx]?.[7]),
      etatOperationnel: etatInterface((operTable || {})[idx]?.[8]),
      // ifSpeed sature à 4294967295 sur les liens ≥ 4 Gbit/s (compteur 32
      // bits) : au-delà, la valeur n'a plus de sens et on préfère rien.
      vitesseMbps:
        Number.isFinite(vitesseBits) && vitesseBits > 0 && vitesseBits < 4294967295
          ? Math.round(vitesseBits / 1_000_000)
          : null,
    };
  });

  return { cpuPercent, ramPercent, interfaces };
}

module.exports = {
  scanRange, pingSweep, snmpProbe, snmpProbeV3, listHostsFromCidr,
  diagnosePanne, scanPorts, arpComplement, snmpMetrics, nmapFingerprint,
  wakeOnLan, fingerprint,
  // Attribution du trafic par port de switch — voir attributionPortService.
  tableCommutation, macDepuisOid,
};