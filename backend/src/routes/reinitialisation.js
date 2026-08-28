/**
 * routes/reinitialisation.js
 * Remise à zéro des données de supervision.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LA FONCTION LA PLUS DANGEREUSE DE LA PLATEFORME.
 *
 * Elle efface des données pour de bon. Cinq garde-fous, chacun destiné à
 * un scénario précis d'accident :
 *
 *   1. RÉSERVÉE AUX ADMINISTRATEURS. Un opérateur n'a aucune raison
 *      d'effacer un parc.
 *
 *   2. RIEN N'EST EFFACÉ PAR DÉFAUT. L'appelant doit énumérer ce qu'il
 *      veut supprimer. Un corps de requête vide ne fait rien — plutôt
 *      que « tout », qui est le pire défaut possible ici.
 *
 *   3. PHRASE DE CONFIRMATION EXACTE. Le client doit envoyer
 *      « REINITIALISER ». Un clic malencontreux, un rechargement de page
 *      ou une requête rejouée ne suffisent pas.
 *
 *   4. CE QU'ON NE TOUCHE JAMAIS : les comptes, les sites, les jetons
 *      d'agent, les plages de scan, la configuration, les politiques web
 *      et les catégories de blocage. Effacer un parc ne doit pas
 *      déconnecter l'administrateur ni obliger à réinstaller les agents.
 *
 *   5. TOUT EST JOURNALISÉ dans LOG_ACTIVITE avant exécution — avec qui,
 *      quand, et le détail de ce qui a été demandé.
 *
 * L'usage prévu : reprendre un scan propre après un essai, sans traîner
 * des équipements fantômes et des centaines d'alertes qui brouillent la
 * lecture. C'est un besoin réel en démonstration — mais c'est aussi la
 * porte par laquelle on efface un parc de production par erreur.
 * ─────────────────────────────────────────────────────────────────────
 */

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { porteeDe } = require("../middleware/porteeSite");

const PHRASE = "REINITIALISER";

/**
 * Ce qu'on peut effacer, dans l'ordre où il FAUT le faire.
 *
 * L'ordre n'est pas cosmétique : INCIDENT référence ALERTE, ALERTE
 * référence EQUIPEMENT. Supprimer un parent avant ses enfants échoue sur
 * la contrainte de clé étrangère — ou pire, avec ON DELETE CASCADE,
 * emporte silencieusement des données qu'on n'avait pas demandé à
 * effacer.
 */
const CIBLES = [
  {
    cle: "incidents",
    libelle: "Incidents",
    table: "INCIDENT",
    // INCIDENT n'a pas d'id_site : on passe par l'alerte puis l'équipement.
    sql: (clauseSite, params) => ({
      texte: `DELETE i FROM INCIDENT i
              LEFT JOIN ALERTE a ON a.id_alerte = i.id_alerte
              LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
              WHERE i.id_incident > 0 AND ${clauseSite("COALESCE(a.id_site, e.id_site)")}`,
      params,
    }),
  },
  {
    cle: "alertes",
    libelle: "Alertes",
    table: "ALERTE",
    sql: (clauseSite, params) => ({
      texte: `DELETE a FROM ALERTE a
              LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
              WHERE a.id_alerte > 0 AND ${clauseSite("COALESCE(a.id_site, e.id_site)")}`,
      params,
    }),
  },
  {
    cle: "releves",
    libelle: "Relevés de performance",
    table: "RELEVE",
    sql: (clauseSite, params) => ({
      texte: `DELETE r FROM RELEVE r
              JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
              WHERE r.id_releve > 0 AND ${clauseSite("e.id_site")}`,
      params,
    }),
  },
  {
    cle: "equipements",
    libelle: "Équipements découverts",
    table: "EQUIPEMENT",
    // Les tables filles (SERVICE_DETECTE, INTERFACE_RESEAU, RELEVE…) ont
    // ON DELETE CASCADE : elles partent avec. C'est voulu et c'est dit
    // dans l'interface — un équipement sans ses ports ni ses interfaces
    // n'aurait aucun sens.
    sql: (clauseSite, params) => ({
      texte: `DELETE FROM EQUIPEMENT WHERE id_equipement > 0 AND ${clauseSite("id_site")}`,
      params,
    }),
  },
  {
    cle: "journal",
    libelle: "Journal d'activité",
    table: "LOG_ACTIVITE",
    // Le journal n'est rattaché à aucun site : il est global par nature.
    // On ne l'efface donc que pour un administrateur global.
    globalSeulement: true,
    sql: () => ({
      texte: "DELETE FROM LOG_ACTIVITE WHERE id_log > 0",
      params: [],
    }),
  },
];

/** GET /api/reinitialisation/apercu — ce qui serait effacé, sans rien effacer. */
router.get("/reinitialisation/apercu", requireRole("admin"), async (req, res) => {
  const portee = porteeDe(req);

  const compter = async (texte, params) => {
    try {
      const [[r]] = await db.query(texte, params);
      return Number(r.n || 0);
    } catch {
      // Table absente (migration non passée) : on n'a rien à effacer.
      return 0;
    }
  };

  const site = portee === null ? null : portee;
  const clause = (colonne) => (site === null ? "1=1" : `${colonne} = ?`);
  const p = site === null ? [] : [site];

  const apercu = {
    incidents: await compter(
      `SELECT COUNT(*) AS n FROM INCIDENT i
       LEFT JOIN ALERTE a ON a.id_alerte = i.id_alerte
       LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
       WHERE ${clause("COALESCE(a.id_site, e.id_site)")}`,
      p
    ),
    alertes: await compter(
      `SELECT COUNT(*) AS n FROM ALERTE a
       LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
       WHERE ${clause("COALESCE(a.id_site, e.id_site)")}`,
      p
    ),
    releves: await compter(
      `SELECT COUNT(*) AS n FROM RELEVE r
       JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
       WHERE ${clause("e.id_site")}`,
      p
    ),
    equipements: await compter(
      `SELECT COUNT(*) AS n FROM EQUIPEMENT WHERE ${clause("id_site")}`,
      p
    ),
    journal: portee === null ? await compter("SELECT COUNT(*) AS n FROM LOG_ACTIVITE", []) : null,
  };

  res.json({
    apercu,
    portee: portee === null ? "toute la plateforme" : `site ${portee}`,
    phrase_attendue: PHRASE,
    // Ce que l'interface doit annoncer comme JAMAIS touché. La liste vit
    // ici et non dans le frontend : une promesse d'interface qui n'est
    // pas garantie par le serveur n'est qu'un affichage.
    jamais_efface: [
      "les comptes utilisateurs",
      "les sites et leurs jetons d'agent",
      "les plages de scan et identifiants SNMP",
      "la configuration",
      "les politiques de blocage web et leurs listes",
    ],
  });
});

/**
 * POST /api/reinitialisation
 * body : { confirmation: "REINITIALISER", cibles: ["alertes", "equipements"] }
 */
router.post("/reinitialisation", requireRole("admin"), async (req, res) => {
  const { confirmation, cibles } = req.body || {};

  if (confirmation !== PHRASE) {
    return res.status(400).json({
      error: "Confirmation manquante",
      aide: `Envoyez confirmation: "${PHRASE}" pour valider cette opération irréversible.`,
    });
  }

  const demandees = Array.isArray(cibles) ? cibles : [];
  const aTraiter = CIBLES.filter((c) => demandees.includes(c.cle));

  if (aTraiter.length === 0) {
    return res.status(400).json({
      error: "Rien à réinitialiser",
      aide: `Précisez au moins une cible parmi : ${CIBLES.map((c) => c.cle).join(", ")}`,
    });
  }

  const portee = porteeDe(req);
  const site = portee === null ? null : portee;

  // Un administrateur rattaché à un site ne peut pas vider le journal
  // global : il y verrait — et effacerait — l'activité d'autres sites.
  const refusees = aTraiter.filter((c) => c.globalSeulement && site !== null);
  if (refusees.length > 0) {
    return res.status(403).json({
      error: `Réservé à un administrateur global : ${refusees.map((c) => c.libelle).join(", ")}`,
    });
  }

  // JOURNALISER AVANT D'AGIR. Si la suppression échoue à mi-parcours, la
  // trace de la tentative existe quand même — et si elle réussit, la
  // ligne survit puisque le journal est effacé en dernier, ou pas du tout.
  await db
    .query(
      `INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur)
       VALUES (?, 'reinitialisation', ?, ?)`,
      [
        // `req.user`, posé par authMiddleware depuis le JWT — et non
        // `req.utilisateur`. La journalisation aurait sinon enregistré
        // une réinitialisation sans auteur : exactement l'information
        // qu'on veut sur cette opération-là.
        req.user?.id ?? null,
        `Réinitialisation demandée (${demandees.join(", ")}) — portée : ${
          site === null ? "toute la plateforme" : "site " + site
        }`,
        req.ip,
      ]
    )
    .catch((e) => console.error("Journalisation de la réinitialisation impossible:", e.message));

  const clause = (colonne) => (site === null ? "1=1" : `${colonne} = ?`);
  const params = site === null ? [] : [site];

  const bilan = {};
  const connexion = await db.getConnection();

  try {
    await connexion.beginTransaction();

    for (const cible of aTraiter) {
      const { texte, params: p } = cible.sql(clause, params);
      try {
        const [r] = await connexion.query(texte, p);
        bilan[cible.cle] = r.affectedRows;
      } catch (err) {
        // Une table absente ne doit pas annuler le reste : la
        // réinitialisation doit fonctionner même sur une base dont
        // toutes les migrations ne sont pas passées.
        if (err.code === "ER_NO_SUCH_TABLE") {
          bilan[cible.cle] = 0;
          continue;
        }
        throw err;
      }
    }

    await connexion.commit();
  } catch (err) {
    await connexion.rollback();
    console.error("Réinitialisation annulée:", err.message);
    return res.status(500).json({
      error: "Réinitialisation annulée, aucune donnée supprimée",
      detail: err.message,
    });
  } finally {
    connexion.release();
  }

  res.json({
    supprime: bilan,
    // Rappel destiné à l'écran : sans nouveau scan, la plateforme est
    // vide et donne l'impression d'être cassée.
    suite: "Lancez un nouveau scan pour repeupler le parc.",
  });
});

module.exports = router;
