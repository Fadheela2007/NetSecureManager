/**
 * erreurReseau.js
 * Traduit une erreur de requête en message exploitable.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LE DÉFAUT QUE CE FICHIER CORRIGE
 *
 * Toutes les pages avalaient leurs erreurs — `.catch(() => {})` ou un
 * simple `console.error`. Une requête échouée laissait donc l'écran dans
 * l'état « chargé, mais vide », strictement identique à « il n'y a rien
 * à afficher ».
 *
 * Sur un outil de supervision, c'est le pire défaut possible : le
 * tableau de bord annonçait « Tout le parc répond » en vert alors que le
 * serveur était arrêté. L'outil dont le métier est de signaler les
 * pannes rassurait, précisément quand il ne voyait plus rien.
 *
 * Un écran vide doit pouvoir dire « je ne sais pas ». C'est un troisième
 * état, distinct de « tout va bien » et de « il manque une étape ».
 *
 * POURQUOI DISTINGUER LES CAUSES
 *
 * Serveur injoignable, session expirée, erreur serveur : trois causes,
 * trois actions différentes. Les réunir sous « une erreur est survenue »
 * oblige l'utilisateur à deviner laquelle — et devant une plateforme
 * qu'il évalue, il conclura que le produit est fragile.
 * ─────────────────────────────────────────────────────────────────────
 */

export function decrireErreur(err, contexte = "Les données") {
  const statut = err?.response?.status;

  if (statut === 401 || statut === 403) {
    return {
      titre: "Session expirée",
      detail: "Reconnectez-vous pour retrouver l'accès aux données.",
    };
  }

  // Pas de réponse du tout : la requête n'a jamais abouti. C'est le cas
  // le plus fréquent en démonstration — backend non démarré, ou arrêté
  // par un Ctrl+C oublié.
  if (!err?.response) {
    return {
      titre: "Le serveur ne répond pas",
      detail:
        "Vérifiez que le backend est démarré et joignable. " +
        "Aucune donnée n'est affichée : ce n'est pas un parc vide.",
    };
  }

  if (statut >= 500) {
    return {
      titre: `${contexte} n'ont pas pu être chargées`,
      detail: `Le serveur a répondu ${statut}. Consultez le journal du backend pour la cause.`,
    };
  }

  return {
    titre: `${contexte} n'ont pas pu être chargées`,
    detail:
      err?.response?.data?.error ||
      `Le serveur a répondu ${statut}. Réessayez, puis signalez le problème si cela persiste.`,
  };
}
