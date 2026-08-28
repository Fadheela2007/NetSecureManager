/**
 * rapportService.js
 * Collecte des données et génération du rapport PDF de supervision.
 *
 * Extrait de routes/rapports.js pour être partagé entre :
 *   - la route GET /api/rapport/pdf (téléchargement à la demande)
 *   - le planificateur d'envoi par e-mail (rapportPlanifieService)
 *
 * Le périmètre est passé EXPLICITEMENT (`portee`), pas déduit d'un objet
 * `req` : le planificateur n'a pas de requête HTTP. C'est la seule raison
 * de ce paramètre — la règle de cloisonnement reste la même que partout
 * ailleurs (null = global, sinon un site précis).
 */

const PDFDocument = require("pdfkit");
const db = require("../db");
const { calculerDisponibiliteLot } = require("./disponibiliteService");

/** Formate un taux, en distinguant « non fiable » de « 100 % ». */
function formaterTaux(d) {
  if (!d) return "—";
  if (!d.fiable) return `${d.taux_indicatif?.toFixed(2) ?? "—"} % (indicatif)`;
  return `${d.taux_disponibilite.toFixed(2)} %`;
}

/**
 * Rassemble tout ce dont le rapport a besoin.
 *
 * @param {object} options
 * @param {number|null} options.portee   site de rattachement, null = global
 * @param {number|null} [options.idSite] filtre supplémentaire demandé
 */
async function collecterDonnees({ portee = null, idSite = null } = {}) {
  const [equipements] = await db.query(
    `SELECT * FROM EQUIPEMENT
     WHERE (? IS NULL OR id_site = ?) AND (? IS NULL OR id_site = ?)`,
    [idSite, idSite, portee, portee]
  );

  const [alertes] = await db.query(
    `SELECT a.*, e.adresse_ip, e.nom FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE a.date_creation >= NOW() - INTERVAL 30 DAY
       AND (? IS NULL OR COALESCE(a.id_site, e.id_site) = ?)
     ORDER BY a.date_creation DESC`,
    [portee, portee]
  );

  // 3 requêtes au total quel que soit le nombre d'équipements.
  const dispos = await calculerDisponibiliteLot(equipements, 30);

  return { equipements, alertes, dispos };
}

/**
 * Écrit le contenu du rapport dans un document pdfkit déjà ouvert.
 * Séparé de la génération pour que la route puisse diffuser en flux
 * (`doc.pipe(res)`) et le planificateur produire un Buffer, sans dupliquer
 * la mise en page.
 */
function composerPdf(doc, { equipements, alertes, dispos }, { titreSuffixe = "" } = {}) {
  doc.fontSize(18).fillColor("black").text(
    `NetSecureManager — Rapport de supervision${titreSuffixe ? ` — ${titreSuffixe}` : ""}`,
    { align: "center" }
  );
  doc.moveDown();
  doc.fontSize(10).fillColor("gray")
    .text(`Généré le ${new Date().toLocaleString("fr-FR")}`, { align: "center" });
  doc.moveDown(2);

  const enLigne = equipements.filter((e) => e.statut === "up").length;
  const horsLigne = equipements.filter((e) => e.statut === "down").length;
  const inconnus = equipements.filter((e) => e.statut === "inconnu").length;

  doc.fontSize(14).fillColor("black").text("Résumé");
  doc.fontSize(11).text(`Équipements supervisés : ${equipements.length}`);
  doc.text(`En ligne : ${enLigne}  —  Hors ligne : ${horsLigne}` +
    (inconnus > 0 ? `  —  État inconnu : ${inconnus}` : ""));
  doc.text(`Alertes des 30 derniers jours : ${alertes.length}`);
  if (inconnus > 0) {
    doc.fontSize(9).fillColor("gray").text(
      "« État inconnu » : sites dont l'agent n'a plus transmis. Leur état n'est pas observable."
    );
  }
  doc.moveDown(1.5);

  const couverture = equipements.length > 0
    ? dispos.get(Number(equipements[0].id_equipement))
    : null;

  doc.fontSize(14).fillColor("black").text("Équipements");
  doc.fontSize(8).fillColor("gray").text(
    "Disponibilité calculée sur 30 jours à partir des alertes d'indisponibilité. " +
      "Les interruptions plus courtes que le seuil d'alerte ne sont pas comptabilisées : " +
      "ces taux sont des majorants."
  );
  if (couverture && couverture.couverture_pourcent < 80) {
    doc.fontSize(8).fillColor("red").text(
      `Attention : la supervision n'a collecté que ${couverture.couverture_pourcent} % de la période. ` +
        "Les taux ci-dessous sont indicatifs."
    );
  }
  doc.moveDown(0.5);

  equipements.forEach((eq) => {
    const d = dispos.get(Number(eq.id_equipement));
    const couleur = eq.statut === "up" ? "green" : eq.statut === "down" ? "red" : "gray";
    doc.fontSize(9).fillColor(couleur).text(
      `● ${eq.nom || eq.adresse_ip}  —  ${eq.adresse_ip}  —  ${eq.fabricant || "inconnu"}  —  ` +
        `${eq.statut}  —  dispo. ${formaterTaux(d)}`
    );
  });
  doc.moveDown(1.5);

  doc.fontSize(14).fillColor("black").text("Alertes récentes (30 derniers jours)");
  doc.moveDown(0.5);
  if (alertes.length === 0) {
    doc.fontSize(9).fillColor("gray").text("Aucune alerte sur cette période.");
  } else {
    alertes.slice(0, 40).forEach((a) => {
      doc.fontSize(9).fillColor("black").text(
        `${new Date(a.date_creation).toLocaleString("fr-FR")} — ${a.nom || a.adresse_ip || "site"} — ` +
          `${a.niveau} — ${a.statut}`
      );
    });
    if (alertes.length > 40) {
      doc.fontSize(9).fillColor("gray")
        .text(`… et ${alertes.length - 40} autre(s) alerte(s) non détaillée(s).`);
    }
  }
}

/**
 * Génère le PDF complet en mémoire.
 * @returns {Promise<Buffer>}
 */
function genererPdfBuffer(donnees, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const morceaux = [];
      doc.on("data", (c) => morceaux.push(c));
      doc.on("end", () => resolve(Buffer.concat(morceaux)));
      doc.on("error", reject);

      composerPdf(doc, donnees, options);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { collecterDonnees, composerPdf, genererPdfBuffer, formaterTaux };
