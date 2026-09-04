/**
 * limiteurConnexion.js
 * Freine les tentatives de connexion répétées.
 *
 * `POST /api/auth/login` acceptait un nombre illimité de tentatives, sur
 * le point d'entrée le plus exposé de la plateforme.
 *
 * Deux compteurs, aux rôles distincts :
 *
 *   • par ADRESSE — défense principale. Un attaquant opère depuis un
 *     nombre limité de machines ; bloquer l'adresse arrête l'attaque.
 *   • par COMPTE — volontairement plus permissif. Bloquer un compte après
 *     cinq échecs permettrait à n'importe qui de verrouiller votre
 *     administrateur en saisissant de faux mots de passe : la protection
 *     deviendrait l'attaque. Ce compteur ralentit, il ne ferme jamais.
 *
 * L'état est en mémoire : un redémarrage remet les compteurs à zéro, et
 * deux serveurs ne les partagent pas. Limite assumée à l'échelle visée —
 * le jour où la plateforme tourne sur plusieurs serveurs, c'est ce
 * fichier qu'il faudra changer, et lui seul.
 */
/** Fenêtre d'observation : au-delà, les échecs anciens sont oubliés. */
const FENETRE_MS = 15 * 60 * 1000;

/** Échecs tolérés depuis une même adresse avant blocage. */
const MAX_PAR_ADRESSE = 10;

/** Échecs sur un même compte avant ralentissement progressif. */
const SEUIL_PAR_COMPTE = 5;

/** Plafond du ralentissement : au-delà, inutile d'attendre davantage. */
const DELAI_MAX_MS = 5000;

/** Au-delà de ce nombre d'entrées, on purge les plus anciennes. */
const MAX_ENTREES = 10000;

const parAdresse = new Map();
const parCompte = new Map();

function maintenant() {
  return Date.now();
}

/** Retire les échecs sortis de la fenêtre d'observation. */
function echecsRecents(registre, cle, instant) {
  const echecs = registre.get(cle);
  if (!echecs) return [];
  const recents = echecs.filter((t) => instant - t < FENETRE_MS);
  if (recents.length === 0) registre.delete(cle);
  else registre.set(cle, recents);
  return recents;
}

/**
 * Empêche les registres de croître sans fin.
 *
 * Sans cette purge, une attaque distribuée depuis des milliers
 * d'adresses ferait grossir la mémoire indéfiniment — la protection
 * deviendrait elle-même le moyen de faire tomber le serveur.
 */
function purger(registre, instant) {
  if (registre.size <= MAX_ENTREES) return;
  for (const [cle, echecs] of registre) {
    if (echecs.every((t) => instant - t >= FENETRE_MS)) registre.delete(cle);
  }
  // Si la purge par ancienneté ne suffit pas, on vide : mieux vaut
  // repartir de zéro que consommer toute la mémoire disponible.
  if (registre.size > MAX_ENTREES) registre.clear();
}

/**
 * Décide si une tentative peut avoir lieu.
 *
 * Renvoie :
 *   { autorise: true,  delaiMs }              — à laisser passer, après attente
 *   { autorise: false, resteMs, echecs }      — à refuser
 */
function verifier(adresse, email, instant = maintenant()) {
  const cleAdresse = String(adresse || "inconnue");
  const cleCompte = String(email || "").toLowerCase();

  const echecsAdresse = echecsRecents(parAdresse, cleAdresse, instant);

  if (echecsAdresse.length >= MAX_PAR_ADRESSE) {
    // Le blocage court à partir du DERNIER échec enregistré, et non du
    // premier : quelqu'un qui a échoué dix fois de suite attend un quart
    // d'heure après sa dernière tentative, pas après sa première.
    //
    // À noter : une tentative REFUSÉE par ce blocage n'est pas comptée
    // comme un échec — on sort ici avant `enregistrerEchec`. Marteler la
    // porte close ne prolonge donc pas l'attente. C'est délibéré : dans
    // le cas contraire, un onglet resté ouvert qui réessaie tout seul
    // maintiendrait un utilisateur légitime dehors indéfiniment.
    const dernier = Math.max(...echecsAdresse);
    return {
      autorise: false,
      resteMs: Math.max(0, FENETRE_MS - (instant - dernier)),
      echecs: echecsAdresse.length,
    };
  }

  const echecsCompte = cleCompte ? echecsRecents(parCompte, cleCompte, instant) : [];

  // Ralentissement progressif, jamais de blocage : voir l'en-tête du
  // fichier sur le risque de verrouillage d'un compte légitime.
  let delaiMs = 0;
  if (echecsCompte.length >= SEUIL_PAR_COMPTE) {
    const surplus = echecsCompte.length - SEUIL_PAR_COMPTE + 1;
    delaiMs = Math.min(DELAI_MAX_MS, 250 * 2 ** (surplus - 1));
  }

  return { autorise: true, delaiMs, echecs: echecsAdresse.length };
}

/** Enregistre un échec d'authentification. */
function enregistrerEchec(adresse, email, instant = maintenant()) {
  const cleAdresse = String(adresse || "inconnue");
  const cleCompte = String(email || "").toLowerCase();

  parAdresse.set(cleAdresse, [...echecsRecents(parAdresse, cleAdresse, instant), instant]);
  if (cleCompte) {
    parCompte.set(cleCompte, [...echecsRecents(parCompte, cleCompte, instant), instant]);
  }

  purger(parAdresse, instant);
  purger(parCompte, instant);
}

/**
 * Efface les compteurs après une connexion réussie.
 *
 * Sans cela, un utilisateur qui s'est trompé plusieurs fois avant de
 * réussir resterait ralenti pendant un quart d'heure — puni pour avoir
 * fini par entrer le bon mot de passe.
 */
function enregistrerSucces(adresse, email) {
  parAdresse.delete(String(adresse || "inconnue"));
  const cleCompte = String(email || "").toLowerCase();
  if (cleCompte) parCompte.delete(cleCompte);
}

/** Remise à zéro complète — réservée aux tests. */
function reinitialiser() {
  parAdresse.clear();
  parCompte.clear();
}

module.exports = {
  verifier,
  enregistrerEchec,
  enregistrerSucces,
  reinitialiser,
  FENETRE_MS,
  MAX_PAR_ADRESSE,
  SEUIL_PAR_COMPTE,
  DELAI_MAX_MS,
};
