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
const { clauseSite, siteAutorise } = require("../middleware/porteeSite");
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

  const [manuelles] = await db.query(
    `SELECT id_regle, domaine, action, commentaire, date_creation
     FROM POLITIQUE_DOMAINE WHERE id_politique = ?
     ORDER BY action, domaine`,
    [idPolitique]
  );

  return { categories, manuelles };
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

  if (id_site !== null && !siteAutorise(req, id_site)) {
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
  const { domaine, action = "bloquer", commentaire } = req.body || {};

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

  try {
    await db.query(
      `INSERT INTO POLITIQUE_DOMAINE (id_politique, domaine, action, commentaire)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE action = VALUES(action), commentaire = VALUES(commentaire)`,
      [req.params.id, normalise, action, commentaire || null]
    );
    await db.query(
      "UPDATE POLITIQUE_WEB SET version = version + 1 WHERE id_politique = ?",
      [req.params.id]
    );
    res.json({ domaine: normalise, action });
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

  await db.query("DELETE FROM POLITIQUE_DOMAINE WHERE id_regle = ?", [req.params.idRegle]);
  await db.query("UPDATE POLITIQUE_WEB SET version = version + 1 WHERE id_politique = ?", [
    regle.id_politique,
  ]);
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
