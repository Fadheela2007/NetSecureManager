/**
 * routes/sites.js
 * Gestion des sites (villes/agences) : liste, création, et mise en service
 * de l'agent distant.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const fs = require("node:fs/promises");
const path = require("node:path");

/** Le modele vit dans le depot, pas dans le code : il reste lisible et
 *  deployable a la main, sans passer par la plateforme. */
const CHEMIN_SCRIPT_INVENTAIRE = path.join(
  __dirname, "..", "..", "..", "deploiement", "inventaire-poste.ps1"
);
const { clauseSite, porteeDe, siteAutorise } = require("../middleware/porteeSite");
const { tracer } = require("../services/journal");
const { detecterReseaux } = require("../services/reseauxLocauxService");

/** Seuil de silence au-delà duquel un agent est considéré muet (minutes). */
const SEUIL_MUET_DEFAUT = 30;

/* ═══════════════════════════════════════════════════════════════════════
   L'ADRESSE QUE LES POSTES DOIVENT APPELER — ET LE PIÈGE QU'ELLE CACHE

   LE DÉFAUT, ET IL AURAIT RUINÉ UN DÉPLOIEMENT ENTIER.

   L'URL du serveur était déduite de l'en-tête `Host` de la requête.
   C'est juste en production, où l'on ouvre la plateforme par son vrai
   nom. Mais pendant la mise au point, on l'ouvre sur « localhost ».

   Le script téléchargé partait alors avec :

       $CENTRAL_API_URL = "http://localhost:5000/api"

   Déposé sur le partage du domaine et exécuté sur cent postes, chaque
   poste aurait appelé... LUI-MÊME. Cent échecs, aucune remontée, et RIEN
   pour le faire comprendre : le script aurait consciencieusement
   journalisé « impossible de se connecter » sur chacune des cent
   machines, là où personne ne va lire.

   C'est le pire cas possible : le déploiement a lieu, la stratégie de
   groupe est correcte, l'informaticien a fait son travail — et la
   plateforme reste vide. On cherche alors le défaut partout sauf dans
   une adresse écrite au moment du téléchargement.

   LA RÈGLE. Une adresse de bouclage ne désigne que la machine qui la
   prononce : elle n'est jamais joignable par quelqu'un d'autre. Quand on
   en détecte une, on la remplace par l'adresse réelle de ce serveur sur
   le réseau — que la plateforme sait déjà lire, puisqu'elle s'en sert
   pour proposer les plages à scanner.
   ═══════════════════════════════════════════════════════════════════════ */

/** Cette adresse ne désigne que la machine qui la prononce. */
function estBouclage(hote) {
  const nom = String(hote || "").split(":")[0].toLowerCase();
  return nom === "localhost" || nom === "127.0.0.1" || nom === "::1" || nom === "[::1]";
}

/**
 * L'adresse par laquelle les POSTES peuvent joindre ce serveur.
 * @returns {{url: string, corrigee: boolean, avertissement: string|null}}
 */
function adresseJoignable(req) {
  const protocole = req.headers["x-forwarded-proto"] || req.protocol;
  const hote = req.headers["x-forwarded-host"] || req.headers.host || "";

  if (!estBouclage(hote)) {
    return { url: `${protocole}://${hote}/api`, corrigee: false, avertissement: null };
  }

  const port = String(hote).includes(":") ? `:${String(hote).split(":")[1]}` : "";

  /* Les interfaces physiques d'abord : detecterReseaux() range déjà les
     virtuelles (VirtualBox, WSL, Docker) en dernier, et l'adresse d'une
     carte virtuelle n'est pas plus joignable depuis un poste du réseau
     qu'une adresse de bouclage. */
  let reelle = null;
  try {
    const reseaux = detecterReseaux();
    reelle = reseaux.find((r) => !r.virtuelle) || reseaux[0] || null;
  } catch {
    reelle = null;
  }

  if (!reelle) {
    return {
      url: `${protocole}://${hote}/api`,
      corrigee: false,
      avertissement:
        "Cette plateforme a été ouverte sur « localhost » et aucune adresse réseau " +
        "n'a pu être lue sur ce serveur. L'adresse ci-dessus ne fonctionnera QUE sur " +
        "le serveur lui-même : corrigez-la à la main avant de déposer le script sur " +
        "le partage du domaine.",
    };
  }

  return {
    url: `${protocole}://${reelle.adresse}${port}/api`,
    corrigee: true,
    avertissement:
      "Cette plateforme a été ouverte sur « localhost ». L'adresse a été remplacée par " +
      `${reelle.adresse}, celle de ce serveur sur le réseau — sans quoi chaque poste ` +
      "aurait appelé lui-même au lieu d'appeler la plateforme. Vérifiez qu'elle est " +
      "bien celle par laquelle les postes joignent ce serveur.",
  };
}

/**
 * Qualifie l'état de l'agent d'un site à partir de son dernier push.
 * C'est ce qui permet de vérifier une installation en direct, sans
 * attendre le cron de surveillance.
 */
function etatAgent(dernierPush, seuilMinutes = SEUIL_MUET_DEFAUT) {
  if (!dernierPush) {
    return { etat: "jamais_connecte", libelle: "Jamais connecté", minutes: null };
  }
  const minutes = Math.floor((Date.now() - new Date(dernierPush).getTime()) / 60000);
  if (minutes >= seuilMinutes) {
    return { etat: "muet", libelle: `Muet depuis ${minutes} min`, minutes };
  }
  return {
    etat: "actif",
    libelle: minutes < 1 ? "Actif à l'instant" : `Actif il y a ${minutes} min`,
    minutes,
  };
}

/**
 * GET /api/sites
 *
 * ⚠ agent_token est VOLONTAIREMENT exclu de cette projection.
 *
 * Cette route est ouverte à tout utilisateur authentifié — elle alimente
 * le sélecteur de site. Un `SELECT *` y exposait le jeton d'agent à
 * n'importe quel compte, y compris un simple lecteur, qui pouvait alors
 * injecter de faux équipements via POST /api/agent/push. Le jeton n'est
 * plus servi que par GET /api/sites/:id/agent, réservé aux administrateurs.
 */
router.get("/sites", async (req, res) => {
  const portee = clauseSite(req, "id_site");

  // `supervision_par_agent` vient de la migration 2026-09-08. On la lit
  // séparément pour qu'une base non migrée continue de répondre : la liste
  // des sites est l'un des premiers appels de l'interface, la faire échouer
  // rendrait la plateforme inutilisable au lieu de dégrader un détail.
  let colonneMode = "supervision_par_agent";
  let rows;
  try {
    [rows] = await db.query(
      `SELECT id_site, nom, ville, adresse, dernier_push, date_creation, ${colonneMode}
       FROM SITE WHERE ${portee.clause} ORDER BY nom`,
      portee.params
    );
  } catch {
    colonneMode = null;
    [rows] = await db.query(
      `SELECT id_site, nom, ville, adresse, dernier_push, date_creation
       FROM SITE WHERE ${portee.clause} ORDER BY nom`,
      portee.params
    );
  }

  res.json(
    rows.map((s) => ({
      ...s,
      agent: etatAgent(s.dernier_push),
      // MySQL renvoie 1/0 : on normalise en booléen pour que l'interface
      // n'ait pas à connaître cette particularité.
      supervision_par_agent: colonneMode
        ? Boolean(s.supervision_par_agent)
        : // Sans la colonne, on retombe sur l'ancienne déduction — imparfaite,
          // mais cohérente avec ce que fait alors le cycle de supervision.
          s.dernier_push !== null,
    }))
  );
});

router.post("/sites", requireRole("admin"), async (req, res) => {
  // Créer un site est une action de plateforme : un admin rattaché à un site
  // n'a pas vocation à en créer d'autres, qu'il ne pourrait de toute façon
  // pas consulter ensuite.
  if (porteeDe(req) !== null) {
    return res.status(403).json({
      error: "Seul un administrateur global (sans site de rattachement) peut créer un site",
    });
  }
  const { nom, ville } = req.body;
  if (!nom || !ville) {
    return res.status(400).json({ error: "nom et ville sont requis" });
  }

  const agent_token = crypto.randomBytes(24).toString("hex");

  /* ── POURQUOI CE try/catch EXISTE MAINTENANT ──

     C'était la seule route d'écriture de la plateforme qui n'en avait
     pas. Une erreur de base y remontait donc au gestionnaire global :
     l'écran affichait « Impossible de créer le site » — sa phrase par
     défaut, celle qu'il dit quand le serveur n'a rien dit — et la vraie
     raison restait dans la console du serveur, que personne ne regarde
     quand un bouton ne marche pas.

     Une colonne ajoutée par une migration et devenue obligatoire, une
     contrainte de clé étrangère, un dépassement de longueur : trois
     pannes qui se soignent en trois gestes différents, et qui se
     présentaient toutes comme la même. */
  let result;
  try {
    [result] = await db.query(
      "INSERT INTO SITE (nom, ville, agent_token) VALUES (?, ?, ?)",
      [nom, ville, agent_token]
    );
  } catch (err) {
    console.error("Création de site refusée par la base:", err.code, err.message);

    const colonne = err.message.match(/Field '(\w+)' doesn't have a default value/i);
    if (colonne) {
      return res.status(500).json({
        error: "La base exige une colonne que la création ne renseigne pas",
        aide:
          `Colonne « ${colonne[1]} » de la table SITE. Elle a été ajoutée par ` +
          "une migration et n'accepte pas de valeur vide. Rendez-la " +
          "facultative, ou donnez-lui une valeur par défaut.",
      });
    }

    if (err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW") {
      return res.status(500).json({
        error: "La base refuse ce site à cause d'une référence manquante",
        aide: "Une clé étrangère de la table SITE pointe vers une ligne inexistante.",
      });
    }

    /* Le message brut de MySQL en dernier recours. Il n'est pas beau,
       mais il NOMME le problème — et c'est tout ce qu'on lui demande
       quand les cas connus n'ont pas répondu. */
    return res.status(500).json({
      error: "Création du site impossible",
      aide: err.sqlMessage || err.message,
    });
  }

  await tracer(req, "site_cree", `Site « ${nom} » (${ville}) créé`);

  res.json({ id_site: result.insertId, nom, ville, agent_token });
});

/* ═══════════════════════════════════════════════════════════════════════
   LA VUE D'UN SITE — ASSEMBLÉE TOUTE SEULE

   ── CE QUE CET ÉCRAN FAIT, ET QUE LES AUTRES OUTILS NE FONT PAS ──

   Chez eux, un tableau de bord se CONSTRUIT : on crée le tableau, on
   ajoute une tuile, on choisit l'élément à surveiller, on règle l'unité,
   on recommence pour chaque machine. Une demi-journée pour un site, et
   tout est à refaire au suivant.

   Ici il n'y a rien à configurer. Le scan a déjà appris ce qu'il y a sur
   le réseau ; cette route le met en forme. Le contenu de l'écran découle
   de ce qui a été TROUVÉ, pas de ce qu'un administrateur a pensé à
   déclarer. Un site scanné ce matin a sa vue complète ce matin.

   ── UNE SEULE REQUÊTE HTTP, HUIT LECTURES ──

   L'assemblage a lieu ICI, pas dans le navigateur. Sept allers-retours
   depuis l'écran auraient affiché un bloc à la fois, dans le désordre,
   chacun avec son propre moment d'erreur. Une vue qui se compose par
   morceaux donne l'impression d'un outil qui hésite.

   ── CHAQUE BLOC TOMBE TOUT SEUL ──

   Une migration non passée rend ce bloc `null`, jamais zéro, et les
   autres continuent. `null` se lit « nous ne savons pas » ; zéro se lit
   « il n'y en a pas ». Sur un outil de supervision, confondre les deux
   est la faute qui coûte la confiance.
   ═══════════════════════════════════════════════════════════════════════ */

/** Exécute une lecture, et rend `null` si la table ou la colonne manque. */
async function lireOuRien(requete) {
  try {
    return await requete();
  } catch (err) {
    if (/doesn't exist|Unknown column/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * GET /api/sites/:id/vue
 *
 * Tout ce qu'on sait d'un site, en un seul appel. Ouverte à tout compte
 * qui a le droit de voir l'écran Sites : elle ne fait que rassembler des
 * chiffres déjà consultables ailleurs.
 */
router.get("/sites/:id/vue", async (req, res) => {
  const [lignes] = await db.query(
    `SELECT id_site, nom, ville, dernier_push, supervision_par_agent
       FROM SITE WHERE id_site = ?`,
    [req.params.id]
  ).catch(async () => {
    // Base d'avant la migration du 8 septembre.
    return db.query("SELECT id_site, nom, ville, dernier_push FROM SITE WHERE id_site = ?", [
      req.params.id,
    ]);
  });

  const site = lignes[0];
  if (!site || !siteAutorise(req, site.id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }
  const id = site.id_site;

  try {
    /* ── LE PARC, PAR ÉTAT ──
       `inconnu` est compté à part, et c'est le cœur du sujet : une
       machine dont on n'a aucune nouvelle n'est PAS une machine hors
       ligne. Les additionner ferait annoncer des pannes imaginaires. */
    const [[parc]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(statut = 'up')   AS en_ligne,
              SUM(statut = 'down') AS hors_ligne,
              SUM(statut NOT IN ('up','down') OR statut IS NULL) AS inconnu
         FROM EQUIPEMENT WHERE id_site = ?`,
      [id]
    );

    /* ── CE QU'IL Y A SUR CE RÉSEAU ──
       Découvert par le scan, jamais déclaré à la main. C'est exactement
       ce qu'un autre outil demanderait de saisir machine par machine. */
    const [types] = await db.query(
      `SELECT COALESCE(t.libelle, 'indéterminé') AS libelle, COUNT(*) AS nombre
         FROM EQUIPEMENT e
         LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
        WHERE e.id_site = ?
        GROUP BY COALESCE(t.libelle, 'indéterminé')
        ORDER BY nombre DESC`,
      [id]
    );

    const [[alertes]] = await db.query(
      `SELECT COUNT(*) AS actives,
              SUM(a.niveau = 'critical') AS critiques
         FROM ALERTE a
         LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
        WHERE a.statut IN ('active','traitee')
          AND (e.id_site = ? OR a.id_site = ?)`,
      [id, id]
    ).catch(async () =>
      db.query(
        `SELECT COUNT(*) AS actives, SUM(a.niveau = 'critical') AS critiques
           FROM ALERTE a JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
          WHERE a.statut IN ('active','traitee') AND e.id_site = ?`,
        [id]
      )
    );

    const preuves = await lireOuRien(async () => {
      const [rows] = await db.query(
        `SELECT COALESCE(preuve_existence, 'inconnue') AS preuve,
                COUNT(*) AS nombre, MIN(date_preuve) AS plus_ancienne
           FROM EQUIPEMENT WHERE id_site = ?
          GROUP BY COALESCE(preuve_existence, 'inconnue')
          ORDER BY nombre DESC`,
        [id]
      );
      return rows.map((r) => ({ ...r, nombre: Number(r.nombre) }));
    });

    const [consommateurs] = await db.query(
      `SELECT e.id_equipement, e.adresse_ip,
              COALESCE(e.nom_personnalise, e.nom) AS nom,
              AVG(r.trafic_entrant_kbps) + AVG(r.trafic_sortant_kbps) AS kbps
         FROM RELEVE r
         JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
        WHERE e.id_site = ?
          AND r.date_releve >= NOW() - INTERVAL 24 HOUR
          AND (r.trafic_entrant_kbps IS NOT NULL OR r.trafic_sortant_kbps IS NOT NULL)
        GROUP BY e.id_equipement, e.adresse_ip, e.nom_personnalise, e.nom
        ORDER BY kbps DESC
        LIMIT 5`,
      [id]
    );

    const [plages] = await db.query(
      "SELECT cidr, actif FROM PLAGE_SCAN WHERE id_site = ? ORDER BY cidr",
      [id]
    );

    /* ── LES COURBES, SUR 24 HEURES ──

       Un chiffre dit l'état à l'instant où on regarde ; une courbe dit
       la tendance. C'est la différence entre « 2 machines hors ligne »
       et « elles tombent toutes les nuits à 19 h ».

       Un point par heure : le cycle en produit un par minute, mais
       1 440 points sur un écran large donnent une ligne illisible et
       pèsent pour rien. */
    const [historique] = await db.query(
      `SELECT DATE_FORMAT(r.date_releve, '%Y-%m-%d %H:00:00') AS instant,
              COUNT(DISTINCT r.id_equipement) AS repondants,
              AVG(r.latence_ms) AS latence,
              AVG(r.trafic_entrant_kbps) + AVG(r.trafic_sortant_kbps) AS debit
         FROM RELEVE r
         JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
        WHERE e.id_site = ? AND r.date_releve >= NOW() - INTERVAL 24 HOUR
        GROUP BY instant
        ORDER BY instant ASC`,
      [id]
    );

    /* ── LA CHARGE MOYENNE, POUR LES JAUGES ──
       Sur la dernière heure, et UNIQUEMENT sur les machines qui ont
       répondu. Moyenner sur tout le parc ferait baisser le chiffre à
       proportion des machines muettes — un parc à 90 % de charge
       paraîtrait tranquille parce que neuf machines sur dix ne disent
       rien. */
    const [[charge]] = await db.query(
      `SELECT AVG(r.cpu_pourcent) AS cpu,
              AVG(r.ram_pourcent) AS ram,
              COUNT(DISTINCT CASE WHEN r.cpu_pourcent IS NOT NULL
                                  THEN r.id_equipement END) AS machines
         FROM RELEVE r
         JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
        WHERE e.id_site = ? AND r.date_releve >= NOW() - INTERVAL 1 HOUR`,
      [id]
    );

    /* ── LES PROBLÈMES, NOMMÉS ──
       Un compteur d'alertes ne dit pas quoi faire. La liste, si. */
    const [problemes] = await db.query(
      `SELECT a.id_alerte, a.type_alerte, a.niveau, a.message,
              a.date_creation, a.occurrences,
              COALESCE(e.nom_personnalise, e.nom, e.adresse_ip) AS machine
         FROM ALERTE a
         LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
        WHERE a.statut IN ('active','traitee')
          AND (e.id_site = ? OR a.id_site = ?)
        ORDER BY FIELD(a.niveau,'critical','warning','info'), a.date_creation DESC
        LIMIT 6`,
      [id, id]
    ).catch(async () =>
      db.query(
        `SELECT a.id_alerte, a.type_alerte, a.niveau, a.message,
                a.date_creation, a.occurrences,
                COALESCE(e.nom_personnalise, e.nom, e.adresse_ip) AS machine
           FROM ALERTE a JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
          WHERE a.statut IN ('active','traitee') AND e.id_site = ?
          ORDER BY FIELD(a.niveau,'critical','warning','info'), a.date_creation DESC
          LIMIT 6`,
        [id]
      )
    );

    /* La dernière fois que ce réseau a été exploré. C'est la date qui
       dit si tout le reste de l'écran est encore d'actualité. */
    const dernierScan = await lireOuRien(async () => {
      const [[r]] = await db.query(
        "SELECT MAX(date_preuve) AS quand FROM EQUIPEMENT WHERE id_site = ?",
        [id]
      );
      return r?.quand || null;
    });

    res.json({
      site: {
        id_site: id,
        nom: site.nom,
        ville: site.ville,
        dernier_push: site.dernier_push,
        supervision_par_agent: Boolean(site.supervision_par_agent),
      },
      parc: {
        total: Number(parc.total || 0),
        en_ligne: Number(parc.en_ligne || 0),
        hors_ligne: Number(parc.hors_ligne || 0),
        inconnu: Number(parc.inconnu || 0),
      },
      types: types.map((t) => ({ libelle: t.libelle, nombre: Number(t.nombre) })),
      alertes: {
        actives: Number(alertes?.actives || 0),
        critiques: Number(alertes?.critiques || 0),
      },
      preuves,
      consommateurs: consommateurs.map((c) => ({
        id_equipement: c.id_equipement,
        nom: c.nom,
        adresse_ip: c.adresse_ip,
        kbps: c.kbps === null ? null : Number(c.kbps),
      })),
      plages: plages.map((p) => ({ cidr: p.cidr, actif: Boolean(p.actif) })),
      historique: historique.map((h) => ({
        instant: h.instant,
        repondants: Number(h.repondants || 0),
        /* `null` et non 0 quand rien n'a été mesuré : une courbe qui
           retombe à zéro se lit comme une panne. */
        latence: h.latence === null ? null : Math.round(Number(h.latence) * 10) / 10,
        debit: h.debit === null ? null : Math.round(Number(h.debit)),
      })),
      charge: {
        cpu: charge?.cpu === null || charge?.cpu === undefined
          ? null
          : Math.round(Number(charge.cpu)),
        ram: charge?.ram === null || charge?.ram === undefined
          ? null
          : Math.round(Number(charge.ram)),
        machines: Number(charge?.machines || 0),
      },
      problemes: problemes.map((p) => ({
        id_alerte: p.id_alerte,
        machine: p.machine,
        type: p.type_alerte,
        niveau: p.niveau,
        message: p.message,
        depuis: p.date_creation,
        occurrences: Number(p.occurrences || 1),
      })),
      dernier_scan: dernierScan,
    });
  } catch (err) {
    console.error("Vue du site impossible:", err.message);
    res.status(500).json({ error: "Lecture de la vue du site impossible" });
  }
});

/**
 * GET /api/sites/:id/machines-par-preuve?preuve=ping
 *
 * ═══════════════════════════════════════════════════════════════════════
 * UN CHIFFRE QU'ON PEUT OUVRIR
 *
 * « 47 machines vues par ping » est une affirmation. Tant qu'on ne peut
 * pas l'ouvrir, c'est une affirmation qu'il faut croire sur parole — et
 * c'est exactement ce que cette plateforme refuse de demander.
 *
 * Chaque preuve devient donc une porte : on clique, on voit les machines
 * concernées, avec le DÉTAIL de ce qui a été constaté sur chacune et la
 * DATE. Une preuve qu'on peut aller vérifier n'est plus une promesse.
 *
 * ── LA PREUVE VIENT DE L'URL, LE FILTRE VIENT DE LA BASE ──
 *
 * `preuve` est passée en paramètre lié, jamais concaténée. Et `inconnue`
 * est traduite en `IS NULL` : c'est une absence, pas une valeur stockée.
 */
router.get("/sites/:id/machines-par-preuve", async (req, res) => {
  const [lignes] = await db.query("SELECT id_site FROM SITE WHERE id_site = ?", [
    req.params.id,
  ]);
  if (lignes.length === 0 || !siteAutorise(req, lignes[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  const preuve = String(req.query.preuve || "").trim();
  if (!preuve) return res.status(400).json({ error: "Preuve manquante" });

  try {
    const sansPreuve = preuve === "inconnue";
    const [machines] = await db.query(
      `SELECT e.id_equipement, e.adresse_ip, e.statut,
              COALESCE(e.nom_personnalise, e.nom) AS nom,
              e.preuve_detail, e.date_preuve,
              COALESCE(t.libelle, 'indéterminé') AS type
         FROM EQUIPEMENT e
         LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
        WHERE e.id_site = ?
          AND ${sansPreuve ? "e.preuve_existence IS NULL" : "e.preuve_existence = ?"}
        ORDER BY INET_ATON(e.adresse_ip)
        LIMIT 200`,
      sansPreuve ? [req.params.id] : [req.params.id, preuve]
    );

    res.json({
      preuve,
      machines: machines.map((m) => ({
        id_equipement: m.id_equipement,
        nom: m.nom,
        adresse_ip: m.adresse_ip,
        statut: m.statut,
        type: m.type,
        detail: m.preuve_detail,
        date_preuve: m.date_preuve,
      })),
    });
  } catch (err) {
    if (/Unknown column|doesn't exist/i.test(err.message)) {
      return res.status(503).json({
        error: "Les preuves ne sont pas enregistrées sur cette base",
        aide: "Appliquez backend/migrations/2026-09-09-preuve-existence.sql.",
      });
    }
    console.error("Lecture des machines par preuve impossible:", err.message);
    res.status(500).json({ error: "Lecture impossible" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   SUPPRIMER UN SITE

   ── LE GESTE LE PLUS DESTRUCTEUR DE LA PLATEFORME ──

   Les clés étrangères sont en CASCADE : effacer un site efface ses
   équipements, et avec eux tout l'historique de relevés, les alertes,
   les incidents, les plages, la politique d'accès web. Des mois de
   mesures, en une requête, sans retour possible.

   LA SUPPRESSION EST DIRECTE : un clic, et c'est fait. Rien à recopier,
   aucun écran intermédiaire.

   DEUX REFUS SUBSISTENT, ET CE N'EST PAS DE LA FRICTION. Ils ne
   protègent pas du clic maladroit — ils empêchent la suppression de
   laisser la plateforme dans un état FAUX :

     1. LE DERNIER SITE. Sans aucun site, plus rien ne peut être
        supervisé ni scanné. Ce n'est pas une suppression, c'est une
        mise hors service.

     2. LES COMPTES RATTACHÉS. La clé étrangère de UTILISATEUR est en
        SET NULL, pas en CASCADE — et c'est un piège : un compte dont
        `id_site` passe à NULL devient GLOBAL, donc voit TOUS les sites.
        Supprimer un site promouvrait silencieusement ses utilisateurs.
        Un clic délibéré ne rend pas cette conséquence acceptable : on
        arrête net et on nomme les comptes.

   LE BILAN EST RENDU APRÈS COUP, en chiffres — ce qui a réellement
   disparu. Il ne sert plus à demander l'autorisation, il sert à ce
   qu'on sache ce qu'on vient de faire.

   ── POURQUOI PAS UNE CORBEILLE ──

   Parce qu'elle mentirait. Les cascades ont déjà effacé les relevés
   quand la ligne du site disparaît : restaurer le site ne rendrait
   qu'une coquille vide, sans son historique. Mieux vaut un refus clair
   qu'une annulation qui ne rend pas ce qu'elle promet.
   ═══════════════════════════════════════════════════════════════════════ */

/** Ce qu'une suppression emporterait, en chiffres. */
async function inventaireSuppression(idSite) {
  const compter = async (sql, params = [idSite]) => {
    try {
      const [[ligne]] = await db.query(sql, params);
      return Number(ligne?.n || 0);
    } catch (err) {
      // Table d'une migration non passée : ce n'est pas zéro, c'est
      // « inconnu ». On rend null, et l'écran ne l'affiche pas.
      if (/doesn't exist|Unknown column/i.test(err.message)) return null;
      throw err;
    }
  };

  const equipements = await compter(
    "SELECT COUNT(*) AS n FROM EQUIPEMENT WHERE id_site = ?"
  );

  return {
    equipements,
    releves: await compter(
      `SELECT COUNT(*) AS n FROM RELEVE r
         JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
        WHERE e.id_site = ?`
    ),
    alertes: await compter(
      `SELECT COUNT(*) AS n FROM ALERTE a
         LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
        WHERE a.id_site = ? OR e.id_site = ?`,
      [idSite, idSite]
    ),
    plages: await compter("SELECT COUNT(*) AS n FROM PLAGE_SCAN WHERE id_site = ?"),
    politiques: await compter("SELECT COUNT(*) AS n FROM POLITIQUE_WEB WHERE id_site = ?"),
  };
}

/** Les comptes rattachés à ce site — ceux qui empêchent la suppression. */
async function comptesRattaches(idSite) {
  const [lignes] = await db.query(
    "SELECT id_utilisateur, nom, email, role FROM UTILISATEUR WHERE id_site = ?",
    [idSite]
  );
  return lignes;
}

/**
 * DELETE /api/sites/:id
 *
 * UN CLIC, ET C'EST FAIT. Pas de nom à recopier, pas d'écran
 * intermédiaire : c'est le choix de l'exploitante, et il lui appartient.
 *
 * LES DEUX REFUS QUI RESTENT NE SONT PAS DE LA FRICTION. Ils ne
 * protègent pas de l'étourderie — ils empêchent la suppression de
 * produire un état FAUX : une plateforme sans aucun site, ou des
 * comptes devenus globaux sans que personne l'ait demandé. Un clic
 * délibéré ne rend pas ces deux conséquences acceptables.
 */
router.delete("/sites/:id", requireRole("admin"), async (req, res) => {
  const [lignes] = await db.query(
    "SELECT id_site, nom, ville FROM SITE WHERE id_site = ?",
    [req.params.id]
  );
  const site = lignes[0];
  if (!site || !siteAutorise(req, site.id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  /* ── BARRIÈRE 1 : LE DERNIER SITE ──
     Une plateforme sans aucun site n'affiche plus rien et ne sait plus
     où ranger un scan. Ce n'est pas une suppression, c'est une mise
     hors service. */
  const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM SITE");
  if (Number(total) <= 1) {
    return res.status(409).json({
      error: "C'est le dernier site de la plateforme",
      aide:
        "Sans aucun site, plus rien ne peut être supervisé ni scanné. " +
        "Créez le site qui le remplace avant de supprimer celui-ci.",
    });
  }

  /* ── BARRIÈRE 2 : LES COMPTES RATTACHÉS ──
     `UTILISATEUR.id_site` est en ON DELETE SET NULL. Un compte dont le
     site disparaît deviendrait donc GLOBAL, et verrait tous les autres
     sites. Une suppression ne doit jamais élargir les droits de
     quelqu'un — surtout pas en silence. */
  const comptes = await comptesRattaches(site.id_site);
  if (comptes.length > 0) {
    return res.status(409).json({
      error: `${comptes.length} compte(s) sont rattachés à ce site`,
      aide:
        "Leur suppression les rendrait globaux — ils verraient alors tous " +
        "les sites. Rattachez-les ailleurs, ou supprimez-les, depuis la " +
        "page Utilisateurs.",
      comptes: comptes.map((c) => ({ nom: c.nom, email: c.email, role: c.role })),
    });
  }

  /* L'inventaire est relevé AVANT la suppression : après, il n'y a plus
     rien à compter, et le journal doit pouvoir dire ce qui a disparu. */
  const perdu = await inventaireSuppression(site.id_site);

  await db.query("DELETE FROM SITE WHERE id_site = ?", [site.id_site]);

  await tracer(
    req,
    "site_supprime",
    `Site « ${site.nom} » (${site.ville}) supprimé — ` +
      `${perdu.equipements ?? "?"} équipement(s), ` +
      `${perdu.releves ?? "?"} relevé(s), ` +
      `${perdu.alertes ?? "?"} alerte(s) effacés avec lui`
  );

  res.json({ supprime: true, site: { nom: site.nom, ville: site.ville }, perdu });
});

/**
 * Construit les commandes d'installation prêtes à coller.
 *
 * Le jeton y est déjà inséré : l'administrateur n'a rien à recopier à la
 * main, ce qui est la première source d'erreur lors d'une mise en service.
 */
function commandesInstallation(site, urlCentrale) {
  const base = {
    CENTRAL_API_URL: urlCentrale,
    AGENT_TOKEN: site.agent_token,
    ID_SITE: site.id_site,
    CIDR: site.cidr_suggere || "192.168.1.0/24",
  };

  const linux =
    `sudo bash installer.sh \\\n` +
    `  --url "${base.CENTRAL_API_URL}" \\\n` +
    `  --token "${base.AGENT_TOKEN}" \\\n` +
    `  --site ${base.ID_SITE} \\\n` +
    `  --cidr "${base.CIDR}"`;

  const windows =
    `.\\installer.ps1 ` +
    `-Url "${base.CENTRAL_API_URL}" ` +
    `-Token "${base.AGENT_TOKEN}" ` +
    `-Site ${base.ID_SITE} ` +
    `-Cidr "${base.CIDR}"`;

  const envManuel =
    `CENTRAL_API_URL=${base.CENTRAL_API_URL}\n` +
    `AGENT_TOKEN=${base.AGENT_TOKEN}\n` +
    `ID_SITE=${base.ID_SITE}\n` +
    `CIDR=${base.CIDR}\n` +
    `SCAN_INTERVAL_MINUTES=5\n` +
    `SNMP_COMMUNITY=public\n`;

  return { linux, windows, envManuel };
}

/**
 * GET /api/sites/:id/agent
 *
 * Tout ce qu'il faut pour mettre un site en service : le jeton, l'état de
 * la remontée, et les commandes d'installation prêtes à coller.
 *
 * Réservé aux administrateurs — c'est la seule route qui expose le jeton.
 */
router.get("/sites/:id/agent", requireRole("admin"), async (req, res) => {
  const [rows] = await db.query(
    "SELECT id_site, nom, ville, agent_token, dernier_push FROM SITE WHERE id_site = ?",
    [req.params.id]
  );
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }
  const site = rows[0];

  /* L'interrupteur d'observation est lu à PART, et c'est délibéré.

     Le joindre à la requête ci-dessus aurait été plus court d'une ligne
     et aurait cassé tout l'écran de mise en service sur une base où la
     migration du 14 septembre n'est pas passée : « Unknown column »
     remonte en erreur 500, et l'administrateur perd l'accès au jeton de
     son agent pour une fonction qu'il n'utilise même pas.

     Une nouveauté ne doit jamais pouvoir empêcher ce qui marchait déjà. */
  let observationDns = false;
  try {
    const [obs] = await db.query(
      "SELECT observation_dns FROM SITE WHERE id_site = ?",
      [site.id_site]
    );
    observationDns = Boolean(obs[0] && obs[0].observation_dns);
  } catch (err) {
    if (!/Unknown column|doesn't exist/i.test(err.message)) throw err;
  }

  // Plage déjà déclarée pour ce site : évite à l'administrateur de la
  // ressaisir, et rend la commande directement exécutable.
  const [plages] = await db.query(
    "SELECT cidr FROM PLAGE_SCAN WHERE id_site = ? AND actif = TRUE ORDER BY id_plage LIMIT 1",
    [site.id_site]
  );
  if (plages.length > 0) site.cidr_suggere = plages[0].cidr;

  // L'URL publique de la plateforme n'est pas devinable côté serveur : on
  // part de l'en-tête de la requête, en refusant une adresse de bouclage
  // qu'aucun poste ne pourrait joindre. Voir adresseJoignable().
  const adresse = adresseJoignable(req);
  const urlCentrale = adresse.url;

  // Nombre d'équipements déjà remontés : la preuve que ça marche.
  const [[{ nb }]] = await db.query(
    "SELECT COUNT(*) AS nb FROM EQUIPEMENT WHERE id_site = ?",
    [site.id_site]
  );

  res.json({
    id_site: site.id_site,
    nom: site.nom,
    ville: site.ville,
    agent_token: site.agent_token,
    dernier_push: site.dernier_push,
    observation_dns: observationDns,
    agent: etatAgent(site.dernier_push),
    equipements_remontes: nb,
    url_centrale: urlCentrale,
    // L'écran doit pouvoir DIRE que l'adresse a été corrigée : une
    // substitution silencieuse serait une deuxième surprise, au lieu
    // d'une première évitée.
    url_corrigee: adresse.corrigee,
    avertissement_url: adresse.avertissement,
    cidr_suggere: site.cidr_suggere || null,
    commandes: commandesInstallation(site, urlCentrale),
  });
});

/**
 * GET /api/sites/:id/script-inventaire
 * Le script PowerShell d'inventaire, DEJA REMPLI pour ce site.
 *
 * POURQUOI CETTE ROUTE EXISTE
 *
 * Le script portait ses trois valeurs en dur, a renseigner a la main.
 * Or le jeton se regenere — c'est meme le geste de securite qu'on
 * attend d'un exploitant. Chaque rotation obligeait donc a rouvrir le
 * script, retrouver la bonne ligne, recoller le jeton : une
 * modification de CODE pour une operation d'EXPLOITATION.
 *
 * Sur un parc de plusieurs centaines de postes, cette friction ne
 * ralentit pas la rotation, elle l'empeche : on finit par ne plus
 * jamais changer le jeton, ce qui est le contraire du but.
 *
 * Desormais : regenerer, telecharger, deposer sur le partage. Aucun
 * editeur de texte, aucune ligne a retrouver.
 *
 * RESERVE AUX ADMINISTRATEURS ET TRACE. Ce fichier CONTIENT le jeton :
 * c'est un secret au meme titre que la route /agent, et son
 * telechargement laisse une ligne au journal. Un jeton qui sort doit
 * pouvoir se raconter apres coup.
 */
router.get("/sites/:id/script-inventaire", requireRole("admin"), async (req, res) => {
  const [rows] = await db.query(
    "SELECT id_site, nom, agent_token FROM SITE WHERE id_site = ?",
    [req.params.id]
  );
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }
  const site = rows[0];

  /* C'EST ICI QUE LE PIÈGE SE REFERMAIT.

     Ce fichier part sur le partage du domaine et s'exécute sur tout le
     parc. Une adresse de bouclage écrite dedans, et les cent postes
     appellent chacun eux-mêmes. Voir adresseJoignable(). */
  const adresse = adresseJoignable(req);
  const urlCentrale = adresse.url;

  let modele;
  try {
    modele = await fs.readFile(CHEMIN_SCRIPT_INVENTAIRE, "utf8");
  } catch (err) {
    console.error("Modele de script d'inventaire illisible:", err.message);
    return res.status(500).json({
      error: "Le modele du script est introuvable sur le serveur",
      aide: "Il doit se trouver dans deploiement/inventaire-poste.ps1",
    });
  }

  /* Substitution par ANCRE, jamais par recherche de l'ancienne valeur.
     On remplace la ligne entiere reperee par son nom de variable : le
     modele du depot peut contenir n'importe quoi, y compris une chaine
     vide. Chercher la valeur d'exemple aurait rendu, le jour ou
     quelqu'un modifie le modele, un script d'apparence normale mais
     jamais rempli — l'echec le plus discret possible. */
  const rempli = modele
    .replace(/^\$CENTRAL_API_URL\s*=.*$/m, `$CENTRAL_API_URL = "${urlCentrale}"`)
    .replace(/^\$AGENT_TOKEN\s*=.*$/m, `$AGENT_TOKEN     = "${site.agent_token}"`)
    .replace(/^\$ID_SITE\s*=.*$/m, `$ID_SITE         = ${site.id_site}`);

  // Garde-fou : si la substitution n'a rien fait, on refuse d'envoyer un
  // script vide plutot que de laisser decouvrir la panne sur tout le parc.
  if (!rempli.includes(site.agent_token)) {
    console.error("Substitution du jeton impossible dans le modele de script.");
    return res.status(500).json({
      error: "Le modele du script n'a pas pu etre rempli",
      aide: "Les lignes $CENTRAL_API_URL, $AGENT_TOKEN et $ID_SITE doivent y figurer.",
    });
  }

  await tracer(
    req,
    "script_inventaire_telecharge",
    `Script d'inventaire telecharge pour le site ${site.id_site} « ${site.nom} » ` +
      `— adresse ${urlCentrale}` +
      (adresse.corrigee ? " (corrigee, la plateforme etait ouverte sur localhost)" : "") +
      ". Il contient le jeton de ce site."
  );

  /* L'AVERTISSEMENT VOYAGE DANS LE FICHIER, PAS SEULEMENT À L'ÉCRAN.

     Ce script est téléchargé, puis déposé sur un partage, puis lu par
     quelqu'un d'autre, parfois des jours plus tard. Un message affiché
     au moment du clic n'aura pas survécu au trajet. Écrit en tête du
     fichier, il est encore là quand l'informaticien l'ouvre. */
  const entete = adresse.avertissement
    ? `# ATTENTION — ${adresse.avertissement.replace(/\s+/g, " ")}\r\n` +
      `# Adresse retenue : ${urlCentrale}\r\n`
    : "";

  // Le BOM du modele est CONSERVE : PowerShell 5.1 lit un fichier UTF-8
  // sans BOM comme de l'ANSI, et tous les accents deviennent illisibles.
  // L'avertissement s'insere donc APRES le BOM, jamais avant.
  const sortie = entete
    ? rempli.charCodeAt(0) === 0xfeff
      ? rempli[0] + entete + rempli.slice(1)
      : entete + rempli
    : rempli;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="inventaire-poste-site-${site.id_site}.ps1"`
  );
  res.send(sortie);
});

/**
 * PATCH /api/sites/:id/observation-dns
 * Allume ou éteint l'observation des domaines pour un site.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE ROUTE EST À PART, ET RÉSERVÉE AUX ADMINISTRATEURS
 *
 * Elle ne règle pas un paramètre technique : elle décide que la
 * plateforme se met à observer ce que font les gens. Le résolveur du
 * site commence à journaliser, et chaque poste voit ses usages remonter.
 *
 * Le geste doit donc être VOLONTAIRE, TRAÇABLE et DATÉ :
 *   - réservé aux administrateurs ;
 *   - inscrit au journal d'activité, avec le nom de qui l'a fait ;
 *   - `observation_dns_depuis` retient la date, pour qu'on puisse
 *     toujours répondre à « depuis quand ces données existent-elles ? ».
 *
 * L'agent applique la décision au cycle suivant : il interroge le
 * serveur, écrit ou retire le fichier de journalisation, et redémarre le
 * résolveur. Rien n'est journalisé tant que ce cycle n'a pas eu lieu.
 */
router.patch("/sites/:id/observation-dns", requireRole("admin"), async (req, res) => {
  const actif = req.body?.active === true;

  if (!siteAutorise(req, Number(req.params.id))) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à modifier ce site" });
  }

  try {
    const [rows] = await db.query("SELECT nom FROM SITE WHERE id_site = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "Site introuvable" });

    await db.query(
      `UPDATE SITE
          SET observation_dns = ?,
              observation_dns_depuis = CASE WHEN ? = 1 THEN NOW() ELSE NULL END
        WHERE id_site = ?`,
      [actif ? 1 : 0, actif ? 1 : 0, req.params.id]
    );

    await tracer(
      req,
      actif ? "observation_dns_activee" : "observation_dns_arretee",
      `Observation des domaines ${actif ? "ACTIVÉE" : "arrêtée"} sur le site ` +
        `${req.params.id} « ${rows[0].nom} ». ` +
        (actif
          ? "Le résolveur de ce site va journaliser les requêtes ; l'agent " +
            "n'en transmet que des domaines agrégés, sans horodatage."
          : "Plus aucune requête n'y sera journalisée. Les relevés déjà " +
            "enregistrés restent consultables jusqu'à leur expiration.")
    );

    res.json({
      active: actif,
      message: actif
        ? "Observation activée. Elle prendra effet au prochain cycle de l'agent."
        : "Observation arrêtée. L'agent cessera de journaliser au prochain cycle.",
    });
  } catch (err) {
    if (/Unknown column|doesn't exist/i.test(err.message)) {
      return res.status(503).json({
        error: "L'observation des domaines n'est pas installée sur cette base",
        aide: "node tools\\appliquer-migrations.js",
      });
    }
    console.error("Bascule de l'observation DNS impossible:", err.message);
    res.status(500).json({ error: "Modification impossible" });
  }
});

/**
 * POST /api/sites/:id/regenerer-token
 *
 * Rotation du jeton d'agent. L'ancien cesse immédiatement de fonctionner :
 * l'agent déjà installé sera rejeté jusqu'à sa reconfiguration. C'est le
 * comportement attendu d'une révocation — le message le dit clairement.
 */
router.post("/sites/:id/regenerer-token", requireRole("admin"), async (req, res) => {
  const [rows] = await db.query("SELECT id_site FROM SITE WHERE id_site = ?", [req.params.id]);
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  const nouveau = crypto.randomBytes(24).toString("hex");
  await db.query("UPDATE SITE SET agent_token = ? WHERE id_site = ?", [nouveau, req.params.id]);

  // Révoquer un jeton d'agent coupe la remontée d'un site entier. Sans
  // trace, un site devenu muet ne se distingue pas d'une panne réseau —
  // et personne ne se souvient d'avoir cliqué. Le jeton lui-même n'est
  // évidemment pas journalisé.
  await tracer(
    req,
    "jeton_agent_regenere",
    `Jeton d'agent du site ${req.params.id} régénéré — l'ancien est révoqué`
  );

  res.json({
    agent_token: nouveau,
    avertissement:
      "L'ancien jeton est révoqué. L'agent déjà installé sur ce site sera rejeté " +
      "jusqu'à ce que vous relanciez l'installation avec le nouveau jeton.",
  });
});

/**
 * PATCH /api/sites/:id/supervision
 * body : { supervision_par_agent: true|false }
 *
 * Déclare qui supervise ce site : le cycle central, ou un agent local.
 *
 * POURQUOI CE RÉGLAGE EST EXPLICITE
 *
 * Il était déduit de `dernier_push` — la trace du dernier envoi d'un
 * agent. Conséquence : lancer un agent une seule fois, pour un essai, sur
 * un site LOCAL, l'excluait définitivement de la supervision centrale.
 * Constaté en réel : 135 équipements plus surveillés par personne pendant
 * quatre jours, parce qu'un agent de test avait tourné cinq minutes.
 *
 * Un effet de bord ne doit pas décider d'un mode de fonctionnement.
 */
router.patch("/sites/:id/supervision", requireRole("admin"), async (req, res) => {
  // Whitelist stricte : `Boolean(req.body.x)` accepterait la chaîne
  // « false », qui est vraie en JavaScript — et couperait la supervision
  // d'un site par accident.
  const valeur = req.body?.supervision_par_agent;
  if (valeur !== true && valeur !== false) {
    return res.status(400).json({
      error: "supervision_par_agent doit valoir true ou false",
    });
  }

  const [rows] = await db.query("SELECT id_site FROM SITE WHERE id_site = ?", [req.params.id]);
  if (rows.length === 0 || !siteAutorise(req, rows[0].id_site)) {
    return res.status(404).json({ error: "Site introuvable" });
  }

  try {
    await db.query("UPDATE SITE SET supervision_par_agent = ? WHERE id_site = ?", [
      valeur ? 1 : 0,
      req.params.id,
    ]);
  } catch (err) {
    // Migration 2026-09-08 non passée : on le dit au lieu de renvoyer une
    // erreur serveur qui enverrait chercher ailleurs.
    return res.status(409).json({
      error: "Colonne supervision_par_agent absente",
      aide: "Appliquez backend/migrations/2026-09-08-mode-de-supervision-explicite.sql, puis réessayez.",
      details: err.message,
    });
  }

  // Le troisième endroit annoncé par le commentaire précédent est arrivé :
  // l'écriture du journal vit désormais dans services/journal.js.
  await tracer(
    req,
    "supervision_modifiee",
    `Site ${req.params.id} : supervision ${
      valeur ? "confiée à l'agent local" : "rendue au serveur central"
    }`
  );

  res.json({
    id_site: Number(req.params.id),
    supervision_par_agent: valeur,
    message: valeur
      ? "Le serveur central ne supervisera plus ce site : son agent local s'en charge."
      : "Le serveur central supervise à nouveau ce site.",
  });
});

module.exports = router;
