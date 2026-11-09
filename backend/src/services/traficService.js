/**
 * traficService.js
 * Calcul du débit réseau à partir des compteurs SNMP cumulés.
 *
 * SNMP ne fournit pas un débit mais un COMPTEUR d'octets depuis le
 * démarrage de l'équipement. Le débit se déduit de la différence entre
 * deux relevés, divisée par le temps écoulé.
 *
 * Ce module centralise ce calcul, jusqu'ici dupliqué entre le cycle de
 * supervision central et l'agent distant — avec deux caches distincts et
 * deux implémentations légèrement différentes.
 *
 * DEUX CORRECTIONS PAR RAPPORT À L'EXISTANT :
 *
 * 1. Le débit était calculé sur `interfaces[0]` seulement. Sur un switch
 *    24 ports, la « consommation » affichée était donc celle du port 1.
 *    Le calcul porte désormais sur TOUTES les interfaces.
 *
 * 2. Le cache était indexé par équipement. Il l'est maintenant par
 *    (équipement, interface) : sans cela, deux interfaces du même switch
 *    écrasaient mutuellement leur compteur précédent et produisaient des
 *    débits aberrants.
 */

/** cle -> { inOctets, outOctets, timestamp } */
const compteurs = new Map();

/**
 * ═══════════════════════════════════════════════════════════════════════
 * MÉMOIRE DES INTERFACES À ÉCARTER — corrigé le 28/09
 *
 * LE DÉFAUT. `estIgnoree()` décide à partir du NOM de l'interface. Or le
 * cycle de supervision appelle `snmpMetrics()` sans inventaire, et sans
 * inventaire les objets d'interface n'ont pas de nom. `estIgnoree(undefined)`
 * rendait donc `false` : la boucle locale entrait dans le total.
 *
 * Mesuré sur la forme exacte des objets de production, avec le cas décrit
 * par les tests eux-mêmes — une imprimante dont la boucle locale bouge cent
 * fois plus vite que son lien : 13 157 kbit/s au lieu de 136,5. Un facteur
 * 96. Les tests passaient parce qu'ils fournissent le nom ; la production ne
 * le fournit pas.
 *
 * Pire, c'était visiblement incohérent : la fiche d'un équipement marquait
 * bien le port « hors total » — elle lit les noms en base — pendant que le
 * total de la même machine l'incluait.
 *
 * LA CORRECTION. Ce module RETIENT ce qu'il a appris. Dès qu'un relevé
 * arrive avec des noms, il note quels index sont à écarter pour cet
 * équipement, et s'en sert pour tous les relevés suivants, qui n'en ont pas.
 *
 * Deux façons d'apprendre, qui se complètent :
 *   • l'agent distant fait un cycle avec inventaire sur douze : il apprend
 *     tout seul, sans base de données — ce module doit rester utilisable
 *     là où il n'y en a pas ;
 *   • le serveur central sème depuis INTERFACE_RESEAU, où le scan a déjà
 *     écrit les noms. Aucune colonne SNMP supplémentaire n'est interrogée.
 *
 * TANT QUE RIEN N'A ÉTÉ APPRIS, aucune interface n'est écartée — c'est le
 * comportement d'avant, donc jamais pire. La correction s'installe au
 * premier inventaire.
 * ═══════════════════════════════════════════════════════════════════════
 */
const ignorees = new Map(); // `${identifiant}:${index}` -> true

/**
 * Plafond de la mémoire des interfaces.
 *
 * Deux à quatre entrées par équipement en pratique. Le plafond protège
 * contre le cas où l'identifiant varie — l'agent indexe par adresse IP, et
 * un bail DHCP court en crée de nouvelles. Sans lui, cette carte serait la
 * fuite mémoire lente que rien ne signale.
 */
const MAX_INTERFACES_MEMORISEES = 20000;

function noter(cle, estIgnoreeValeur) {
  if (estIgnoreeValeur) {
    if (ignorees.size >= MAX_INTERFACES_MEMORISEES) ignorees.clear();
    ignorees.set(cle, true);
  } else {
    ignorees.delete(cle);
  }
}

/**
 * Sème la liste des interfaces à écarter depuis une source extérieure —
 * en pratique les noms déjà enregistrés dans INTERFACE_RESEAU.
 *
 * @param {string|number} identifiant
 * @param {Array<{index_snmp:number, nom:string}>} interfacesConnues
 */
function memoriserInterfaces(identifiant, interfacesConnues) {
  for (const i of interfacesConnues || []) {
    const index = i.index_snmp ?? i.index;
    if (index === undefined || index === null) continue;
    noter(`${identifiant}:${index}`, estIgnoree(i.nom));
  }
}

/**
 * Interfaces à exclure du total d'un équipement.
 *
 * La boucle locale voit passer tout le trafic interne de la machine : la
 * compter doublerait la consommation réelle. Les interfaces « null »
 * (rejet Cisco) faussent de même.
 *
 * Chaque motif est ancré, et c'est le point important. La version
 * précédente s'écrivait `/^(lo|loopback|null\d*|…)/i`, sans ancrage de
 * fin : le fragment `lo` écartait donc tout nom commençant par ces deux
 * lettres, à commencer par « Local Area Connection ». Sur un parc
 * Windows, l'interface principale de chaque machine était silencieusement
 * retirée du calcul, et l'équipement affichait un trafic nul en
 * fonctionnant parfaitement.
 *
 * Les tests ne l'avaient pas vu : ils ne couvraient que des noms Unix et
 * Cisco. Ajouter un cas doit rester un geste explicite.
 */
const MOTIFS_INTERFACE_IGNOREE = [
  /^lo\d*$/i,                 // lo, lo0, lo1 — convention Unix, nom complet
  /^loopback\b/i,             // LOOPBACK, « Loopback Pseudo-Interface 1 »
  /^software loopback\b/i,    // libellé Windows complet
  /^null\d*$/i,               // Null0 — interface de rejet Cisco
];

function estIgnoree(nomInterface) {
  if (!nomInterface) return false;
  const nom = String(nomInterface).trim();
  return MOTIFS_INTERFACE_IGNOREE.some((motif) => motif.test(nom));
}

/**
 * Calcule le débit d'une interface entre deux relevés.
 *
 * @param {string} cle      identifiant stable : `${idOuIp}:${indexSnmp}`
 * @param {object} iface    { inOctets, outOctets }
 * @param {number} maintenant  horodatage, injectable pour les tests
 * @returns {{entrant:number|null, sortant:number|null}} en kbit/s
 */
function calculerDebit(cle, iface, maintenant = Date.now()) {
  const precedent = compteurs.get(cle);

  compteurs.set(cle, {
    inOctets: Number(iface.inOctets) || 0,
    outOctets: Number(iface.outOctets) || 0,
    timestamp: maintenant,
  });

  // Premier relevé : aucune différence calculable. On ne remonte rien
  // plutôt qu'un zéro, qui se confondrait avec « aucun trafic ».
  if (!precedent) return { entrant: null, sortant: null };

  const secondes = (maintenant - precedent.timestamp) / 1000;
  if (secondes <= 0) return { entrant: null, sortant: null };

  const deltaIn = Number(iface.inOctets) - precedent.inOctets;
  const deltaOut = Number(iface.outOctets) - precedent.outOctets;

  // Un delta négatif signale un débordement de compteur 32 bits ou le
  // redémarrage de l'équipement. On préfère ne rien afficher plutôt
  // qu'un pic de plusieurs Gbit/s qui n'a jamais eu lieu.
  return {
    entrant: deltaIn >= 0 ? (deltaIn * 8) / 1024 / secondes : null,
    sortant: deltaOut >= 0 ? (deltaOut * 8) / 1024 / secondes : null,
  };
}

/**
 * Calcule le débit de toutes les interfaces d'un équipement, plus le
 * total de l'équipement.
 *
 * ⚠ SENS DU TOTAL SUR UN SWITCH.
 * La somme de tous les ports d'un commutateur ne représente PAS son débit
 * de transit : une trame qui entre par le port 3 et ressort par le port 7
 * est comptée deux fois. Le total mesure l'ACTIVITÉ CUMULÉE DES PORTS,
 * ce qui reste l'indicateur utile pour repérer un équipement qui sature
 * le réseau. L'interface le libelle explicitement pour les switches.
 *
 * Sur un poste ou un serveur à une seule carte, le total est le débit réel.
 *
 * @param {string|number} identifiant  id_equipement ou adresse IP
 * @param {Array} interfaces  issues de snmpMetrics
 * @returns {{ parInterface: Array, total: {entrant, sortant, interfaces_comptees} }}
 */
function calculerDebitsEquipement(identifiant, interfaces, maintenant = Date.now()) {
  const parInterface = [];
  let totalEntrant = null;
  let totalSortant = null;
  let comptees = 0;

  for (const iface of interfaces || []) {
    const index = iface.index ?? iface.index_snmp;
    if (index === undefined || index === null) continue;

    const cle = `${identifiant}:${index}`;
    const debit = calculerDebit(cle, iface, maintenant);

    /* Le nom fait foi quand il est là — et il met à jour la mémoire au
       passage. Quand il manque, on se rabat sur ce qu'on a appris ; à
       défaut, on ne suppose rien. */
    let ignoree;
    if (iface.nom) {
      ignoree = estIgnoree(iface.nom);
      noter(cle, ignoree);
    } else {
      ignoree = ignorees.has(cle);
    }

    parInterface.push({
      index_snmp: Number(index),
      nom: iface.nom ?? null,
      vitesse_mbps: iface.vitesseMbps ?? null,
      trafic_entrant_kbps: debit.entrant,
      trafic_sortant_kbps: debit.sortant,
      ignoree_du_total: ignoree,
    });

    if (ignoree) continue;
    if (debit.entrant !== null) totalEntrant = (totalEntrant ?? 0) + debit.entrant;
    if (debit.sortant !== null) totalSortant = (totalSortant ?? 0) + debit.sortant;
    if (debit.entrant !== null || debit.sortant !== null) comptees++;
  }

  return {
    parInterface,
    total: { entrant: totalEntrant, sortant: totalSortant, interfaces_comptees: comptees },
  };
}

/**
 * Taux d'utilisation d'un lien, en pourcentage.
 *
 * C'est le seul indicateur de trafic réellement interprétable : 50 000
 * kbit/s ne veut rien dire dans l'absolu — c'est 5 % d'un lien gigabit et
 * 500 % d'un lien 10 Mbit/s. D'où la collecte de `ifSpeed`.
 *
 * On retient le maximum entre entrant et sortant : sur un lien
 * full-duplex, les deux sens ne se cumulent pas.
 */
function tauxUtilisation(entrantKbps, sortantKbps, vitesseMbps) {
  if (!vitesseMbps || vitesseMbps <= 0) return null;
  const maxKbps = Math.max(entrantKbps ?? 0, sortantKbps ?? 0);
  const capaciteKbps = vitesseMbps * 1000;
  return Math.min(100, (maxKbps / capaciteKbps) * 100);
}

/** Oublie les compteurs d'un équipement (sortie du parc, agent muet). */
function oublier(identifiant) {
  for (const cle of compteurs.keys()) {
    if (cle.startsWith(`${identifiant}:`)) compteurs.delete(cle);
  }
  /* La mémoire des interfaces N'EST PAS effacée ici : `oublier()` est
     appelé à chaque échec de ping, pour qu'un retour en ligne ne produise
     pas un delta calculé sur des heures d'écart. Les noms d'interface, eux,
     n'ont pas changé pendant que la machine était éteinte — les réapprendre
     demanderait un inventaire complet à chaque redémarrage de poste. */
}

module.exports = {
  calculerDebit,
  calculerDebitsEquipement,
  memoriserInterfaces,
  tauxUtilisation,
  estIgnoree,
  oublier,
  _vider: () => {
    compteurs.clear();
    ignorees.clear();
  },
  _taille: () => compteurs.size,
  _interfacesMemorisees: () => ignorees.size,
};
