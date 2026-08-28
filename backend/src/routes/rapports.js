/**
 * routes/rapports.js
 * Génération de rapports téléchargeables (PDF et Excel) : équipements,
 * alertes, disponibilité — pour présentation ou archivage.
 */

const express = require("express");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");
const router = express.Router();
const { porteeDe } = require("../middleware/porteeSite");
const { requireRole } = require("../middleware/requireRole");
const { collecterDonnees, composerPdf } = require("../services/rapportService");
const {
  envoyerRapportsPlanifies,
  estLeMoment,
} = require("../services/rapportPlanifieService");

// La collecte et la mise en page du PDF vivent dans services/rapportService.js :
// le planificateur d'envoi par e-mail produit exactement le même document, sans
// duplication de code.
router.get("/rapport/pdf", async (req, res) => {
  const { id_site } = req.query;

  const donnees = await collecterDonnees({
    portee: porteeDe(req),
    idSite: id_site ? Number(id_site) : null,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=rapport_netsecuremanager.pdf");

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);
  composerPdf(doc, donnees);
  doc.end();
});

router.get("/rapport/excel", async (req, res) => {
  const { id_site } = req.query;

  // Même collecte que le PDF : un seul endroit décide de ce qu'un rapport
  // contient et du périmètre appliqué.
  const { equipements, alertes, dispos } = await collecterDonnees({
    portee: porteeDe(req),
    idSite: id_site ? Number(id_site) : null,
  });

  const workbook = new ExcelJS.Workbook();

  const feuilleEq = workbook.addWorksheet("Équipements");
  feuilleEq.columns = [
    { header: "Nom", key: "nom", width: 25 },
    { header: "Adresse IP", key: "adresse_ip", width: 18 },
    { header: "Fabricant", key: "fabricant", width: 18 },
    { header: "OS détecté", key: "os_detecte", width: 30 },
    { header: "Statut", key: "statut", width: 12 },
    { header: "Dernière découverte", key: "derniere_decouverte", width: 22 },
    { header: "Disponibilité 30 j (%)", key: "dispo", width: 20 },
    { header: "Indispo. (min)", key: "indispo", width: 15 },
    { header: "Pannes", key: "pannes", width: 10 },
    { header: "Fiabilité du calcul", key: "fiabilite", width: 46 },
  ];
  equipements.forEach((eq) => {
    const d = dispos.get(Number(eq.id_equipement));
    feuilleEq.addRow({
      ...eq,
      // Valeur numérique pour permettre tris et graphiques dans Excel ;
      // la colonne « Fiabilité » dit si on peut s'y fier.
      dispo: d ? d.taux_indicatif : null,
      indispo: d ? d.minutes_indisponible : null,
      pannes: d ? d.nb_pannes : null,
      fiabilite: d
        ? d.fiable
          ? "Fiable"
          : `Indicatif — ${d.avertissements[0]}`
        : "—",
    });
  });
  feuilleEq.getRow(1).font = { bold: true };

  // Note méthodologique : un taux sans sa méthode se lit mal.
  const feuilleNote = workbook.addWorksheet("Méthode");
  feuilleNote.columns = [{ header: "Note méthodologique", key: "n", width: 110 }];
  feuilleNote.getRow(1).font = { bold: true };
  [
    "Le taux de disponibilité est calculé sur 30 jours à partir des alertes d'indisponibilité",
    "(type equipement_down), et non à partir du nombre de relevés enregistrés.",
    "",
    "Pourquoi : si le backend est arrêté, aucun relevé n'est produit. Compter les relevés",
    "reviendrait à déclarer tout le parc en panne pendant cette interruption.",
    "",
    "Limites à connaître :",
    "  • Une interruption plus courte que le seuil d'alerte (quelques minutes) ne crée pas",
    "    d'alerte et n'est donc pas comptabilisée. Ces taux sont des MAJORANTS.",
    "  • Un équipement découvert après le début de la période voit son taux calculé sur sa",
    "    durée d'existence réelle, pas sur 30 jours.",
    "  • La colonne « Fiabilité du calcul » signale les cas où le chiffre ne doit pas être",
    "    présenté comme un engagement de niveau de service.",
    "",
    `Couverture de collecte sur la période : ${
      equipements.length > 0 ? dispos.get(Number(equipements[0].id_equipement))?.couverture_pourcent ?? "?" : "?"
    } % des heures ont produit au moins un relevé.`,
  ].forEach((n) => feuilleNote.addRow({ n }));

  const feuilleAl = workbook.addWorksheet("Alertes (30 jours)");
  feuilleAl.columns = [
    { header: "Date", key: "date_creation", width: 20 },
    { header: "Équipement", key: "nom", width: 25 },
    { header: "Adresse IP", key: "adresse_ip", width: 18 },
    { header: "Niveau", key: "niveau", width: 12 },
    { header: "Statut", key: "statut", width: 12 },
    { header: "Message", key: "message", width: 50 },
  ];
  alertes.forEach((a) => feuilleAl.addRow(a));
  feuilleAl.getRow(1).font = { bold: true };

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=rapport_netsecuremanager.xlsx");

  await workbook.xlsx.write(res);
  res.end();
});

/**
 * POST /api/rapport/envoyer-maintenant
 *
 * Déclenche immédiatement l'envoi des rapports planifiés, en ignorant la
 * planification. Réservé aux administrateurs.
 *
 * Existe pour une raison pratique : sans elle, vérifier que la planification
 * fonctionne demanderait d'attendre le jour et l'heure configurés. La réponse
 * détaille ce qui a été envoyé, à qui, le poids de chaque pièce jointe et les
 * périmètres ignorés faute d'équipements.
 *
 * N'écrit PAS l'horodatage de dernier envoi : un test manuel ne doit pas
 * faire sauter l'envoi automatique du jour.
 */
router.post("/rapport/envoyer-maintenant", requireRole("admin"), async (req, res) => {
  try {
    const bilan = await envoyerRapportsPlanifies({ forcer: true });
    res.json(bilan);
  } catch (err) {
    console.error("Envoi manuel du rapport impossible:", err);
    res.status(500).json({ error: "Envoi impossible", details: err.message });
  }
});

/** État de la planification, pour affichage. */
router.get("/rapport/planification", async (req, res) => {
  const moment = await estLeMoment();
  res.json(moment);
});

module.exports = router;