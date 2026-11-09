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
  envoyerRapportAUtilisateur,
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

/* ═══════════════════════════════════════════════════════════════════════
   UN FREIN, ET IL EST VOLONTAIREMENT SIMPLE

   Générer un PDF et l'expédier coûte du temps de serveur. Un bouton
   qu'on peut presser trente fois d'affilée — par impatience, ou parce
   que rien ne semble se passer — fabrique trente PDF et trente messages.

   Une minute entre deux envois pour une même personne suffit à écarter
   ce cas, sans jamais gêner l'usage réel : on ne demande pas deux fois
   son rapport dans la même minute.

   En mémoire et non en base : perdre ce compteur au redémarrage n'a
   aucune conséquence, et ça évite une table pour trois nombres.
   ═══════════════════════════════════════════════════════════════════════ */
const DELAI_ENTRE_ENVOIS_MS = 60000;
const dernierEnvoiPersonnel = new Map();

/**
 * POST /api/rapport/m-envoyer
 *
 * ═══════════════════════════════════════════════════════════════════════
 * « À MOI », ET À PERSONNE D'AUTRE
 *
 * L'envoi existant — `/rapport/envoyer-maintenant` — écrit à tous les
 * destinataires de tous les périmètres. C'est un geste d'administration,
 * et il demande le niveau « administrer ».
 *
 * Celui-ci n'envoie qu'à la personne connectée, à l'adresse que porte
 * son compte. Il demande donc seulement « modifier » : recevoir par
 * courrier ce qu'on peut déjà télécharger d'un clic n'est pas un
 * pouvoir supplémentaire.
 *
 * ── AUCUN CHAMP « DESTINATAIRE » ──
 *
 * Et ce n'est pas un oubli. La page d'inscription est ouverte : n'importe
 * qui peut créer un compte. Si le destinataire était saisissable, chacun
 * disposerait d'un serveur pour écrire aux autres sous l'identité de la
 * plateforme. L'adresse est donc lue en base, à partir du jeton signé.
 */
router.post("/rapport/m-envoyer", requireRole("admin", "operateur"), async (req, res) => {
  const id = req.user?.id;
  if (!id) return res.status(401).json({ error: "Compte inconnu" });

  const precedent = dernierEnvoiPersonnel.get(id) || 0;
  const reste = DELAI_ENTRE_ENVOIS_MS - (Date.now() - precedent);
  if (reste > 0) {
    return res.status(429).json({
      error: "Vous venez de demander ce rapport",
      aide: `Réessayez dans ${Math.ceil(reste / 1000)} seconde(s).`,
    });
  }

  try {
    const bilan = await envoyerRapportAUtilisateur(id);

    /* L'HORODATAGE N'EST POSÉ QU'EN CAS DE SUCCÈS. Un envoi qui n'a pas
       abouti — SMTP absent, périmètre vide — ne doit pas bloquer la
       minute suivante : la personne corrigerait le problème et se
       heurterait à un refus qui ne parle pas de ce qu'elle vient de
       réparer. */
    if (bilan.envoye) dernierEnvoiPersonnel.set(id, Date.now());

    res.json(bilan);
  } catch (err) {
    console.error("Envoi du rapport personnel impossible:", err);
    // Pas de `err.message` dans la réponse : il peut contenir l'adresse
    // du serveur SMTP ou le nom de la base.
    res.status(500).json({ error: "Envoi impossible" });
  }
});

/** État de la planification, pour affichage. */
router.get("/rapport/planification", async (req, res) => {
  const moment = await estLeMoment();
  res.json(moment);
});

module.exports = router;