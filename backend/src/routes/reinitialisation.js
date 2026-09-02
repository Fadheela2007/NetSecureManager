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
const { porteeDe, siteAutorise } = require("../middleware/porteeSite");

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


/**
 * Portée EFFECTIVE de l'opération : celle de l'utilisateur, éventuellement
 * restreinte à un site qu'il a explicitement désigné.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE PARAMÈTRE EXISTE
 *
 * Sans lui, la réinitialisation était tout ou rien : un administrateur de
 * plateforme ne pouvait que vider LES DEUX sites à la fois. Or « je veux
 * refaire le scan de l'agence de Yaoundé » est la demande la plus banale
 * qui soit sur un outil multi-sites — et la seule façon de la satisfaire
 * était de tout effacer, y compris l'historique du siège.
 *
 * LE PARAMÈTRE NE PEUT PAS ÉLARGIR LES DROITS, SEULEMENT LES RESTREINDRE.
 * Un administrateur rattaché au site 1 qui demanderait le site 2 est
 * refusé : sa portée reste la borne. Le champ vient du client, la portée
 * vient du jeton signé — seule la seconde fait autorité.
 * ─────────────────────────────────────────────────────────────────────
 *
 * @returns {{ site: number|null } | { erreur: string }}
 */
function resoudrePortee(req, idSiteDemande) {
  const portee = porteeDe(req);

  // Rien de demandé : on garde la portée de l'utilisateur.
  if (idSiteDemande === undefined || idSiteDemande === null || idSiteDemande === "") {
    return { site: portee };
  }

  // Liste BLANCHE des formes acceptées, et non simple appel à Number().
  // `Number(true)` vaut 1 et `Number(["2"])` vaut 2 : sans ce filtre, un
  // client qui envoie une valeur aberrante déclenche une suppression sur
  // un site qu'il n'a jamais désigné. Un test l'a démontré.
  const forme = typeof idSiteDemande;
  if (forme !== "number" && forme !== "string") {
    return { erreur: "Le site visé doit être un identifiant valide." };
  }
  const cible = Number(idSiteDemande);
  if (!Number.isInteger(cible) || cible <= 0) {
    return { erreur: "Le site visé doit être un identifiant valide." };
  }
  if (!siteAutorise(req, cible)) {
    // Même raisonnement qu'ailleurs : on ne confirme pas l'existence d'un
    // site hors périmètre.
    return { erreur: "Site introuvable" };
  }
  return { site: cible };
}

/** GET /api/reinitialisation/apercu — ce qui serait effacé, sans rien effacer. */
router.get("/reinitialisation/apercu", requireRole("admin"), async (req, res) => {
  const resolution = resoudrePortee(req, req.query.id_site);
  if (resolution.erreur) return res.status(400).json({ error: resolution.erreur });
  const portee = resolution.site;

  const compter = async (texte, params) => {
    try {
      const [[r]] = await db.query(texte, params);
      return Number(r.n || 0);
    } catch {
      // Table absente (migration non passée) : on n'a rien à effacer.
      return 0;
    }
  };

  const site = portee;
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

  // Les sites que CET utilisateur peut viser. La liste vient du serveur et
  // non du frontend : un administrateur rattaché ne doit pas même voir
  // qu'un autre site existe.
  let sites = [];
  try {
    const [rows] = await db.query(
      `SELECT s.id_site, s.nom, s.ville,
              (SELECT COUNT(*) FROM EQUIPEMENT e WHERE e.id_site = s.id_site) AS equipements
       FROM SITE s
       WHERE (? IS NULL OR s.id_site = ?)
       ORDER BY s.nom`,
      [porteeDe(req), porteeDe(req)]
    );
    sites = rows.map((r) => ({
      id_site: r.id_site,
      nom: r.nom,
      ville: r.ville,
      equipements: Number(r.equipements) || 0,
    }));
  } catch {
    // Une liste de sites indisponible ne doit pas empêcher l'aperçu :
    // l'écran retombe alors sur la portée de l'utilisateur.
    sites = [];
  }

  const nomDuSite = site === null ? null : sites.find((x) => x.id_site === site)?.nom || `site ${site}`;

  res.json({
    apercu,
    portee: site === null ? "toute la plateforme" : nomDuSite,
    site_choisi: site,
    sites,
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
  const { confirmation, cibles, id_site: idSiteDemande } = req.body || {};

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

  const resolution = resoudrePortee(req, idSiteDemande);
  if (resolution.erreur) return res.status(400).json({ error: resolution.erreur });
  const site = resolution.site;

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

  /* ─────────────────────────────────────────────────────────────────
     LA TRACE DOIT SURVIVRE À L'OPÉRATION QUI L'A ÉCRITE.

     La ligne de journal est écrite AVANT d'agir, pour qu'elle existe
     même si la suppression échoue à mi-parcours. Le commentaire d'origine
     en concluait : « si elle réussit, la ligne survit puisque le journal
     est effacé en dernier, ou pas du tout ».

     C'était faux. Quand « journal » figure parmi les cibles, le DELETE
     final emporte AUSSI la ligne qu'on venait d'écrire. La fonction la
     plus destructrice du produit effaçait donc sa propre trace.

     CE QUE ÇA A COÛTÉ, ICI, PENDANT LES TESTS. Un parc est passé de 92 à
     35 équipements du jour au lendemain. Le journal ne montrait AUCUNE
     réinitialisation. Il a fallu une demi-heure et trois hypothèses —
     dont « le produit supprime des machines tout seul » — pour
     comprendre qu'une réinitialisation avait bien eu lieu et avait effacé
     son propre enregistrement.

     Chez un client, la même situation est ingérable : un administrateur
     nie avoir touché à quoi que ce soit, et rien ne permet de trancher.

     On réécrit donc la trace APRÈS coup lorsque le journal a été vidé.
     ───────────────────────────────────────────────────────────────── */
  if (aTraiter.some((c) => c.cle === "journal")) {
    await db
      .query(
        `INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur)
         VALUES (?, 'reinitialisation', ?, ?)`,
        [
          req.user?.id ?? null,
          `Réinitialisation effectuée (${demandees.join(", ")}) — portée : ${
            site === null ? "toute la plateforme" : "site " + site
          }. Le journal d'activité a été vidé : cette ligne est la première ` +
            `du nouveau journal, réécrite après l'opération pour qu'elle en garde la trace. ` +
            `Supprimé : ${Object.entries(bilan)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}`,
          req.ip,
        ]
      )
      .catch((e) => console.error("Réécriture de la trace impossible:", e.message));
  }

  res.json({
    supprime: bilan,
    // Rappel destiné à l'écran : sans nouveau scan, la plateforme est
    // vide et donne l'impression d'être cassée.
    suite: "Lancez un nouveau scan pour repeupler le parc.",
  });
});

module.exports = router;
// Exposée pour les tests : c'est la règle qui garantit qu'un paramètre
// venu du client ne peut pas élargir la portée d'une suppression.
module.exports.resoudrePortee = resoudrePortee;
