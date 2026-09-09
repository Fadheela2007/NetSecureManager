/**
 * tempsReelService.js
 * Diffusion des événements vers les interfaces ouvertes.
 *
 * POURQUOI CE SERVICE EXISTE
 *
 * Un serveur socket.io était instancié depuis le début, mais rien n'en
 * sortait : aucune émission dans tout le backend, et le frontend ne s'y
 * connectait pas. L'interface ne bougeait donc jamais toute seule — une
 * alerte n'apparaissait qu'après un rechargement manuel. Sur un outil de
 * supervision, c'est le défaut qui se voit le plus : on appuie sur F5
 * devant le client pour faire apparaître ce qu'on vient de provoquer.
 *
 * CE QU'IL NE FAIT PAS, DÉLIBÉRÉMENT
 *
 * Il ne transporte AUCUNE donnée métier. Un événement dit « quelque chose
 * a changé pour ce site », et l'interface va rechercher la donnée par les
 * routes normales — qui appliquent déjà le cloisonnement, les rôles et le
 * filtrage. Transporter les données dans l'événement obligerait à
 * réimplémenter ces contrôles ici, et deux implémentations d'une règle de
 * sécurité finissent toujours par diverger.
 *
 * LE CLOISONNEMENT S'APPLIQUE AUSSI ICI
 *
 * Chaque connexion rejoint le salon de SON site. Un compte rattaché à
 * Yaoundé ne reçoit jamais un événement du siège — sans quoi il saurait
 * qu'il se passe quelque chose ailleurs, ce qui est déjà une fuite.
 */

const jwt = require("jsonwebtoken");

const SALON_GLOBAL = "global";

/**
 * Référence au serveur, gardée ici plutôt que sur `app`.
 *
 * Le cycle de supervision et les tâches planifiées n'ont pas
 * l'application Express sous la main : la leur faire passer de fonction en
 * fonction encombrerait des signatures qui n'ont rien à voir avec le temps
 * réel. Une référence locale au module suffit, et `diffuser()` reste sans
 * effet tant qu'elle est nulle.
 */
let serveur = null;

/** Nom du salon d'un site. */
function salonDuSite(idSite) {
  return `site:${idSite}`;
}

/**
 * Branche l'authentification et l'affectation aux salons.
 *
 * Le jeton est lu dans `handshake.auth`, pas dans l'URL : un jeton passé
 * en paramètre d'URL se retrouve dans les journaux de tous les serveurs
 * intermédiaires, où il reste lisible longtemps après son expiration.
 */
function installer(io, jwtSecret) {
  serveur = io;

  io.use((socket, suite) => {
    const jeton = socket.handshake?.auth?.token;
    if (!jeton) return suite(new Error("authentification requise"));

    try {
      const utilisateur = jwt.verify(jeton, jwtSecret);
      socket.data.utilisateur = utilisateur;
      return suite();
    } catch {
      // Message volontairement vague côté client : distinguer « jeton
      // expiré » de « signature invalide » renseignerait un attaquant.
      return suite(new Error("authentification refusée"));
    }
  });

  io.on("connection", (socket) => {
    const u = socket.data.utilisateur;
    const portee = u?.id_site === undefined || u?.id_site === null ? null : Number(u.id_site);

    // Un compte global suit tous les sites ; un compte rattaché, le sien
    // seulement. C'est la même convention que porteeSite.js — une seule
    // règle, appliquée à deux endroits.
    socket.join(portee === null ? SALON_GLOBAL : salonDuSite(portee));
  });
}

/**
 * Signale qu'une chose a changé pour un site.
 *
 * NE LÈVE JAMAIS. Le temps réel est un confort ; il ne doit pas pouvoir
 * interrompre un cycle de supervision ni faire échouer une requête. C'est
 * la même règle que pour les notifications par courriel : signaler sans
 * interrompre.
 *
 * @param {number|null} idSite  le site concerné, null si global
 * @param {string} evenement  « alerte », « equipement », « scan »
 * @param {object} [details]  de quoi éviter un rechargement inutile —
 *                            jamais de donnée métier, voir l'en-tête.
 */
function diffuser(idSite, evenement, details = {}) {
  // Sans WEBSOCKET_ORIGINE, aucun serveur n'a été installé et la
  // plateforme fonctionne exactement comme avant. Aucun appelant ne doit
  // avoir à le vérifier.
  if (!serveur) return;

  try {
    const charge = { evenement, id_site: idSite ?? null, ...details };

    // Les comptes globaux reçoivent tout ; le salon du site reçoit ce qui
    // le concerne. Un compte rattaché à un autre site ne voit rien passer.
    serveur.to(SALON_GLOBAL).emit(evenement, charge);
    if (idSite !== null && idSite !== undefined) {
      serveur.to(salonDuSite(idSite)).emit(evenement, charge);
    }
  } catch (err) {
    console.error("Diffusion temps réel échouée:", err.message);
  }
}

module.exports = { installer, diffuser, salonDuSite, SALON_GLOBAL };
