import { io } from "socket.io-client";

/**
 * Connexion temps réel à la plateforme.
 *
 * `socket.io-client` était déclaré dans les dépendances sans être importé
 * nulle part : le serveur pouvait émettre, personne n'écoutait. L'interface
 * ne bougeait donc jamais d'elle-même — une alerte n'apparaissait qu'après
 * un rechargement manuel, ce qui, sur un outil de supervision, se voit
 * immédiatement.
 *
 * CE QUI TRANSITE : « quelque chose a changé pour ce site », rien d'autre.
 * Les données sont ensuite relues par les routes normales, qui appliquent
 * le cloisonnement et les rôles. Une règle de sécurité écrite deux fois
 * finit toujours par diverger.
 *
 * FACULTATIF PAR CONSTRUCTION. Sans WEBSOCKET_ORIGINE côté serveur, la
 * connexion échoue et l'application continue exactement comme avant. Aucun
 * écran ne doit dépendre du temps réel pour afficher ses données.
 */

const URL_SOCKET =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.VITE_API_URL || "http://localhost:5000/api").replace(/\/api\/?$/, "");

let connexion = null;

/**
 * Ouvre la connexion, ou renvoie celle qui existe déjà.
 *
 * Le jeton passe par l'option `auth` et NON par l'URL : un jeton en
 * paramètre d'URL se retrouve dans les journaux de tous les serveurs
 * intermédiaires, où il reste lisible bien après son expiration.
 */
export function connecter(jeton) {
  if (!jeton) return null;
  if (connexion) return connexion;

  connexion = io(URL_SOCKET, {
    auth: { token: jeton },
    // Pas de reconnexion infinie : si le serveur n'a pas le temps réel
    // activé, insister remplirait la console d'erreurs à chaque seconde
    // pour une fonction facultative.
    reconnectionAttempts: 5,
    reconnectionDelay: 2000,
    autoConnect: true,
  });

  connexion.on("connect_error", (err) => {
    // Silencieux au-delà d'une ligne : l'absence de temps réel est un
    // fonctionnement prévu, pas une panne à signaler à l'utilisateur.
    console.info("Temps réel indisponible :", err.message);
  });

  return connexion;
}

/** Ferme la connexion — à la déconnexion de l'utilisateur. */
export function deconnecter() {
  if (connexion) {
    connexion.close();
    connexion = null;
  }
}

/**
 * S'abonne à un événement et renvoie la fonction de désabonnement.
 *
 * @param {string} evenement  « alerte », « equipement », « scan »
 * @param {function} rappel
 * @returns {function} à appeler au démontage du composant
 */
export function ecouter(evenement, rappel) {
  if (!connexion) return () => {};
  connexion.on(evenement, rappel);
  return () => {
    if (connexion) connexion.off(evenement, rappel);
  };
}

/* =====================================================================
   RAFRAÎCHISSEMENT AUTOMATIQUE D'UN ÉCRAN

   POURQUOI UN CROCHET PLUTÔT QU'UN `ecouter()` DANS CHAQUE PAGE.

   Trois écrans s'abonnaient déjà aux événements, chacun à sa façon. Les
   autres — Équipements, Bande passante, Incidents — ne s'abonnaient pas
   du tout et n'ont jamais bougé d'eux-mêmes.

   POURQUOI IL Y A AUSSI UNE SCRUTATION, ET PAS SEULEMENT DES ÉVÉNEMENTS.

   Le temps réel est facultatif par construction : sans WEBSOCKET_ORIGINE
   côté serveur, aucune connexion ne s'établit. Un écran qui ne se
   rafraîchit QUE sur événement redevient alors figé — et le réglage qui
   décide de ce comportement est une ligne de .env que personne ne relit.
   La scrutation garantit un plancher : au pire, l'écran a une minute de
   retard ; il n'est jamais mort.

   Les deux se complètent au lieu de se doubler : un événement rafraîchit
   dans la seconde, la scrutation rattrape ce que les événements ne
   couvrent pas.

   POURQUOI ON S'ARRÊTE QUAND L'ONGLET EST CACHÉ.

   Un poste de supervision garde la plateforme ouverte toute la journée,
   souvent dans un onglet d'arrière-plan. Scruter sans interruption, c'est
   une requête par minute et par écran ouvert, pendant huit heures, pour
   des pixels que personne ne regarde. On reprend — et on rafraîchit
   immédiatement — au retour sur l'onglet, ce qui est le moment où
   l'utilisateur veut justement voir du frais.
   ===================================================================== */

/** Intervalle de secours, en millisecondes. */
const SCRUTATION_MS = 60000;

/**
 * Rafraîchit un écran sur événement ET à intervalle régulier.
 *
 * À utiliser dans un composant React :
 *
 *   useRafraichissementAuto(rafraichir, ["cycle", "equipement"]);
 *
 * @param {function} rafraichir  la fonction de rechargement de l'écran
 * @param {string[]} evenements  les événements qui la déclenchent
 * @param {object}   options     { intervalleMs, actif }
 * @returns {function} désabonnement (appelé par React au démontage)
 */
export function brancherRafraichissement(rafraichir, evenements = [], options = {}) {
  const intervalleMs = options.intervalleMs || SCRUTATION_MS;
  const desabonnements = [];

  // `rafraichir` peut être recréée à chaque rendu par le composant : on
  // garde une référence indirecte pour ne pas réabonner à chaque fois.
  const declencher = () => {
    try {
      rafraichir();
    } catch (err) {
      // Un écran qui échoue à se rafraîchir ne doit pas casser les autres
      // abonnements ni le minuteur.
      console.info("Rafraîchissement automatique ignoré :", err?.message);
    }
  };

  for (const e of evenements) desabonnements.push(ecouter(e, declencher));

  let minuteur = null;
  const armer = () => {
    if (minuteur === null) minuteur = setInterval(declencher, intervalleMs);
  };
  const desarmer = () => {
    if (minuteur !== null) {
      clearInterval(minuteur);
      minuteur = null;
    }
  };

  const surVisibilite = () => {
    if (document.hidden) {
      desarmer();
    } else {
      // Rafraîchir AVANT de réarmer : au retour sur l'onglet, l'écran
      // peut avoir une heure de retard, et attendre une minute de plus
      // serait exactement le moment où l'on regarde.
      declencher();
      armer();
    }
  };

  if (!document.hidden) armer();
  document.addEventListener("visibilitychange", surVisibilite);

  return () => {
    desarmer();
    document.removeEventListener("visibilitychange", surVisibilite);
    for (const d of desabonnements) d();
  };
}
