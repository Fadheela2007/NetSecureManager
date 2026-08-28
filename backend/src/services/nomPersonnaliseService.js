/**
 * nomPersonnaliseService.js
 * Validation et nettoyage d'un nom saisi par l'exploitant.
 *
 * Séparé de la route pour être testable sans base ni serveur : la
 * validation est la partie qui peut laisser passer une valeur nuisible,
 * et c'est celle qu'il faut pouvoir éprouver sur des dizaines de cas.
 */

const LONGUEUR_MAX = 150;

/**
 * Nettoie un nom saisi.
 *
 * CE QUI EST RETIRÉ, ET POURQUOI
 *
 * • Les caractères de contrôle. Un retour à la ligne ou une tabulation
 *   collés depuis un tableur casse l'alignement de la liste et, plus
 *   sérieusement, permet de faire passer un nom pour deux lignes dans un
 *   rapport exporté en texte.
 *
 * • Les espaces multiples, réduits à un seul. « Imprimante   RH » et
 *   « Imprimante RH » désignent la même machine ; les laisser
 *   distincts crée des doublons invisibles à l'œil.
 *
 * • Les espaces de début et de fin, invisibles mais qui font échouer
 *   toute comparaison.
 *
 * CE QUI N'EST PAS RETIRÉ : les accents, apostrophes et tirets. Un nom
 * français en contient, et les supprimer donnerait « Imprimante
 * comptabilite » — une correction que personne n'a demandée.
 */
function nettoyerNomPersonnalise(valeur) {
  if (valeur === null || valeur === undefined) return null;

  const nettoye = String(valeur)
    // Caractères de contrôle, écrits en échappements et non en
    // littéraux : des octets invisibles dans le code source sont
    // impossibles à relire, et se perdent au premier copier-coller.
    //
    //   \u0000-\u001F  contrôles ASCII (tabulation, retours à la ligne)
    //   \u007F-\u009F  suppression et contrôles étendus
    //   \u200B-\u200F  espaces et marques de direction invisibles
    //   \u202A-\u202E  forçage de direction du texte
    //   \uFEFF         marque d'ordre des octets
    //
    // Les quatre dernières familles sont invisibles à l'affichage mais
    // bien présentes dans la valeur : collées depuis un tableur ou une
    // page web, elles rendent deux noms identiques à l'œil impossibles
    // à rapprocher.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Une chaîne vide vaut « pas de nom personnalisé » : c'est ainsi qu'on
  // efface le nom pour revenir à celui découvert automatiquement.
  return nettoye === "" ? null : nettoye.slice(0, LONGUEUR_MAX);
}

/**
 * Valide un nom nettoyé. Renvoie un message d'erreur, ou null si tout va
 * bien. Effacer le nom (null) est toujours autorisé.
 */
function validerNomPersonnalise(nom) {
  if (nom === null) return null;

  if (nom.length > LONGUEUR_MAX) {
    return `Le nom ne peut pas dépasser ${LONGUEUR_MAX} caractères.`;
  }

  // Un nom fait uniquement de ponctuation n'identifie rien et rend la
  // ligne plus difficile à lire qu'une case vide.
  if (!/[\p{L}\p{N}]/u.test(nom)) {
    return "Le nom doit contenir au moins une lettre ou un chiffre.";
  }

  return null;
}

/**
 * Nom à afficher, dans l'ordre de priorité.
 *
 * Le nom personnalisé prime sur tout le reste — y compris SNMP : c'est
 * une décision humaine, elle l'emporte sur une découverte automatique.
 * À défaut, on retombe sur le nom découvert, puis sur l'adresse, qui
 * identifie toujours quelque chose.
 */
function nomAffiche(equipement) {
  if (!equipement) return "";
  const perso = nettoyerNomPersonnalise(equipement.nom_personnalise);
  if (perso) return perso;
  const decouvert = equipement.nom ? String(equipement.nom).trim() : "";
  if (decouvert) return decouvert;
  return equipement.adresse_ip || "";
}

module.exports = {
  nettoyerNomPersonnalise,
  validerNomPersonnalise,
  nomAffiche,
  LONGUEUR_MAX,
};
