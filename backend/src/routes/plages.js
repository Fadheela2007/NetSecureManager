/**
 * routes/plages.js
 * Gestion des plages réseau à scanner, mémorisées par site.
 * Permet aussi de stocker les identifiants SNMPv3 propres à chaque plage,
 * ce qui rend snmpProbeV3() réellement utilisable.
 */

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { clauseSite, siteAutorise } = require("../middleware/porteeSite");


/**
 * Masque de la communauté SNMP renvoyé aux comptes non administrateurs.
 * Même convention que /api/configuration, pour que l'interface affiche
 * partout la même chose quand une valeur est cachée.
 */
const MASQUE = "••••••••";

router.get("/plages", async (req, res) => {
  const { id_site } = req.query;
  const portee = clauseSite(req, "id_site");
  // Les clés SNMPv3 ne sont jamais renvoyées au frontend : elles ne servent
  // qu'au backend au moment du scan.
  const [rows] = await db.query(
    `SELECT id_plage, id_site, cidr, snmp_community, snmp_version,
            snmp_v3_username, actif
     FROM PLAGE_SCAN
     WHERE (? IS NULL OR id_site = ?) AND ${portee.clause}
     ORDER BY id_site, cidr`,
    [id_site || null, id_site || null, ...portee.params]
  );

  /* ─────────────────────────────────────────────────────────────────
     LA COMMUNAUTÉ SNMP EST UN MOT DE PASSE.

     Elle donne accès en LECTURE à tout le parc : inventaire, interfaces,
     table de commutation d'un switch — directement depuis n'importe
     quelle machine, sans passer par la plateforme.

     Cette route est ouverte à tout compte authentifié, y compris au rôle
     « lecteur ». Un lecteur repartait donc avec la clé de tout le réseau
     du client.

     C'EST LA MÊME FAUTE QUE CELLE DÉJÀ CORRIGÉE SUR agent_token, sur une
     autre route. Elle a survécu parce que la correction avait visé un
     CHAMP et non une CATÉGORIE : « ce qui est un secret ne sort pas ».
     D'où le choix de masquer plutôt que de retirer — un administrateur
     doit pouvoir vérifier ce qui est configuré, mais lui seul.
     ───────────────────────────────────────────────────────────────── */
  const estAdmin = req.user?.role === "admin";
  const plages = rows.map((p) =>
    estAdmin || !p.snmp_community
      ? p
      : { ...p, snmp_community: MASQUE, snmp_community_masquee: true }
  );

  res.json(plages);
});

router.post("/plages", requireRole("admin", "operateur"), async (req, res) => {
  const {
    id_site, cidr, snmp_community, snmp_version,
    snmp_v3_username, snmp_v3_auth_key, snmp_v3_priv_key,
  } = req.body;

  if (!id_site || !cidr) {
    return res.status(400).json({ error: "id_site et cidr sont requis" });
  }
  if (!siteAutorise(req, id_site)) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à agir sur ce site" });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO PLAGE_SCAN
         (id_site, cidr, snmp_community, snmp_version, snmp_v3_username, snmp_v3_auth_key, snmp_v3_priv_key, actif)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        id_site, cidr,
        snmp_community || "public",
        snmp_version || "v2c",
        snmp_v3_username || null,
        snmp_v3_auth_key || null,
        snmp_v3_priv_key || null,
      ]
    );
    res.json({ id_plage: result.insertId, message: "Plage enregistrée" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cette plage existe déjà pour ce site" });
    }
    res.status(500).json({ error: "Erreur lors de l'enregistrement", details: err.message });
  }
});

router.delete("/plages/:id", requireRole("admin"), async (req, res) => {
  // 404 plutôt que 403 hors périmètre : ne pas révéler l'existence d'une
  // plage appartenant à un autre site.
  const [plages] = await db.query("SELECT id_site FROM PLAGE_SCAN WHERE id_plage = ?", [req.params.id]);
  if (plages.length === 0 || !siteAutorise(req, plages[0].id_site)) {
    return res.status(404).json({ error: "Plage introuvable" });
  }

  const [result] = await db.query("DELETE FROM PLAGE_SCAN WHERE id_plage = ?", [req.params.id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Plage introuvable" });
  }
  res.json({ message: "Plage supprimée" });
});

module.exports = router;