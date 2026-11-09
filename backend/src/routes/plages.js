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
const { tracer } = require("../services/journal");
const { planDuSite, planDUnePlage } = require("../services/planAdressageService");
const { toLong } = require("../services/adressesIp");


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

/**
 * GET /api/plan-adressage?id_site=1[&cidr=192.168.0.0/23]
 *
 * Ce qui est attribué, ce qui est réservé, ce qui reste libre.
 *
 * Sans `cidr` : toutes les plages actives du site. Avec `cidr` : cette
 * plage seule, même si elle n'est pas déclarée — pour répondre à « et si
 * je passais ce réseau en /24 ? » sans rien créer en base.
 *
 * Ouverte à tout compte authentifié, y compris « lecteur » : la réponse
 * ne contient aucun secret, seulement des adresses que ce compte peut
 * déjà voir dans l'inventaire. Le cloisonnement par site, lui, s'applique.
 */
router.get("/plan-adressage", async (req, res) => {
  const idSite = Number(req.query.id_site);
  if (!idSite) {
    return res.status(400).json({ error: "id_site est requis" });
  }
  if (!siteAutorise(req, idSite)) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à consulter ce site" });
  }

  try {
    if (req.query.cidr) {
      const plan = await planDUnePlage(idSite, String(req.query.cidr));
      return res.json({ plages: [plan] });
    }
    res.json({ plages: await planDuSite(idSite) });
  } catch (err) {
    // Une plage illisible vient de la saisie, pas d'une panne : un 500
    // enverrait chercher un défaut du produit là où il suffit de corriger
    // un masque.
    if (/CIDR invalide|préfixe invalide/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Plan d'adressage impossible:", err.message);
    res.status(500).json({ error: "Impossible de calculer le plan d'adressage" });
  }
});


/* ═══════════════════════════════════════════════════════════════════════
   LES RÉSERVATIONS D'ADRESSES DÉCLARÉES PAR L'ENTREPRISE.

   La norme dit ce qui est interdit ; l'entreprise dit ce qui est déjà
   promis. Sans ces déclarations, le plan d'adressage propose une adresse
   du pool DHCP comme « libre » — elle fonctionne quelques jours, puis le
   DHCP l'attribue à son tour et la panne commence.

   CE QUI EST REFUSÉ ICI, ET POURQUOI ÇA N'EST PAS DE LA RIGIDITÉ. Une
   borne illisible, un début après la fin, une zone de plus de 65 536
   adresses : chacune produirait un plan faux plutôt qu'une erreur, et un
   plan faux ne se voit pas.
   ═══════════════════════════════════════════════════════════════════════ */
const CATEGORIES = ["dhcp", "reseau", "serveurs", "imprimantes", "autre"];

router.get("/reservations", async (req, res) => {
  const idSite = Number(req.query.id_site);
  if (!Number.isInteger(idSite)) {
    return res.status(400).json({ error: "id_site est requis" });
  }
  if (!siteAutorise(req, idSite)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  try {
    const [lignes] = await db.query(
      `SELECT r.id_reservation, r.debut, r.fin, r.motif, r.categorie,
              r.exclure_du_scan, r.date_creation, u.nom AS cree_par_nom
         FROM RESERVATION_ADRESSE r
         LEFT JOIN UTILISATEUR u ON u.id_utilisateur = r.cree_par
        WHERE r.id_site = ?
        ORDER BY r.debut_num`,
      [idSite]
    );
    res.json(lignes.map((l) => ({ ...l, exclure_du_scan: Number(l.exclure_du_scan) === 1 })));
  } catch (err) {
    if (/doesn't exist|Unknown column/i.test(err.message)) {
      return res.status(503).json({
        error: "Les réservations d'adresses ne sont pas installées sur cette base",
        aide: "node tools\\appliquer-migrations.js",
      });
    }
    console.error("Lecture des réservations impossible:", err.message);
    res.status(500).json({ error: "Impossible de lire les réservations" });
  }
});

router.post("/reservations", requireRole("admin", "operateur"), async (req, res) => {
  const { id_site, debut, fin, motif, categorie, exclure_du_scan } = req.body || {};

  const idSite = Number(id_site);
  if (!Number.isInteger(idSite)) return res.status(400).json({ error: "id_site est requis" });
  if (!siteAutorise(req, idSite)) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à agir sur ce site" });
  }
  if (!motif || !String(motif).trim()) {
    /* LE MOTIF EST OBLIGATOIRE. Une zone réservée sans raison écrite
       devient, six mois plus tard, une zone que personne n'ose toucher et
       que personne ne sait justifier. */
    return res.status(400).json({ error: "Indiquez à quoi sert cette réservation" });
  }
  if (categorie && !CATEGORIES.includes(categorie)) {
    return res.status(400).json({ error: "Catégorie inconnue" });
  }

  let debutNum;
  let finNum;
  try {
    debutNum = toLong(String(debut).trim());
    finNum = toLong(String(fin).trim());
  } catch {
    debutNum = null;
  }
  if (!Number.isFinite(debutNum) || !Number.isFinite(finNum)) {
    return res.status(400).json({ error: "Adresses de début et de fin invalides" });
  }
  if (finNum < debutNum) {
    return res.status(400).json({ error: "La fin doit venir après le début" });
  }
  if (finNum - debutNum + 1 > 65536) {
    return res.status(400).json({ error: "Une réservation ne peut pas dépasser 65 536 adresses" });
  }

  try {
    const [resultat] = await db.query(
      `INSERT INTO RESERVATION_ADRESSE
         (id_site, debut, fin, debut_num, fin_num, motif, categorie, exclure_du_scan, cree_par)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        idSite,
        String(debut).trim(),
        String(fin).trim(),
        debutNum,
        finNum,
        String(motif).trim().slice(0, 160),
        categorie || "autre",
        exclure_du_scan ? 1 : 0,
        req.user?.id || null,
      ]
    );

    await tracer(
      req,
      "reservation_ajoutee",
      `Réservation ${debut} – ${fin} sur le site ${idSite} : ${motif}` +
        (exclure_du_scan ? " (exclue du balayage)" : "")
    );
    res.json({ id_reservation: resultat.insertId, message: "Réservation enregistrée" });
  } catch (err) {
    if (/doesn't exist|Unknown column/i.test(err.message)) {
      return res.status(503).json({
        error: "Les réservations d'adresses ne sont pas installées sur cette base",
        aide: "node tools\\appliquer-migrations.js",
      });
    }
    console.error("Enregistrement d'une réservation impossible:", err.message);
    res.status(500).json({ error: "Impossible d'enregistrer cette réservation" });
  }
});

router.delete("/reservations/:id", requireRole("admin", "operateur"), async (req, res) => {
  try {
    // 404 plutôt que 403 hors périmètre, comme pour les plages.
    const [lignes] = await db.query(
      "SELECT id_site, debut, fin FROM RESERVATION_ADRESSE WHERE id_reservation = ?",
      [req.params.id]
    );
    if (lignes.length === 0 || !siteAutorise(req, lignes[0].id_site)) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    await db.query("DELETE FROM RESERVATION_ADRESSE WHERE id_reservation = ?", [req.params.id]);
    await tracer(
      req,
      "reservation_supprimee",
      `Réservation ${lignes[0].debut} – ${lignes[0].fin} supprimée`
    );
    res.json({ message: "Réservation supprimée" });
  } catch (err) {
    if (/doesn't exist|Unknown column/i.test(err.message)) {
      return res.status(503).json({ error: "Les réservations ne sont pas installées sur cette base" });
    }
    console.error("Suppression d'une réservation impossible:", err.message);
    res.status(500).json({ error: "Impossible de supprimer cette réservation" });
  }
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
    await tracer(req, "plage_ajoutee", `Plage ${cidr} déclarée sur le site ${id_site}`);

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
  await tracer(req, "plage_supprimee", `Plage #${req.params.id} supprimée`);

  res.json({ message: "Plage supprimée" });
});

module.exports = router;