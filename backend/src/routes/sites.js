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
  const [result] = await db.query(
    "INSERT INTO SITE (nom, ville, agent_token) VALUES (?, ?, ?)",
    [nom, ville, agent_token]
  );
  await tracer(req, "site_cree", `Site « ${nom} » (${ville}) créé`);

  res.json({ id_site: result.insertId, nom, ville, agent_token });
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
