/**
 * routes/permissions.js
 * Lire et modifier la matrice des droits.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * DEUX ROUTES, ET UN GARDE-FOU QUI COMPTE PLUS QUE LES DEUX
 *
 * Un écran qui distribue les droits peut retirer le sien. C'est la
 * panne dont on ne se relève pas par l'interface : plus personne n'a le
 * droit de rendre le droit, et il faut ouvrir la base à la main pour
 * s'en sortir. Sur l'installation d'un client, ça veut dire un appel au
 * support un dimanche.
 *
 * Le serveur refuse donc de retirer à « admin » le niveau
 * « administrer » sur l'écran Utilisateurs. Une seule règle, mais elle
 * garantit qu'il reste toujours quelqu'un pour rouvrir ce qu'on vient de
 * fermer.
 *
 * ── POURQUOI CE REFUS EST CÔTÉ SERVEUR ──
 *
 * L'écran grise aussi cette case. Mais une case grisée n'a jamais
 * empêché personne d'appeler la route, et le jour où quelqu'un le fait,
 * c'est l'installation entière qui se ferme.
 */

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const permissions = require("../services/permissionsService");
const { tracer } = require("../services/journal");

const router = express.Router();

const ROLES = ["admin", "operateur", "lecteur"];

/**
 * GET /api/permissions
 * La matrice complète : les écrans, les niveaux, et qui a quoi.
 */
router.get("/permissions", requireRole("admin"), async (req, res) => {
  res.json(await permissions.matrice());
});

/**
 * PUT /api/permissions
 * body : { role, ecran, niveau }
 *
 * Une case à la fois. Enregistrer la matrice entière d'un coup aurait
 * demandé de savoir ce qui a changé pour le journaliser, et aurait
 * écrasé en silence le réglage d'un collègue ouvert sur le même écran.
 */
router.put("/permissions", requireRole("admin"), async (req, res) => {
  const { role, ecran, niveau } = req.body || {};

  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: "Rôle inconnu" });
  }
  if (!permissions.ECRANS[ecran]) {
    return res.status(400).json({ error: "Écran inconnu" });
  }
  if (!permissions.NIVEAUX.includes(niveau)) {
    return res.status(400).json({
      error: "Niveau inconnu",
      aide: `Attendu : ${permissions.NIVEAUX.join(", ")}.`,
    });
  }

  /* ── LE GARDE-FOU ── */
  if (role === "admin" && ecran === "utilisateurs" && niveau !== "administrer") {
    return res.status(409).json({
      error: "Ce droit ne peut pas être retiré",
      aide:
        "Sans lui, plus personne ne pourrait modifier les permissions — " +
        "y compris pour annuler ce changement. C'est le seul droit que la " +
        "plateforme protège d'elle-même.",
    });
  }

  const avant = await permissions.niveauDe(role, ecran);
  if (avant === niveau) {
    // Rien à écrire, rien à journaliser : un clic qui ne change rien
    // n'est pas un événement.
    return res.json({ role, ecran, niveau, modifie: false });
  }

  try {
    await db.query(
      `INSERT INTO PERMISSION (role, ecran, niveau) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE niveau = VALUES(niveau)`,
      [role, ecran, niveau]
    );
  } catch (err) {
    if (/doesn't exist/i.test(err.message)) {
      return res.status(503).json({
        error: "La table des permissions est absente de la base",
        aide: "Appliquez backend/migrations/2026-09-30-permissions-ecrans.sql.",
      });
    }
    throw err;
  }

  /* Le cache est vidé AVANT de répondre : sinon l'écran se recharge et
     réaffiche l'ancienne valeur, qui est encore en mémoire. Le réglage
     aurait l'air de ne pas avoir pris. */
  permissions.oublier();

  await tracer(
    req,
    "permission_modifiee",
    `Rôle « ${role} » sur l'écran « ${permissions.ECRANS[ecran].libelle} » : ` +
      `${avant || "non défini"} → ${niveau}`
  );

  res.json({ role, ecran, niveau, modifie: true, avant });
});

module.exports = router;
