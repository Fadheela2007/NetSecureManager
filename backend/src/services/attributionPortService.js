/**
 * attributionPortService.js
 * Attribue la consommation d'un port de switch à la machine qui y est
 * branchée.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LE PROBLÈME QUE CELA RÉSOUT
 *
 * La mesure de bande passante reposait sur SNMP interrogé DIRECTEMENT
 * sur chaque machine. Or la grande majorité des postes n'expose pas
 * SNMP — un Windows ne l'active pas par défaut. Sur un parc courant, la
 * page « Bande passante » restait donc vide pour neuf machines sur dix,
 * ce qui donne l'impression d'une fonction qui ne marche pas.
 *
 * L'erreur était de chercher SNMP au mauvais endroit. Un poste n'a pas
 * besoin de savoir combien il consomme : le SWITCH le sait déjà. Le
 * compteur d'octets du port 12 EST la consommation de la machine
 * branchée sur le port 12, qu'elle expose quoi que ce soit ou non.
 *
 * Il ne manquait que la correspondance port ↔ machine. Elle se lit dans
 * la table d'apprentissage des adresses MAC du switch (BRIDGE-MIB), que
 * tout commutateur administrable expose.
 *
 * LA CHAÎNE COMPLÈTE :
 *   MAC de la machine  (déjà connue, table EQUIPEMENT)
 *     -> port du pont   (dot1dTpFdbPort)
 *     -> ifIndex        (dot1dBasePortIfIndex)
 *     -> compteurs      (déjà collectés dans INTERFACE_RESEAU)
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUE CE SERVICE REFUSE DE FAIRE, ET POURQUOI C'EST L'ESSENTIEL
 *
 * Un port ne porte pas toujours UNE machine. Il en porte plusieurs dès
 * qu'on y branche une borne Wi-Fi, un second switch, ou un serveur de
 * machines virtuelles. Le compteur du port est alors la somme de
 * plusieurs machines, et l'attribuer à l'une d'elles produit un chiffre
 * faux — plausible, mais faux.
 *
 * C'est exactement le type de résultat qui détruit la confiance : un
 * client qui voit « le poste de la comptabilité consomme 400 Mbit/s »
 * alors que c'est le trafic de tout un étage ne reviendra pas.
 *
 * Le service détecte donc les ports à plusieurs adresses et REFUSE de
 * les attribuer. Il l'annonce plutôt que de deviner.
 * ─────────────────────────────────────────────────────────────────────
 */

/** Normalise une MAC en minuscules avec deux-points : « a4:bb:6d:01:02:03 ». */
function normaliserMac(valeur) {
  if (!valeur) return null;
  const brut = String(valeur)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (brut.length !== 12) return null;
  return brut.match(/.{2}/g).join(":");
}

/**
 * Adresses MAC qui ne désignent aucune machine réelle.
 *
 * Les laisser passer polluerait la table d'attribution avec des entrées
 * qui ne correspondront jamais à un équipement — sans conséquence grave,
 * mais elles gonflent les compteurs de « MAC vues par port » et
 * pousseraient à écarter des ports parfaitement attribuables.
 */
function estMacTechnique(mac) {
  if (!mac) return true;
  // Diffusion et multidiffusion : le bit de poids faible du premier
  // octet est à 1.
  const premier = parseInt(mac.slice(0, 2), 16);
  if (Number.isNaN(premier)) return true;
  if (premier & 0x01) return true;
  // Adresse nulle
  if (mac === "00:00:00:00:00:00") return true;
  return false;
}

/**
 * Construit la correspondance port ↔ machines à partir des tables SNMP
 * brutes du switch.
 *
 * @param {object} entrees
 * @param {Array<{mac:string, portPont:number}>} entrees.fdb
 *        table d'apprentissage : quelle MAC a été vue sur quel port du pont
 * @param {Object<number, number>} entrees.portVersIfIndex
 *        dot1dBasePortIfIndex : numéro de port du pont -> ifIndex
 * @returns {Map<number, {macs:string[], attribuable:boolean, raison:string|null}>}
 *          indexé par ifIndex
 */
function construireCorrespondance({ fdb = [], portVersIfIndex = {} } = {}) {
  const parIfIndex = new Map();

  for (const entree of fdb) {
    const mac = normaliserMac(entree?.mac);
    if (!mac || estMacTechnique(mac)) continue;

    const portPont = Number(entree?.portPont);
    if (!Number.isFinite(portPont) || portPont <= 0) continue;

    // Un port du pont n'est PAS un ifIndex : la numérotation est propre
    // au pont et diffère souvent de celle des interfaces. Sans cette
    // traduction, on attribuerait le trafic du port 3 à l'interface 3,
    // qui peut être une tout autre prise.
    const ifIndex = Number(portVersIfIndex[portPont]);
    if (!Number.isFinite(ifIndex) || ifIndex <= 0) continue;

    if (!parIfIndex.has(ifIndex)) {
      parIfIndex.set(ifIndex, { macs: [], attribuable: false, raison: null });
    }
    const entreePort = parIfIndex.get(ifIndex);
    if (!entreePort.macs.includes(mac)) entreePort.macs.push(mac);
  }

  for (const [, valeur] of parIfIndex) {
    if (valeur.macs.length === 1) {
      valeur.attribuable = true;
    } else {
      valeur.attribuable = false;
      valeur.raison = `${valeur.macs.length} machines derrière ce port`;
    }
  }

  return parIfIndex;
}

/**
 * Relie chaque interface du switch à un équipement connu du parc.
 *
 * @param {Map} correspondance      résultat de construireCorrespondance
 * @param {Array<{id_equipement, adresse_mac, nom, adresse_ip}>} equipements
 * @returns {Array<{index_snmp, id_equipement, adresse_mac, nb_mac, attribuable, raison}>}
 */
function attribuer(correspondance, equipements = []) {
  const parMac = new Map();
  for (const e of equipements) {
    const mac = normaliserMac(e?.adresse_mac);
    if (mac) parMac.set(mac, e);
  }

  const resultat = [];
  for (const [ifIndex, port] of correspondance) {
    const base = {
      index_snmp: ifIndex,
      nb_mac: port.macs.length,
      attribuable: port.attribuable,
      raison: port.raison,
      id_equipement: null,
      adresse_mac: null,
    };

    if (!port.attribuable) {
      resultat.push(base);
      continue;
    }

    const mac = port.macs[0];
    const equipement = parMac.get(mac);

    if (!equipement) {
      // La machine est branchée et le switch la voit, mais le scan ne
      // l'a pas encore découverte (éteinte au moment du balayage, ou
      // ne répondant ni au ping ni à l'ARP). On garde la MAC : la
      // prochaine découverte fera le lien toute seule.
      resultat.push({
        ...base,
        adresse_mac: mac,
        attribuable: false,
        raison: "machine inconnue du parc",
      });
      continue;
    }

    resultat.push({ ...base, id_equipement: equipement.id_equipement, adresse_mac: mac });
  }

  return resultat;
}

/**
 * Choisit la meilleure source de mesure pour un équipement.
 *
 * ORDRE DE CONFIANCE, et il n'est pas arbitraire :
 *
 *   1. « snmp »  — l'équipement compte lui-même ses octets. C'est la
 *      mesure exacte de ce qui entre et sort de SA carte réseau.
 *
 *   2. « port »  — le switch compte les octets du port. Presque aussi
 *      exact, à ceci près qu'il inclut le trafic que la machine reçoit
 *      sans l'avoir demandé (diffusion du réseau). L'écart est
 *      négligeable en usage courant, notable sur un réseau très bavard.
 *
 *   3. rien      — et on le dit. Une case vide honnête vaut mieux qu'un
 *      zéro, qui se lit « cette machine ne consomme rien ».
 *
 * L'interface affiche la source retenue : sans cette information, un
 * client comparant deux machines mesurées différemment conclurait à une
 * incohérence du produit.
 */
function choisirSource({ snmpDirect, parPort }) {
  const aUneValeur = (m) =>
    m && (m.trafic_entrant_kbps !== null && m.trafic_entrant_kbps !== undefined);

  if (aUneValeur(snmpDirect)) {
    return { source: "snmp", ...snmpDirect };
  }
  if (aUneValeur(parPort)) {
    return { source: "port", ...parPort };
  }
  return { source: null, trafic_entrant_kbps: null, trafic_sortant_kbps: null };
}

module.exports = {
  normaliserMac,
  estMacTechnique,
  construireCorrespondance,
  attribuer,
  choisirSource,
};
