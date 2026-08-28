/**
 * parLots.js
 * Exécute un traitement sur une liste, N éléments à la fois.
 *
 * Extrait de discoveryService pour une raison précise : c'est la brique
 * qui borne la charge envoyée au réseau supervisé. Une erreur ici ne se
 * verrait pas dans les résultats — le scan rendrait les mêmes machines —
 * mais se verrait sur le réseau du client, sous forme de centaines de
 * connexions simultanées au lieu de quelques dizaines.
 *
 * Un défaut invisible dans les résultats et visible sur le réseau du
 * client mérite d'être isolé et testé pour lui-même. C'est l'objet de
 * tests/parLots.test.js, qui vérifie notamment que la limite n'est
 * JAMAIS dépassée, même transitoirement.
 */

/**
 * @param {Array} elements
 * @param {number} taille        nombre d'éléments traités simultanément
 * @param {function} traiter     async (element, index) -> résultat
 * @param {function} [surLot]    appelé après chaque lot : (traites, total)
 * @returns {Promise<Array>} les résultats, DANS L'ORDRE des éléments d'entrée
 */
async function parLots(elements, taille, traiter, surLot = null) {
  const liste = Array.isArray(elements) ? elements : [];

  // Une taille invalide (0, négative, NaN) ferait une boucle infinie :
  // `i += 0` ne progresse jamais. On retombe sur 1 — plus lent, jamais
  // bloqué. Un scan lent se remarque ; un serveur figé aussi, mais bien
  // plus tard et bien plus mal.
  const n = Number.isFinite(taille) && taille >= 1 ? Math.floor(taille) : 1;

  const resultats = [];
  for (let i = 0; i < liste.length; i += n) {
    const lot = liste.slice(i, i + n);

    // Promise.all conserve l'ordre du tableau qu'on lui donne, quel que
    // soit l'ordre d'achèvement. Combiné au traitement des lots l'un
    // après l'autre, l'ordre global est celui de l'entrée : le résultat
    // d'un scan ne dépend pas de quelle machine a répondu le plus vite.
    const lotResultats = await Promise.all(lot.map((el, j) => traiter(el, i + j)));
    resultats.push(...lotResultats);

    if (typeof surLot === "function") {
      surLot(Math.min(i + n, liste.length), liste.length);
    }
  }
  return resultats;
}

module.exports = { parLots };
