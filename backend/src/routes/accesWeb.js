/**
 * routes/accesWeb.js
 * Contrôle des accès web par blocage DNS.
 *
 * AUCUNE ROUTE DE CE FICHIER NE PEUT RÉVÉLER LA NAVIGATION DE QUELQU'UN.
 *
 * Les statistiques renvoyées sont agrégées par (site, jour, catégorie) :
 * ni adresse IP, ni nom de domaine demandé, ni utilisateur. Ce n'est pas
 * un filtrage appliqué à la sortie, c'est que la donnée n'existe pas en
 * base — voir le commentaire d'en-tête de la migration
 * 2026-08-19-controle-acces-web.sql.
 */

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { tracer } = require("../services/journal");
const { clauseSite, siteAutorise, porteeDe } = require("../middleware/porteeSite");
const {
  compilerPolitique,
  genererDnsmasq,
  genererReglesPareFeu,
  normaliserDomaine,
} = require("../services/politiqueWebService");

/** Erreur MySQL « colonne/table inconnue » : migration non exécutée. */
function schemaAbsent(err) {
  return (
    !!err &&
    (err.code === "ER_NO_SUCH_TABLE" ||
      err.errno === 1146 ||
      err.code === "ER_BAD_FIELD_ERROR" ||
      err.errno === 1054)
  );
}

/**
 * Récupère la politique d'un site, ou la politique par défaut.
 *
 * id_site NULL = politique par défaut, appliquée à tout site qui n'a pas
 * la sienne. Même convention que UTILISATEUR.id_site : un seul modèle
 * mental pour toute la plateforme.
 */
async function chargerPolitique(idSite) {
  const [rows] = await db.query(
    `SELECT * FROM POLITIQUE_WEB
     WHERE id_site <=> ? OR id_site IS NULL
     ORDER BY id_site IS NULL
     LIMIT 1`,
    [idSite ?? null]
  );
  return rows[0] || null;
}

/**
 * Cette politique est-elle dans le périmètre de l'appelant ?
 *
 * POURQUOI CE CONTRÔLE EXISTE. Les routes qui ajoutent ou suppriment un
 * domaine reçoivent un identifiant de POLITIQUE, pas un identifiant de
 * SITE — et personne ne vérifiait à qui cette politique appartenait. Un
 * administrateur rattaché au site 2 pouvait donc, en changeant un nombre
 * dans l'URL, débloquer une catégorie sur le site 1 ou ajouter une règle
 * de blocage chez un autre client. Le cloisonnement était appliqué
 * partout sauf là où l'identifiant ne portait pas le mot « site ».
 *
 * La politique par défaut (id_site NULL) vaut pour tous les sites qui
 * n'ont pas la leur : elle est donc réservée à un administrateur global.
 *
 * @returns {Promise<{ok: true} | {ok: false, statut: number, erreur: string}>}
 */
async function politiqueDansPortee(req, idPolitique) {
  const [rows] = await db.query(
    "SELECT id_site FROM POLITIQUE_WEB WHERE id_politique = ?",
    [idPolitique]
  );
  if (rows.length === 0) {
    return { ok: false, statut: 404, erreur: "Politique introuvable" };
  }

  const portee = porteeDe(req);
  if (portee === null) return { ok: true };

  if (rows[0].id_site === null) {
    return {
      ok: false,
      statut: 403,
      erreur: "Seul un administrateur global peut modifier la politique par défaut",
    };
  }
  if (rows[0].id_site !== portee) {
    // 404 et non 403 : un 403 confirmerait l'existence d'une politique
    // appartenant à un autre site.
    return { ok: false, statut: 404, erreur: "Politique introuvable" };
  }
  return { ok: true };
}

/** Domaines des catégories actives + règles manuelles d'une politique. */
async function chargerContenu(idPolitique) {
  const [categories] = await db.query(
    `SELECT c.id_categorie, c.code, c.libelle, c.nb_domaines, c.date_import
     FROM POLITIQUE_CATEGORIE pc
     JOIN CATEGORIE_WEB c ON c.id_categorie = pc.id_categorie
     WHERE pc.id_politique = ?
     ORDER BY c.libelle`,
    [idPolitique]
  );

  /* ── LES RÈGLES ARRIVÉES À ÉCHÉANCE SONT RETIRÉES ICI ──

     Une suppression dans une fonction de LECTURE demande à être
     justifiée, parce que c'est normalement une mauvaise idée.

     L'alternative était une tâche planifiée. Elle aurait un défaut
     rédhibitoire : entre l'échéance et le passage de la tâche, la
     politique servie aux agents contiendrait encore la règle. Un
     blocage annoncé pour « 2 heures » durerait donc jusqu'à la
     prochaine exécution — et un exploitant qui constate que son
     déblocage ne prend pas effet à l'heure dite cesse de faire
     confiance à la fonction, définitivement.

     Ici, la politique est purgée au moment même où on la demande.
     L'incrément de `version` qui suit est ce qui prévient les agents :
     ils voient un numéro plus élevé et retéléchargent la configuration.
     Sans lui, la règle disparaîtrait de l'écran en continuant de
     bloquer sur le terrain — le pire des deux mondes. */
  let nbExpirees = 0;
  if (expirationDisponible !== false) {
    try {
      const [purge] = await db.query(
        `DELETE FROM POLITIQUE_DOMAINE
          WHERE id_politique = ? AND date_fin IS NOT NULL AND date_fin <= NOW()`,
        [idPolitique]
      );
      nbExpirees = purge.affectedRows || 0;
      expirationDisponible = true;
      if (nbExpirees > 0) {
        await db.query(
          "UPDATE POLITIQUE_WEB SET version = version + 1 WHERE id_politique = ?",
          [idPolitique]
        );
        console.log(
          `Accès web — ${nbExpirees} règle(s) arrivée(s) à échéance, retirée(s) de la politique #${idPolitique}.`
        );
      }
    } catch (err) {
      if (colonneAbsente(err)) signalerExpirationIndisponible();
      else throw err;
    }
  }

  const champs = expirationDisponible
    ? "id_regle, domaine, action, commentaire, date_creation, date_fin, origine, cree_par"
    : "id_regle, domaine, action, commentaire, date_creation";

  const [manuelles] = await db.query(
    `SELECT ${champs}
     FROM POLITIQUE_DOMAINE WHERE id_politique = ?
     ORDER BY action, domaine`,
    [idPolitique]
  );

  return {
    categories,
    manuelles,
    expiration_disponible: expirationDisponible === true,
    nb_expirees_retirees: nbExpirees,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   DÉGRADATION GRACIEUSE QUAND LA MIGRATION N'EST PAS APPLIQUÉE

   `null` = on n'a pas encore essayé, `true` = les colonnes existent,
   `false` = elles manquent. Dans ce dernier cas tout continue de
   fonctionner exactement comme avant : les règles sont permanentes, et
   l'interface n'offre pas une échéance qu'elle ne saurait pas tenir.

   Le contraire — proposer un champ « expire dans 2 heures » que la base
   ne sait pas stocker — produirait un blocage permanent annoncé comme
   temporaire. C'est la panne qu'on cherche précisément à empêcher.
   ═══════════════════════════════════════════════════════════════════════ */
let expirationDisponible = null;
let expirationSignalee = false;

function colonneAbsente(err) {
  return err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054);
}

function signalerExpirationIndisponible() {
  expirationDisponible = false;
  if (expirationSignalee) return;
  expirationSignalee = true;
  console.warn(
    "\n⚠  Accès web — les blocages à durée limitée ne sont pas disponibles :\n" +
      "   la migration backend/migrations/2026-09-28-blocage-temporaire.sql\n" +
      "   n'est pas appliquée. Les règles restent permanentes.\n"
  );
}

// LECTURE

/**
 * GET /api/acces-web/categories
 *
 * `nb_domaines` et `date_import` sont renvoyés exprès : une catégorie
 * cochée mais vide ne bloque rien, et une liste importée il y a deux ans
 * ne vaut plus grand-chose. L'interface doit pouvoir le dire plutôt que
 * d'afficher une case cochée rassurante.
 */
router.get("/acces-web/categories", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id_categorie, code, libelle, description, source, nb_domaines, date_import
       FROM CATEGORIE_WEB ORDER BY libelle`
    );
    res.json(rows);
  } catch (err) {
    if (schemaAbsent(err)) {
      return res.status(503).json({
        error: "Fonction non installée",
        aide: "Exécutez la migration backend/migrations/2026-08-19-controle-acces-web.sql",
      });
    }
    throw err;
  }
});

/** GET /api/acces-web/politique?id_site=2 */
router.get("/acces-web/politique", async (req, res) => {
  const idSite = req.query.id_site ? Number(req.query.id_site) : null;
  if (idSite && !siteAutorise(req, idSite)) {
    return res.status(403).json({ error: "Site hors de votre périmètre" });
  }

  try {
    const politique = await chargerPolitique(idSite);
    if (!politique) {
      // Aucune politique : ce n'est pas une erreur, c'est l'état initial.
      return res.json({ politique: null, categories: [], manuelles: [] });
    }
    const contenu = await chargerContenu(politique.id_politique);
    res.json({ politique, ...contenu });
  } catch (err) {
    if (schemaAbsent(err)) {
      return res.status(503).json({
        error: "Fonction non installée",
        aide: "Exécutez la migration backend/migrations/2026-08-19-controle-acces-web.sql",
      });
    }
    throw err;
  }
});

/**
 * GET /api/acces-web/apercu?id_site=2
 *
 * Ce que la politique donnerait RÉELLEMENT, avant de l'activer.
 *
 * Cet aperçu existe parce que l'écart entre « j'ai coché trois cases » et
 * « voici les 214 890 domaines qui seront bloqués, dont ceux-ci que vous
 * avez exclus » est exactement là où se logent les mauvaises surprises.
 * Le voir avant vaut mieux que le découvrir quand la comptabilité
 * n'accède plus à son logiciel.
 */
router.get("/acces-web/apercu", async (req, res) => {
  const idSite = req.query.id_site ? Number(req.query.id_site) : null;
  if (idSite && !siteAutorise(req, idSite)) {
    return res.status(403).json({ error: "Site hors de votre périmètre" });
  }

  const politique = await chargerPolitique(idSite);
  if (!politique) return res.json({ politique: null });

  const { categories, manuelles } = await chargerContenu(politique.id_politique);

  // On ne charge PAS les 300 000 domaines pour un aperçu : seuls le
  // décompte et un échantillon sont utiles à l'écran. Le calcul complet
  // n'a lieu qu'au moment où l'agent réclame sa configuration.
  const totalCategories = categories.reduce((s, c) => s + Number(c.nb_domaines || 0), 0);

  const [echantillon] = categories.length
    ? await db.query(
        `SELECT domaine FROM DOMAINE_CATEGORIE
         WHERE id_categorie IN (${categories.map(() => "?").join(",")})
         ORDER BY domaine LIMIT 20`,
        categories.map((c) => c.id_categorie)
      )
    : [[]];

  const compilee = compilerPolitique({
    domainesCategories: echantillon.map((e) => e.domaine),
    reglesManuelles: manuelles,
  });

  res.json({
    politique,
    categories,
    manuelles,
    total_domaines_categories: totalCategories,
    echantillon: compilee.bloquer,
    regles_rejetees: compilee.stats.exemples_rejetes,
    // La liste de règles pare-feu est fournie ici pour que l'écran puisse
    // la proposer en copier-coller : sans elle, le blocage DNS reste
    // contournable et la fonction ne tient pas sa promesse.
    pare_feu: {
      iptables: genererReglesPareFeu(req.query.ip_agent || "<IP-DE-L-AGENT>", "iptables"),
      mikrotik: genererReglesPareFeu(req.query.ip_agent || "<IP-DE-L-AGENT>", "mikrotik"),
      autre: genererReglesPareFeu(req.query.ip_agent || "<IP-DE-L-AGENT>", "pfsense"),
    },
  });
});

/**
 * GET /api/acces-web/stats?id_site=2&jours=30
 *
 * Comptage agrégé. Rappel de ce que cette route ne peut PAS renvoyer,
 * quelle que soit la requête : qui, depuis quelle machine, vers quel
 * domaine. Ces colonnes n'existent pas.
 */
router.get("/acces-web/stats", async (req, res) => {
  let jours = Number(req.query.jours);
  if (!Number.isFinite(jours) || jours <= 0) jours = 30;
  jours = Math.min(Math.floor(jours), 365);

  const portee = clauseSite(req, "s.id_site");

  try {
    const [rows] = await db.query(
      `SELECT s.jour, c.code, c.libelle, SUM(s.nb_requetes) AS nb
       FROM STAT_BLOCAGE s
       LEFT JOIN CATEGORIE_WEB c ON c.id_categorie = s.id_categorie
       WHERE s.jour >= CURDATE() - INTERVAL ${jours} DAY AND ${portee.clause}
       GROUP BY s.jour, c.code, c.libelle
       ORDER BY s.jour`,
      portee.params
    );
    res.json({ periode_jours: jours, stats: rows });
  } catch (err) {
    if (schemaAbsent(err)) return res.json({ periode_jours: jours, stats: [] });
    throw err;
  }
});

// ÉCRITURE — administrateurs uniquement

/**
 * PUT /api/acces-web/politique
 * body : { id_site, nom, active, message_blocage, categories: [id, …] }
 *
 * Toute modification incrémente `version`. C'est ce compteur qui déclenche
 * le rechargement chez l'agent : sans lui, chaque agent retéléchargerait
 * plusieurs mégaoctets de domaines à chaque cycle de cinq minutes.
 */
router.put("/acces-web/politique", requireRole("admin"), async (req, res) => {
  const { id_site = null, nom, active, message_blocage, categories } = req.body || {};

  // `id_site` vaut null PAR DÉFAUT dans cette route : l'ancien test
  // `id_site !== null && ...` ne se déclenchait donc jamais sur l'appel le
  // plus courant. Un administrateur rattaché qui omettait le champ
  // réécrivait la politique appliquée à toute la plateforme.
  if (id_site === null) {
    if (porteeDe(req) !== null) {
      return res.status(403).json({
        error: "Seul un administrateur global peut modifier la politique par défaut",
        aide: "Précisez id_site pour agir sur la politique de votre propre site.",
      });
    }
  } else if (!siteAutorise(req, id_site)) {
    return res.status(403).json({ error: "Site hors de votre périmètre" });
  }
  if (!nom || typeof nom !== "string" || !nom.trim()) {
    return res.status(400).json({ error: "Le nom de la politique est requis" });
  }

  const connexion = await db.getConnection();
  try {
    await connexion.beginTransaction();

    const [existantes] = await connexion.query(
      "SELECT id_politique FROM POLITIQUE_WEB WHERE id_site <=> ?",
      [id_site]
    );

    let idPolitique;
    if (existantes.length > 0) {
      idPolitique = existantes[0].id_politique;
      await connexion.query(
        `UPDATE POLITIQUE_WEB
         SET nom = ?, active = ?, message_blocage = ?, version = version + 1
         WHERE id_politique = ?`,
        [nom.trim(), active ? 1 : 0, message_blocage || null, idPolitique]
      );
    } else {
      const [r] = await connexion.query(
        `INSERT INTO POLITIQUE_WEB (id_site, nom, active, message_blocage, version)
         VALUES (?, ?, ?, ?, 1)`,
        [id_site, nom.trim(), active ? 1 : 0, message_blocage || null]
      );
      idPolitique = r.insertId;
    }

    // Remplacement intégral des catégories : plus simple à raisonner
    // qu'un différentiel, et sans risque de laisser une catégorie
    // fantôme active après une manipulation ratée dans l'interface.
    await connexion.query("DELETE FROM POLITIQUE_CATEGORIE WHERE id_politique = ?", [idPolitique]);

    const ids = Array.isArray(categories) ? categories.map(Number).filter(Number.isInteger) : [];
    if (ids.length > 0) {
      await connexion.query(
        `INSERT INTO POLITIQUE_CATEGORIE (id_politique, id_categorie) VALUES ${ids
          .map(() => "(?, ?)")
          .join(",")}`,
        ids.flatMap((id) => [idPolitique, id])
      );
    }

    await connexion.commit();

    // Activer ou lever un blocage web engage le client vis-à-vis de ses
    // salariés : la trace de qui a décidé, et quand, doit exister.
    await tracer(
      req,
      "politique_web_modifiee",
      `Politique « ${nom.trim()} » (${
        id_site === null ? "par défaut" : "site " + id_site
      }) ${active ? "activée" : "désactivée"} — ${ids.length} catégorie(s)`
    );

    res.json({ id_politique: idPolitique, categories: ids.length });
  } catch (err) {
    await connexion.rollback();
    if (schemaAbsent(err)) {
      return res.status(503).json({
        error: "Fonction non installée",
        aide: "Exécutez la migration backend/migrations/2026-08-19-controle-acces-web.sql",
      });
    }
    throw err;
  } finally {
    connexion.release();
  }
});

/**
 * POST /api/acces-web/politique/:id/domaine
 * body : { domaine, action, commentaire }
 *
 * La normalisation a lieu ICI, avant l'enregistrement, et non à la
 * lecture. Stocker une saisie brute laisserait l'interface afficher
 * « https://exemple.com/page » comme une règle active alors qu'elle ne
 * correspond à rien.
 */
router.post("/acces-web/politique/:id/domaine", requireRole("admin"), async (req, res) => {
  const { domaine, action = "bloquer", commentaire, duree_heures, origine } = req.body || {};

  /* La durée est reçue en HEURES et convertie en date par la base, pas
     par le navigateur. Une date calculée côté client arriverait dans le
     fuseau du poste : un blocage posé depuis un portable resté à l'heure
     de Paris expirerait une heure trop tôt à Douala. */
  let dureeHeures = null;
  if (duree_heures !== undefined && duree_heures !== null && duree_heures !== "") {
    dureeHeures = Number(duree_heures);
    if (!Number.isFinite(dureeHeures) || dureeHeures <= 0 || dureeHeures > 24 * 365) {
      return res.status(400).json({
        error: "Durée invalide",
        aide: "Attendu : un nombre d'heures entre 1 et 8760, ou rien pour un blocage permanent.",
      });
    }
  }

  const origineRetenue = origine === "bande_passante" ? "bande_passante" : "manuel";

  const normalise = normaliserDomaine(domaine);
  if (!normalise) {
    return res.status(400).json({
      error: "Domaine invalide",
      aide: "Attendu : exemple.com, www.exemple.com ou une URL complète. Les adresses IP et « localhost » ne se bloquent pas par DNS.",
    });
  }
  if (!["bloquer", "autoriser"].includes(action)) {
    return res.status(400).json({ error: "Action inconnue" });
  }

  const acces = await politiqueDansPortee(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  try {
    if (expirationDisponible === false) {
      // Migration non appliquée : on pose la règle, mais on REFUSE de
      // faire croire qu'elle expirera.
      if (dureeHeures !== null) {
        return res.status(503).json({
          error: "Les blocages à durée limitée ne sont pas disponibles",
          aide: "Appliquez backend/migrations/2026-09-28-blocage-temporaire.sql, puis redémarrez le serveur.",
        });
      }
      await db.query(
        `INSERT INTO POLITIQUE_DOMAINE (id_politique, domaine, action, commentaire)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE action = VALUES(action), commentaire = VALUES(commentaire)`,
        [req.params.id, normalise, action, commentaire || null]
      );
    } else {
      try {
        await db.query(
          `INSERT INTO POLITIQUE_DOMAINE
             (id_politique, domaine, action, commentaire, cree_par, origine, date_fin)
           VALUES (?, ?, ?, ?, ?, ?, ${dureeHeures === null ? "NULL" : "DATE_ADD(NOW(), INTERVAL ? HOUR)"})
           ON DUPLICATE KEY UPDATE action = VALUES(action),
                                   commentaire = VALUES(commentaire),
                                   cree_par = VALUES(cree_par),
                                   origine = VALUES(origine),
                                   date_fin = VALUES(date_fin)`,
          dureeHeures === null
            ? [req.params.id, normalise, action, commentaire || null, req.user?.id || null, origineRetenue]
            : [req.params.id, normalise, action, commentaire || null, req.user?.id || null, origineRetenue, dureeHeures]
        );
        expirationDisponible = true;
      } catch (err) {
        if (!colonneAbsente(err)) throw err;
        signalerExpirationIndisponible();
        if (dureeHeures !== null) {
          return res.status(503).json({
            error: "Les blocages à durée limitée ne sont pas disponibles",
            aide: "Appliquez backend/migrations/2026-09-28-blocage-temporaire.sql, puis redémarrez le serveur.",
          });
        }
        await db.query(
          `INSERT INTO POLITIQUE_DOMAINE (id_politique, domaine, action, commentaire)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE action = VALUES(action), commentaire = VALUES(commentaire)`,
          [req.params.id, normalise, action, commentaire || null]
        );
      }
    }
    await db.query(
      "UPDATE POLITIQUE_WEB SET version = version + 1 WHERE id_politique = ?",
      [req.params.id]
    );
    await tracer(
      req,
      "regle_web_ajoutee",
      `Domaine ${normalise} : ${action} (politique #${req.params.id})` +
        (dureeHeures === null ? ", permanent" : `, pour ${dureeHeures} h`) +
        (commentaire ? ` — ${commentaire}` : "")
    );

    res.json({
      domaine: normalise,
      action,
      duree_heures: dureeHeures,
      origine: origineRetenue,
    });
  } catch (err) {
    if (schemaAbsent(err)) {
      return res.status(503).json({ error: "Fonction non installée" });
    }
    throw err;
  }
});

router.delete("/acces-web/domaine/:idRegle", requireRole("admin"), async (req, res) => {
  const [[regle]] = await db.query(
    "SELECT id_politique FROM POLITIQUE_DOMAINE WHERE id_regle = ?",
    [req.params.idRegle]
  );
  if (!regle) return res.status(404).json({ error: "Règle introuvable" });

  const acces = await politiqueDansPortee(req, regle.id_politique);
  // 404 systématique ici : la règle existe, mais l'appelant n'a pas à
  // savoir qu'elle existe sur un site qui n'est pas le sien.
  if (!acces.ok) return res.status(404).json({ error: "Règle introuvable" });

  await db.query("DELETE FROM POLITIQUE_DOMAINE WHERE id_regle = ?", [req.params.idRegle]);
  await db.query("UPDATE POLITIQUE_WEB SET version = version + 1 WHERE id_politique = ?", [
    regle.id_politique,
  ]);
  await tracer(
    req,
    "regle_web_supprimee",
    `Règle #${req.params.idRegle} retirée de la politique #${regle.id_politique}`
  );

  res.json({ supprime: true });
});

// CÔTÉ AGENT

/**
 * Construit la configuration complète d'un site. Utilisée par la route
 * agent — c'est le seul endroit où les centaines de milliers de domaines
 * sont réellement chargés en mémoire.
 */
async function construireConfiguration(idSite, ipAgent, nomSite) {
  const politique = await chargerPolitique(idSite);
  if (!politique || !politique.active) return null;

  const { categories, manuelles } = await chargerContenu(politique.id_politique);

  let domaines = [];
  if (categories.length > 0) {
    const [rows] = await db.query(
      `SELECT domaine FROM DOMAINE_CATEGORIE
       WHERE id_categorie IN (${categories.map(() => "?").join(",")})`,
      categories.map((c) => c.id_categorie)
    );
    domaines = rows.map((r) => r.domaine);
  }

  const compilee = compilerPolitique({ domainesCategories: domaines, reglesManuelles: manuelles });

  return {
    version: politique.version,
    message_blocage: politique.message_blocage,
    dnsmasq: genererDnsmasq(compilee, {
      version: politique.version,
      nomSite,
      ipBlocage: ipAgent || "0.0.0.0",
    }),
    pare_feu: genererReglesPareFeu(ipAgent || "<IP-DE-L-AGENT>", "iptables"),
    stats: compilee.stats,
  };
}

module.exports = { router, construireConfiguration, chargerPolitique, schemaAbsent };
