/**
 * routes/trafic.js
 * Vers quoi part le débit.
 *
 * Deux lectures, et rien d'autre : cette route n'écrit jamais. Ce qu'elle
 * sert vient de FLUX_DESTINATION, remplie par le collecteur NetFlow.
 *
 * ── SI LA TABLE N'EXISTE PAS ──
 *
 * Elle répond 404 avec une explication, et l'interface masque simplement
 * la section. C'est la convention déjà suivie par /reseau/qualite sur
 * cette même page : une fonction qui manque se retire de l'écran, elle ne
 * le casse pas et n'affiche pas d'erreur rouge à l'exploitant, qui n'y
 * peut rien.
 *
 * ── CE QUE CETTE ROUTE NE FAIT PAS ──
 *
 * Elle ne dit pas QUI était devant la machine, ni quelle page a été
 * consultée. Elle dit qu'une machine a échangé N octets avec un serveur.
 * La distinction n'est pas rhétorique : c'est elle qui sépare un outil de
 * diagnostic réseau d'un outil de surveillance des personnes, et c'est la
 * première question que posera un client sérieux.
 */

const express = require("express");
const router = express.Router();
const { clauseSite, verifierAccesEquipement } = require("../middleware/porteeSite");
const { requireRole } = require("../middleware/requireRole");
const destinations = require("../services/destinationService");

/** Bornes de lecture. Une période absurde est ramenée, jamais refusée. */
function bornerHeures(valeur) {
  const h = Number(valeur);
  if (!Number.isFinite(h) || h <= 0) return 24;
  // Plafonné à la durée de conservation : au-delà, la table est vide et
  // l'écran afficherait « rien » pour une période qui a bel et bien
  // existé. Mieux vaut ramener la demande que mentir par omission.
  return Math.min(h, destinations.JOURS_CONSERVATION * 24);
}

function bornerLimite(valeur, defaut = 15) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n <= 0) return defaut;
  return Math.min(n, 100);
}

/**
 * Le classement des correspondants pour tout le parc visible.
 * GET /api/bande-passante/destinations?heures=24&limite=15&id_site=2
 */
router.get("/bande-passante/destinations", requireRole("admin", "operateur"), async (req, res) => {
  const heures = bornerHeures(req.query.heures);
  const limite = bornerLimite(req.query.limite);
  const idSite = req.query.id_site ? Number(req.query.id_site) : null;

  try {
    const portee = clauseSite(req, "e.id_site");
    const donnees = await destinations.destinationsDuSite(portee, heures, limite, idSite);
    res.json({ ...donnees, conservation_jours: destinations.JOURS_CONSERVATION });
  } catch (err) {
    if (estTableAbsente(err)) return res.status(404).json({ error: MESSAGE_ABSENT });
    console.error("destinations du site:", err.message);
    res.status(500).json({ error: "Lecture des destinations impossible" });
  }
});

/**
 * Les correspondants d'une machine.
 * GET /api/equipements/:id/destinations?heures=24
 */
router.get("/equipements/:id/destinations", requireRole("admin", "operateur"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Identifiant invalide" });

  const acces = await verifierAccesEquipement(req, id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const heures = bornerHeures(req.query.heures);
  const limite = bornerLimite(req.query.limite, 10);

  try {
    const donnees = await destinations.destinationsDeLEquipement(id, heures, limite);

    /* ── L'ÉTIQUETTE « INDÉSIRABLE », POSÉE ICI ET NON DANS LE SERVICE ──

       Elle dépend du SITE de la machine, que la vérification d'accès
       vient de rendre. Le service de destinations, lui, ne connaît que
       des flux : lui faire relire l'équipement pour retrouver son site
       aurait ajouté une requête pour une information déjà en main. */
    const marquage = await destinations.marquerIndesirables(
      donnees.destinations,
      acces.idSite ?? null
    );

    res.json({
      ...donnees,
      destinations: marquage.destinations,
      politique: marquage.politique,
      conservation_jours: destinations.JOURS_CONSERVATION,
    });
  } catch (err) {
    if (estTableAbsente(err)) return res.status(404).json({ error: MESSAGE_ABSENT });
    console.error("destinations de l'équipement:", err.message);
    res.status(500).json({ error: "Lecture des destinations impossible" });
  }
});

/**
 * Ce que coûterait le blocage d'un domaine.
 * GET /api/bande-passante/impact-blocage?domaine=exemple.com&heures=168
 *
 * Réservée aux rôles administrateur et opérateur, comme les deux autres
 * routes de ce fichier.
 *
 * LE RAISONNEMENT INITIAL ÉTAIT FAUX. On l'avait ouverte à tout compte
 * authentifié en se disant qu'une question n'est pas une action. Mais la
 * réponse nomme les machines qui ont parlé à un domaine — c'est-à-dire
 * qui, dans l'entreprise, s'en sert. La plateforme réserve déjà les
 * observations DNS aux administrateurs pour cette raison exacte, et un
 * compte en lecture seule est justement celui qu'on distribue le plus
 * largement : stagiaire, prestataire, direction.
 *
 * Un opérateur qui prépare une demande garde l'accès ; le blocage
 * lui-même reste réservé à l'administrateur.
 */
router.get("/bande-passante/impact-blocage", requireRole("admin", "operateur"), async (req, res) => {
  const domaine = String(req.query.domaine || "").trim();
  if (!domaine) return res.status(400).json({ error: "Domaine manquant" });

  const heures = bornerHeures(req.query.heures || 168);

  try {
    const portee = clauseSite(req, "e.id_site");
    const impact = await destinations.impactDuBlocage(portee, domaine, heures);
    if (!impact) return res.status(400).json({ error: "Domaine invalide" });
    res.json({ ...impact, conservation_jours: destinations.JOURS_CONSERVATION });
  } catch (err) {
    if (estTableAbsente(err)) return res.status(404).json({ error: MESSAGE_ABSENT });
    console.error("impact du blocage:", err.message);
    res.status(500).json({ error: "Estimation impossible" });
  }
});

const MESSAGE_ABSENT =
  "Les destinations ne sont pas encore enregistrées sur cette installation.";

/**
 * Distingue « la migration n'est pas appliquée » d'une vraie panne.
 *
 * Sans ce tri, une base momentanément inaccessible produirait le même 404
 * qu'une table manquante, et l'exploitant conclurait à tort que la
 * fonction n'est pas installée.
 */
function estTableAbsente(err) {
  return err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146);
}

module.exports = router;
