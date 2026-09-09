const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { tracer } = require("../services/journal");

/**
 * Clés dont la valeur ne doit jamais sortir de la base.
 *
 * POURQUOI CE FILTRE, ALORS QUE LA TABLE NE CONTIENT AUCUN SECRET
 * AUJOURD'HUI.
 *
 * CONFIGURATION est un magasin clé/valeur générique. Elle ne contient
 * pour l'instant que des seuils, sans intérêt pour un attaquant. Mais
 * c'est exactement le genre de table où l'on range un jour le mot de
 * passe SMTP, une clé d'API ou un jeton de service — parce que c'est
 * pratique et que rien ne l'interdit.
 *
 * Ce jour-là, `SELECT *` renvoyé à tout compte authentifié transformerait
 * une commodité en fuite, et personne ne s'en apercevrait : la route
 * continuerait de fonctionner exactement pareil.
 *
 * Le filtre porte sur le NOM de la clé, pas sur une liste figée : une
 * clé future nommée `smtp_password` sera masquée sans que quiconque ait
 * à y penser. C'est le seul type de protection qui survit à l'oubli.
 */
const MOTIF_CLE_SENSIBLE = /(pass|mdp|secret|token|jeton|api_?key|_key$|credential)/i;

router.get("/configuration", async (req, res) => {
  const [rows] = await db.query("SELECT cle, valeur, description FROM CONFIGURATION");

  // La clé reste visible — sans quoi l'administrateur ne saurait pas
  // qu'un réglage existe. Seule la valeur est remplacée.
  res.json(
    rows.map((r) =>
      MOTIF_CLE_SENSIBLE.test(r.cle) ? { ...r, valeur: "••••••••", masquee: true } : r
    )
  );
});

router.patch("/configuration/:cle", requireRole("admin"), async (req, res) => {
  const { valeur } = req.body;
  if (valeur === undefined || valeur === null || valeur === "") {
    return res.status(400).json({ error: "valeur requise" });
  }
  // UNE CLÉ INCONNUE N'EST PAS UNE MISE À JOUR RÉUSSIE.
  //
  // `UPDATE ... WHERE cle = ?` sur une clé qui n'existe pas ne touche
  // aucune ligne et ne lève rien : la route répondait « Configuration mise
  // à jour » et l'interface affichait un succès, alors que le réglage
  // n'existait nulle part. Une faute de frappe dans un nom de clé
  // devenait indétectable.
  const [r] = await db.query("UPDATE CONFIGURATION SET valeur = ? WHERE cle = ?", [
    valeur,
    req.params.cle,
  ]);
  if (r.affectedRows === 0) {
    return res.status(404).json({
      error: `Réglage inconnu : ${req.params.cle}`,
      aide: "La liste des réglages existants est donnée par GET /api/configuration.",
    });
  }

  // Changer un seuil de supervision modifie le comportement de la
  // plateforme pour tout le monde : cela se trace.
  await tracer(
    req,
    "configuration_modifiee",
    `Réglage « ${req.params.cle} » porté à « ${String(valeur).slice(0, 200)} »`
  );

  res.json({ message: "Configuration mise à jour" });
});

module.exports = router;