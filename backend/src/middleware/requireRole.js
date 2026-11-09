/**
 * middleware/requireRole.js
 * À utiliser après requireAuth.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE NOM N'A PAS CHANGÉ, LA DÉCISION SI
 *
 * Avant, ce fichier comparait le rôle de l'utilisateur à une liste écrite
 * en dur dans la route. Désormais il demande d'abord à la table
 * PERMISSION ce que ce rôle a le droit de faire SUR CET ÉCRAN, et la
 * liste écrite dans la route ne sert plus qu'à dire QUEL NIVEAU cette
 * route exige.
 *
 * C'est ce qui permet de n'avoir réécrit aucune des cinquante-trois
 * routes : elles portaient déjà l'information, il suffisait de la lire
 * autrement.
 *
 *   requireRole()                       -> il faut « voir »
 *   requireRole("admin", "operateur")   -> il faut « modifier »
 *   requireRole("admin")                -> il faut « administrer »
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE REFUS DIT CE QU'IL MANQUE, ET À QUI LE DEMANDER
 *
 * « Action non autorisée pour votre rôle » n'apprenait rien : ni ce qui
 * était refusé, ni s'il s'agissait d'un droit qu'on peut obtenir. La
 * personne se demandait si c'était une panne.
 *
 * La réponse nomme maintenant l'écran, le niveau qu'il faudrait, et le
 * fait qu'un administrateur peut le donner depuis la page Utilisateurs.
 * Un refus qu'on comprend se résout tout seul ; un refus opaque finit en
 * message à l'équipe.
 */

const permissions = require("../services/permissionsService");

/** Ce que la réponse dit, sans jamais révéler ce que contient l'écran. */
function refus(res, ecran, niveauAttendu) {
  const libelle = permissions.ECRANS[ecran]?.libelle || ecran || "cette section";
  return res.status(403).json({
    error: "Vous n'avez pas ce droit",
    ecran,
    niveau_requis: niveauAttendu,
    aide:
      `« ${libelle} » demande le niveau « ${niveauAttendu} ». ` +
      "Un administrateur peut vous l'accorder depuis la page Utilisateurs.",
  });
}

/**
 * @param {...string} rolesAutorises  les rôles historiquement acceptés.
 *   Ils servent à déduire le niveau exigé, et de REPLI quand la table
 *   PERMISSION ne dit rien (migration non passée).
 */
function requireRole(...rolesAutorises) {
  const niveauAttendu = permissions.niveauRequis(rolesAutorises);

  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ error: "Action non autorisée pour votre rôle" });
    }

    const ecran = permissions.ecranDuChemin(req.baseUrl + req.path);

    permissions
      .autorise(req.user.role, ecran, niveauAttendu)
      .then((verdict) => {
        /* `null` = la table ne dit rien sur ce couple rôle/écran. On
           retombe alors sur le comportement d'avant, au mot près. Voir
           permissionsService : on ne s'enferme pas dehors. */
        if (verdict === null) {
          if (!rolesAutorises.includes(req.user.role)) {
            return res
              .status(403)
              .json({ error: "Action non autorisée pour votre rôle" });
          }
          return next();
        }

        if (!verdict) return refus(res, ecran, niveauAttendu);
        next();
      })
      .catch(next);
  };
}

/**
 * Le plancher : « voir » sur l'écran demandé.
 *
 * ── POURQUOI IL FAUT UN MIDDLEWARE GLOBAL EN PLUS ──
 *
 * Les routes de CONSULTATION n'ont aucun requireRole — elles sont
 * ouvertes à tout compte connecté. Sans ce plancher, retirer à un rôle
 * l'écran Équipements n'aurait aucun effet : le menu disparaîtrait, mais
 * les routes répondraient encore à qui les appelle à la main. Un
 * cloisonnement que l'interface seule applique n'en est pas un.
 *
 * Monté APRÈS requireAuth et AVANT les routeurs protégés. Un chemin dont
 * on ne connaît pas l'écran passe : il finira en 404 par la voie
 * normale, ce qui est la bonne réponse pour une route qui n'existe pas.
 */
function plancherEcran(req, res, next) {
  if (!req.user) return next();

  const ecran = permissions.ecranDuChemin(req.originalUrl);
  if (!ecran) return next();

  permissions
    .autorise(req.user.role, ecran, "voir")
    .then((verdict) => {
      if (verdict === null || verdict) return next();
      refus(res, ecran, "voir");
    })
    .catch(next);
}

module.exports = { requireRole, plancherEcran };
