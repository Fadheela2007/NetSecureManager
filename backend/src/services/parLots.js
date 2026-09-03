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

  // Une taille invalide (0, négative, NaN) donnerait une file sans
  // ouvrier, qui ne démarrerait jamais. On retombe sur 1 — plus lent,
  // jamais bloqué. Un scan lent se remarque ; un serveur figé aussi, mais
  // bien plus tard et bien plus mal.
  const n = Number.isFinite(taille) && taille >= 1 ? Math.floor(taille) : 1;

  // File d'attente, et non lots figés : la version précédente attendait
  // que N éléments soient tous terminés avant d'en lancer N autres, si
  // bien qu'un lot coûtait le temps de son élément le plus lent. Sur un
  // scan, les durées vont de 1 s à 25 s par machine.
  //
  // N ouvriers tirent dans une file commune : toujours N en cours tant
  // qu'il en reste, jamais plus — c'est la borne que ce fichier défend.
  // L'ordre des résultats reste celui de l'entrée (écriture par index),
  // seul l'ordre d'exécution est dynamique.
  const resultats = new Array(liste.length);
  let prochain = 0;
  let termines = 0;

  async function ouvrier() {
    for (;;) {
      // Lecture ET incrément sans await entre les deux : deux ouvriers ne
      // peuvent pas recevoir le même index.
      const index = prochain++;
      if (index >= liste.length) return;

      resultats[index] = await traiter(liste[index], index);

      termines++;
      if (typeof surLot === "function") surLot(termines, liste.length);
    }
  }

  // Pas plus d'ouvriers que d'éléments : sur une liste de 2 avec N = 100,
  // on n'en lance que 2.
  await Promise.all(
    Array.from({ length: Math.min(n, liste.length) }, () => ouvrier())
  );

  return resultats;
}

module.exports = { parLots };
