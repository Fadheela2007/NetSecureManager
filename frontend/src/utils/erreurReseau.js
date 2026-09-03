/**
 * erreurReseau.js
 * Traduit une erreur de requête en message exploitable.
 *
 * Les pages avalaient leurs erreurs — `.catch(() => {})` ou un
 * `console.error`. Une requête échouée laissait l'écran « chargé mais
 * vide », strictement identique à « il n'y a rien à afficher ». Le tableau
 * de bord annonçait donc « tout le parc répond » en vert alors que le
 * serveur était arrêté : l'outil dont le métier est de signaler les pannes
 * rassurait précisément quand il ne voyait plus rien.
 *
 * Un écran vide doit pouvoir dire « je ne sais pas » — un troisième état,
 * distinct de « tout va bien » et de « il manque une étape ».
 *
 * Les causes sont distinguées parce qu'elles appellent des actions
 * différentes : serveur injoignable, session expirée, erreur serveur.
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
