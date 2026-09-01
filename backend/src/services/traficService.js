/**
 * traficService.js
 * Calcul du débit réseau à partir des compteurs SNMP cumulés.
 *
 * ─────────────────────────────────────────────────────────────────────
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
 * ─────────────────────────────────────────────────────────────────────
 */

/** cle -> { inOctets, outOctets, timestamp } */
const compteurs = new Map();

/**
 * Interfaces à exclure du total d'un équipement.
 *
 * La boucle locale voit passer tout le trafic interne de la machine : la
 * compter reviendrait à doubler, voire tripler, la consommation réelle.
 * Les interfaces « null » (rejet Cisco) faussent de même.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI UNE LISTE DE MOTIFS PRÉCIS, ET NON UN SEUL MOTIF SOUPLE
 *
 * La version précédente s'écrivait `/^(lo|lo0|loopback|null\d*|…)/i` —
 * une seule expression, sans ancrage de fin. Le fragment `lo` seul y
 * suffisait donc à écarter TOUT nom commençant par ces deux lettres.
 *
 * Ce qu'elle excluait sans que personne ne s'en aperçoive :
 *
 *     « Local Area Connection »     ← la carte Ethernet standard
 *     « Local Area Connection 2 »     de tout poste Windows
 *
 * Sur un parc Windows, l'interface PRINCIPALE de chaque machine était
 * donc silencieusement retirée du calcul. L'équipement affichait un
 * trafic nul tout en fonctionnant parfaitement — le pire des défauts
 * pour un outil de supervision, puisqu'il ressemble à une bonne nouvelle.
 *
 * Les tests existants ne l'avaient pas vu : ils ne vérifiaient que des
 * noms Unix et Cisco. Un test ne protège que de ce qu'on a pensé à lui
 * soumettre.
 *
 * Chaque motif est désormais ancré, et chacun couvre une convention de
 * nommage identifiée. Ajouter un cas doit rester un geste explicite.
 * ─────────────────────────────────────────────────────────────────────
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

    const debit = calculerDebit(`${identifiant}:${index}`, iface, maintenant);
    const ignoree = estIgnoree(iface.nom);

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
}

module.exports = {
  calculerDebit,
  calculerDebitsEquipement,
  tauxUtilisation,
  estIgnoree,
  oublier,
  _vider: () => compteurs.clear(),
  _taille: () => compteurs.size,
};
