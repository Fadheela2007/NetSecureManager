/**
 * routes/sites.js
 * Gestion des sites (villes/agences) : liste, création, et mise en service
 * de l'agent distant.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { clauseSite, porteeDe, siteAutorise } = require("../middleware/porteeSite");

/** Seuil de silence au-delà duquel un agent est considéré muet (minutes). */
const SEUIL_MUET_DEFAUT = 30;

/**
 * Qualifie l'état de l'agent d'un site à partir de son dernier push.
 * C'est ce qui permet de vérifier une installation en direct, sans
 * attendre le cron de surveillance.
 */
function etatAgent(dernierPush, seuilMinutes = SEUIL_MUET_DEFAUT) {
  if (!dernierPush) {
    return { etat: "jamais_connecte", libelle: "Jamais connecté", minutes: null };
  }
  const minutes = Math.floor((Date.now() - new Date(dernierPush).getTime()) / 60000);
  if (minutes >= seuilMinutes) {
    return { etat: "muet", libelle: `Muet depuis ${minutes} min`, minutes };
  }
  return {
    etat: "actif",
    libelle: minutes < 1 ? "Actif à l'instant" : `Actif il y a ${minutes} min`,
    minutes,
  };
}

/**
 * GET /api/sites
 *
 * ⚠ agent_token est VOLONTAIREMENT exclu de cette projection.
 *
 * Cette route est ouverte à tout utilisateur authentifié — elle alimente
 * le sélecteur de site. Un `SELECT *` y exposait le jeton d'agent à
 * n'importe quel compte, y compris un simple lecteur, qui pouvait alors
 * injecter de faux équipements via POST /api/agent/push. Le jeton n'est
 * plus servi que par GET /api/sites/:id/agent, réservé aux administrateurs.
 */
router.get("/sites", async (req, res) => {
  const portee = clauseSite(req, "id_site");
  const [rows] = await db.query(
    `SELECT id_site, nom, ville, adresse, dernier_push, date_creation
     FROM SITE WHERE ${portee.clause} ORDER BY nom`,
    portee.params
  );
  res.json(rows.map((s) => ({ ...s, agent: etatAgent(s.dernier_push) })));
});

router.post("/sites", requireRole("admin"), async (req, res) => {
  // Créer un site est une action de plateforme : un admin rattaché à un site
  // n'a pas vocation à en créer d'autres, qu'il ne pourrait de toute façon
  // pas consulter ensuite.
  if (porteeDe(req) !== null) {
    return res.status(403).json({
      error: "Seul un administrateur global (sans site de rattachement) peut créer un site",
    });
  }
  const { nom, ville } = req.body;
  if (!nom || !ville) {
    return res.status(400).json({ error: "nom et ville sont requis" });
  }
  const agent_token = crypto.randomBytes(24).toString("hex");
  const [result] = await db.query(
    "INSERT INTO SITE (nom, ville, agent_token) VALUES (?, ?, ?)",
    [nom, ville, agent_token]
  );
  res.json({ id_site: result.insertId, nom, ville, agent_token });
});

/**
 * Construit les commandes d'installation prêtes à coller.
 *
 * Le jeton y est déjà inséré : l'administrateur n'a rien à recopier à la
 * main, ce qui est la première source d'erreur lors d'une mise en service.
 */
function commandesInstallation(site, urlCentrale) {
  const base = {
    CENTRAL_API_URL: urlCentrale,
    AGENT_TOKEN: site.agent_token,
    ID_SITE: site.id_site,
    CIDR: site.cidr_suggere || "192.168.1.0/24",
  };

  const linux =
    `sudo bash installer.sh \\\n` +
    `  --url "${base.CENTRAL_API_URL}" \\\n` +
    `  --token "${base.AGENT_TOKEN}" \\\n` +
    `  --site ${base.ID_SITE} \\\n` +
    `  --cidr "${base.CIDR}"`;

  const windows =
    `.\\installer.ps1 ` +
    `-Url "${base.CENTRAL_API_URL}" ` +
    `-Token "${base.AGENT_TOKEN}" ` +
    `-Site ${base.ID_SITE} ` +
    `-Cidr "${base.CIDR}"`;

  const envManuel =
    `CENTRAL_API_URL=${base.CENTRAL_API_URL}\n` +
    `AGENT_TOKEN=${base.AGENT_TOKEN}\n` +
    `ID_SITE=${base.ID_SITE}\n` +
    `CIDR=${base.CIDR}\n` +
    `SCAN_INTERVAL_MINUTES=5\n` +
    `SNMP_COMMUNITY=public\n`;

  return { linux, windows, envManuel };
}

/**
 * GET /api/sites/:id/agent
 *
 * Tout ce qu'il faut pour mettre un site en service : le jeton, l'état de
 * la remontée, et les commandes d'installation prêtes à coller.
 *
 * Réservé aux administrateurs — c'est la seule route qui expose le jeton.
 */
router.get("/sites/:id/agent", requireRole("admin"), async (req, res) => {
  const [rows] = await db.query(
    "SELECT id_site, nom, ville, agent_token, dernier_push FROM SITE WHERE id_site = ?",
    [req.params.id]
  );
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }
  const site = rows[0];

  // Plage déjà déclarée pour ce site : évite à l'administrateur de la
  // ressaisir, et rend la commande directement exécutable.
  const [plages] = await db.query(
    "SELECT cidr FROM PLAGE_SCAN WHERE id_site = ? AND actif = TRUE ORDER BY id_plage LIMIT 1",
    [site.id_site]
  );
  if (plages.length > 0) site.cidr_suggere = plages[0].cidr;

  // L'URL publique de la plateforme n'est pas devinable côté serveur :
  // on part de l'en-tête de la requête, que l'administrateur peut corriger.
  const protocole = req.headers["x-forwarded-proto"] || req.protocol;
  const hote = req.headers["x-forwarded-host"] || req.headers.host;
  const urlCentrale = `${protocole}://${hote}/api`;

  // Nombre d'équipements déjà remontés : la preuve que ça marche.
  const [[{ nb }]] = await db.query(
    "SELECT COUNT(*) AS nb FROM EQUIPEMENT WHERE id_site = ?",
    [site.id_site]
  );

  res.json({
    id_site: site.id_site,
    nom: site.nom,
    ville: site.ville,
    agent_token: site.agent_token,
    dernier_push: site.dernier_push,
    agent: etatAgent(site.dernier_push),
    equipements_remontes: nb,
    url_centrale: urlCentrale,
    cidr_suggere: site.cidr_suggere || null,
    commandes: commandesInstallation(site, urlCentrale),
  });
});

/**
 * POST /api/sites/:id/regenerer-token
 *
 * Rotation du jeton d'agent. L'ancien cesse immédiatement de fonctionner :
 * l'agent déjà installé sera rejeté jusqu'à sa reconfiguration. C'est le
 * comportement attendu d'une révocation — le message le dit clairement.
 */
router.post("/sites/:id/regenerer-token", requireRole("admin"), async (req, res) => {
  const [rows] = await db.query("SELECT id_site FROM SITE WHERE id_site = ?", [req.params.id]);
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  const nouveau = crypto.randomBytes(24).toString("hex");
  await db.query("UPDATE SITE SET agent_token = ? WHERE id_site = ?", [nouveau, req.params.id]);

  res.json({
    agent_token: nouveau,
    avertissement:
      "L'ancien jeton est révoqué. L'agent déjà installé sur ce site sera rejeté " +
      "jusqu'à ce que vous relanciez l'installation avec le nouveau jeton.",
  });
});

module.exports = router;
