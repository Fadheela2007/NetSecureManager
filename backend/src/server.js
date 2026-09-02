// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ quiet: true });

// Échec au démarrage plutôt qu'à la première requête d'un utilisateur.
// Le contrôle vit ici, et non dans db.js : un module de connexion qui
// lève à l'import fait tomber tout programme qui l'importe sans jamais
// s'en servir — un outil de mesure réseau, par exemple.
require("./db").verifierConfiguration();

const express = require("express");
const cors = require("cors");
const http = require("http");
const ipLib = require("ip");
const { Server } = require("socket.io");

const scanRoutes = require("./routes/scan");
const authRoutes = require("./routes/auth");
const { requireAuth } = require("./middleware/authMiddleware");
const monitoringService = require("./services/monitoringService");
const { evaluerChargeDepuisPush } = require("./services/monitoringService");
const db = require("./db");
const sitesRoutes = require("./routes/sites");
const rapportsRoutes = require("./routes/rapports");
const configurationRoutes = require("./routes/configuration");
const plagesRoutes = require("./routes/plages");
const utilisateursRoutes = require("./routes/utilisateurs");
const reinitialisationRoutes = require("./routes/reinitialisation");
const {
  router: accesWebRoutes,
  construireConfiguration,
  chargerPolitique: chargerPolitiqueSite,
  schemaAbsent: schemaWebAbsent,
} = require("./routes/accesWeb");

const app = express();

/* ---------------------------------------------------------------------
   CORS — quelles pages web ont le droit d'appeler cette API.

   CE QUI N'ALLAIT PAS. `cors()` sans argument autorise TOUTE origine.
   Concrètement : n'importe quel site visité par un utilisateur connecté
   pouvait faire appeler cette API par son navigateur. La cible n'est pas
   le serveur mais la session de la personne — elle consulte une page
   quelconque, celle-ci interroge la plateforme en son nom.

   CE QUI CHANGE. Seules les origines déclarées sont acceptées.
   `FRONTEND_URL` accepte plusieurs adresses séparées par des virgules,
   ce qu'exige tout déploiement réel : le poste de développement et le
   serveur de production ne portent jamais la même adresse.

   POURQUOI UN REPLI PERMISSIF EN DÉVELOPPEMENT. Sans `FRONTEND_URL`
   défini, on autorise les adresses locales habituelles de Vite. Refuser
   tout par défaut casserait l'installation de quiconque suit le README
   sans avoir lu ce paragraphe — et la première réaction devant une
   interface qui ne charge pas est de désactiver la protection, pas de
   la configurer.
   --------------------------------------------------------------------- */
// 5173 : serveur de développement de Vite. 4173 : « npm run preview »,
// qui sert la version COMPILÉE en local. Le second est indispensable — le
// contrôle « aucun secret ne sort » (T15 du protocole) n'a de sens que sur
// une version compilée : en développement, Vite sert le code source en
// clair, et une recherche dans les réponses y trouve des correspondances
// qui ne sont pas des fuites.
//
// Ces deux adresses ne servent QUE si FRONTEND_URL n'est pas renseigné,
// c'est-à-dire hors mise en service.
const ORIGINES_DEV = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

const originesAutorisees = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (originesAutorisees.length === 0) {
  originesAutorisees.push(...ORIGINES_DEV);
  console.warn(
    "\n⚠  FRONTEND_URL non défini : seules les adresses locales de développement\n" +
      "   sont autorisées à appeler l'API. À renseigner avant toute mise en service.\n"
  );
}

app.use(
  cors({
    origin(origine, rappel) {
      // Origine absente = requête hors navigateur (agent distant, outil
      // en ligne de commande, sonde de supervision). Le contrôle CORS ne
      // les concerne pas : ils s'authentifient par jeton, et les
      // refuser ici couperait les agents des sites distants.
      if (!origine) return rappel(null, true);
      if (originesAutorisees.includes(origine.replace(/\/$/, ""))) {
        return rappel(null, true);
      }
      // ─────────────────────────────────────────────────────────────
      // UN REFUS D'ORIGINE N'EST PAS UNE PANNE.
      //
      // Sans statut, cette erreur ressortait en 500 « Erreur serveur »
      // accompagnée d'une trace d'exécution complète dans le journal.
      // Or une origine inconnue est un événement ORDINAIRE : un robot,
      // un client mal configuré, un test depuis un autre port.
      //
      // Deux dégâts. Le journal d'un serveur exposé se remplit de traces
      // qui noient les vraies erreurs. Et « Erreur serveur » envoie
      // chercher un défaut du produit là où il s'agit d'une ligne de
      // configuration — FRONTEND_URL — qui n'a pas été renseignée.
      // ─────────────────────────────────────────────────────────────
      const refus = new Error(`Origine non autorisée : ${origine}`);
      refus.status = 403;
      refus.aide =
        "Ajoutez cette adresse à FRONTEND_URL dans backend/.env " +
        "(plusieurs adresses se séparent par des virgules), puis redémarrez le serveur.";
      return rappel(refus);
    },
    credentials: true,
  })
);

app.use(express.json());
app.use("/api/auth", authRoutes);

// ⚠ NE RIEN MONTER SUR "/api" AVEC requireAuth ICI.
//
// `app.use("/api", requireAuth, ...)` exécute requireAuth pour TOUTE requête
// commençant par /api — y compris /api/agent/push, qui est déclarée plus bas
// et possède son propre système d'authentification par jeton d'agent.
// Un routeur monté avant elle lui vole donc ses requêtes et renvoie 401 :
// plus aucun agent ne peut transmettre.
//
// Tous les routeurs protégés par JWT sont regroupés APRÈS la route agent.

// Route agent : DOIT être déclarée avant le requireAuth global,
// car elle utilise son propre système d'authentification (agent_token),
// pas le JWT utilisateur.
/**
 * Résout les alertes d'indisponibilité des équipements revus par l'agent.
 * Symétrique de ce que fait checkEquipement() pour les sites locaux.
 */
async function resoudreAlertesDeRetour(idSite, ipsVues) {
  const placeholders = ipsVues.map(() => "?").join(",");
  await db.query(
    `UPDATE ALERTE a
     JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     SET a.statut = 'resolue', a.date_resolution = NOW()
     WHERE a.type_alerte = 'equipement_down'
       AND a.statut = 'active'
       AND e.id_site = ?
       AND e.adresse_ip IN (${placeholders})`,
    [idSite, ...ipsVues]
  );
}

/**
 * Marque hors ligne les équipements du site qui sont dans la plage balayée
 * mais absents du relevé.
 *
 * Le compteur `echecs_consecutifs` est réutilisé tel quel : un équipement
 * n'est déclaré `down` qu'après `seuil_echecs_avant_alerte` relevés
 * consécutifs sans réponse, exactement comme pour un site local. Un balayage
 * qui rate une machine une fois (collision ARP, ICMP perdu) ne déclenche donc
 * rien.
 *
 * @returns {number} nombre d'équipements passés à `down` lors de ce push
 */
async function traiterAbsents(idSite, cidr, ipsVues) {
  let subnet;
  try {
    subnet = ipLib.cidrSubnet(cidr);
  } catch {
    console.error(`Agent push — CIDR invalide « ${cidr} », absents non traités.`);
    return 0;
  }

  const [rows] = await db.query(
    "SELECT valeur FROM CONFIGURATION WHERE cle = 'seuil_echecs_avant_alerte'"
  );
  const seuil = Number(rows[0]?.valeur) || 3;

  const [candidats] = await db.query(
    `SELECT id_equipement, adresse_ip, nom, statut, echecs_consecutifs
     FROM EQUIPEMENT WHERE id_site = ?`,
    [idSite]
  );

  const vues = new Set(ipsVues);
  let passesDown = 0;

  for (const eq of candidats) {
    if (vues.has(eq.adresse_ip)) continue;
    // Hors de la plage balayée : l'agent ne l'a pas regardé, on ne conclut rien.
    if (!subnet.contains(eq.adresse_ip)) continue;

    const echecs = (eq.echecs_consecutifs || 0) + 1;

    if (echecs >= seuil) {
      if (eq.statut !== "down") passesDown++;
      await db.query(
        "UPDATE EQUIPEMENT SET statut = 'down', echecs_consecutifs = ? WHERE id_equipement = ?",
        [echecs, eq.id_equipement]
      );
    } else {
      await db.query(
        "UPDATE EQUIPEMENT SET echecs_consecutifs = ? WHERE id_equipement = ?",
        [echecs, eq.id_equipement]
      );
    }
  }
  return passesDown;
}

/**
 * Enregistre les relevés SNMP transmis par un agent.
 *
 * L'agent envoie des IP ; le serveur les traduit en id_equipement. Une IP
 * inconnue est ignorée sans bruit : elle correspond à un équipement que
 * l'insertion précédente n'a pas pu créer.
 *
 * @returns {Promise<{enregistres:number, evalues:number}>}
 */
async function enregistrerReleves(idSite, releves) {
  if (!Array.isArray(releves) || releves.length === 0) {
    return { enregistres: 0, evalues: 0 };
  }

  const [rows] = await db.query(
    "SELECT id_equipement, id_site, nom, adresse_ip, statut FROM EQUIPEMENT WHERE id_site = ?",
    [idSite]
  );
  const parIp = new Map(rows.map((e) => [e.adresse_ip, e]));

  const pourSeuils = [];
  let enregistres = 0;

  for (const r of releves) {
    const eq = parIp.get(r.adresse_ip);
    if (!eq) continue;

    try {
      await db.query(
        `INSERT INTO RELEVE (id_equipement, latence_ms, cpu_pourcent, ram_pourcent,
                             trafic_entrant_kbps, trafic_sortant_kbps)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          eq.id_equipement,
          r.latence_ms ?? null,
          r.cpu_pourcent ?? null,
          r.ram_pourcent ?? null,
          r.trafic_entrant_kbps ?? null,
          r.trafic_sortant_kbps ?? null,
        ]
      );
      enregistres++;

      // Les seuils de charge doivent s'appliquer aux relevés poussés comme
      // à ceux du cycle local, sinon la fonctionnalité ne marcherait que
      // sur le site hébergeant le backend.
      pourSeuils.push({
        equipement: eq,
        metrics: { cpuPercent: r.cpu_pourcent ?? null, ramPercent: r.ram_pourcent ?? null },
      });
    } catch (err) {
      console.error(`Relevé de ${r.adresse_ip} ignoré:`, err.message);
    }
  }

  const evalues = await evaluerChargeDepuisPush(pourSeuils).catch((e) => {
    console.error("Évaluation des seuils depuis le push impossible:", e.message);
    return 0;
  });

  return { enregistres, evalues };
}

/**
 * Enregistre l'inventaire des interfaces transmis par un agent.
 * Même contrainte que le scan central : la colonne index_snmp et la clé
 * unique (id_equipement, index_snmp) doivent exister. Sinon l'échec est
 * journalisé et le push continue.
 */
async function enregistrerInterfacesAgent(idSite, interfaces) {
  if (!Array.isArray(interfaces) || interfaces.length === 0) return 0;

  const [rows] = await db.query(
    "SELECT id_equipement, adresse_ip FROM EQUIPEMENT WHERE id_site = ?",
    [idSite]
  );
  const parIp = new Map(rows.map((e) => [e.adresse_ip, e.id_equipement]));

  let n = 0;
  for (const i of interfaces) {
    const idEquipement = parIp.get(i.adresse_ip);
    if (!idEquipement || !i.nom) continue;
    try {
      // vitesse_mbps et les débits sont calculés PAR L'AGENT (lui seul
      // connaît l'intervalle exact entre ses deux lectures SNMP). Le
      // serveur ne fait que les ranger.
      //
      // COALESCE sur la mise à jour, et non VALUES() : un cycle où l'agent
      // vient de redémarrer remonte des débits NULL (pas de compteur
      // précédent). Sans COALESCE, ce NULL effacerait la dernière mesure
      // valide et l'écran « Bande passante » se viderait à chaque
      // redémarrage d'agent. date_trafic n'avance donc que sur une vraie
      // mesure, ce qui permet à l'interface de dater ce qu'elle affiche.
      const aUneMesure =
        i.trafic_entrant_kbps !== null && i.trafic_entrant_kbps !== undefined
          ? true
          : i.trafic_sortant_kbps !== null && i.trafic_sortant_kbps !== undefined;

      await db.query(
        `INSERT INTO INTERFACE_RESEAU
           (id_equipement, index_snmp, nom, adresse_mac, etat_admin, etat_operationnel,
            vitesse_mbps, trafic_entrant_kbps, trafic_sortant_kbps, date_trafic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${aUneMesure ? "NOW()" : "NULL"})
         ON DUPLICATE KEY UPDATE
           nom = VALUES(nom), adresse_mac = VALUES(adresse_mac),
           etat_admin = VALUES(etat_admin), etat_operationnel = VALUES(etat_operationnel),
           vitesse_mbps = COALESCE(VALUES(vitesse_mbps), vitesse_mbps),
           trafic_entrant_kbps = COALESCE(VALUES(trafic_entrant_kbps), trafic_entrant_kbps),
           trafic_sortant_kbps = COALESCE(VALUES(trafic_sortant_kbps), trafic_sortant_kbps),
           date_trafic = ${aUneMesure ? "NOW()" : "date_trafic"}`,
        [
          idEquipement,
          i.index_snmp,
          i.nom,
          i.adresse_mac,
          i.etat_admin,
          i.etat_operationnel,
          i.vitesse_mbps ?? null,
          i.trafic_entrant_kbps ?? null,
          i.trafic_sortant_kbps ?? null,
        ]
      );
      n++;
    } catch (err) {
      console.error(`Interface ${i.nom} de ${i.adresse_ip} ignorée:`, err.message);
    }
  }
  return n;
}

/**
 * POST /api/agent/ping
 *
 * Vérification de mise en service, appelée par les scripts d'installation.
 * Ne modifie rien : elle répond simplement « ce jeton est valide pour ce
 * site, et voici la date de la dernière remontée reçue ».
 *
 * Sans elle, l'installateur ne pouvait que lire le journal local de
 * l'agent — ce qui prouve qu'il a essayé, pas que la plateforme a reçu.
 * La distinction compte : c'est exactement là que se situent les erreurs
 * d'URL, de pare-feu et de jeton révoqué.
 *
 * Déclarée AVANT le requireAuth global, comme /api/agent/push : elle
 * s'authentifie par jeton d'agent.
 */
/**
 * Authentifie un agent par son jeton de site.
 * Renvoie la ligne SITE, ou null.
 */
async function authentifierAgent(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;

  const idSite = req.body?.id_site ?? req.query?.id_site;
  if (!idSite) return null;

  const [rows] = await db.query(
    "SELECT id_site, nom, agent_token FROM SITE WHERE id_site = ?",
    [idSite]
  );
  const site = rows[0];
  if (!site || site.agent_token !== header.slice(7)) return null;
  return site;
}

/**
 * GET /api/agent/politique?id_site=2&version=7&ip=192.168.10.5
 *
 * L'agent annonce la version qu'il applique déjà. Si elle correspond, on
 * répond « rien de neuf » en quelques octets.
 *
 * SANS CE MÉCANISME, chaque agent retéléchargerait la liste complète —
 * plusieurs mégaoctets une fois les catégories importées — toutes les
 * cinq minutes, pour chaque site. Sur dix sites en liaison ADSL, c'est
 * la plateforme elle-même qui saturerait les liens qu'elle supervise.
 *
 * Déclarée AVANT le requireAuth global : elle s'authentifie par jeton
 * d'agent, comme /api/agent/push et /api/agent/ping.
 */
app.get("/api/agent/politique", async (req, res) => {
  try {
    const site = await authentifierAgent(req);
    if (!site) return res.status(403).json({ error: "Token d'agent invalide pour ce site" });

    // ── VÉRIFIER LA VERSION AVANT DE COMPILER ──
    //
    // construireConfiguration() charge les 95 000 domaines depuis la base
    // puis les compile : environ une seconde de travail et plusieurs
    // mégaoctets en mémoire. Le faire AVANT de regarder si l'agent en a
    // besoin, c'était payer ce prix à chaque cycle de chaque agent —
    // toutes les cinq minutes, pour finalement répondre « rien de neuf ».
    //
    // Node.js exécute ce calcul sur un seul fil : pendant qu'il tourne,
    // la plateforme entière ne répond plus. Dix sites suffisaient à la
    // rendre poussive en permanence.
    const politique = await chargerPolitiqueSite(site.id_site);

    // ─────────────────────────────────────────────────────────────────
    // UN AGENT QUI N'A RIEN APPLIQUÉ ENVOIE UNE VERSION VIDE.
    //
    // `Number("")` vaut 0, et `Number.isFinite(0)` vaut true. Le test
    // précédent acceptait donc cette chaîne vide comme un numéro de
    // version valable. Si une politique portait le numéro 0, tout agent
    // fraîchement démarré se serait entendu répondre « inchangée » et
    // n'aurait JAMAIS rien installé — en silence, puisque ce cas ne
    // produit aucun message.
    //
    // Les numéros commencent aujourd'hui à 1, donc le cas ne s'est pas
    // encore produit. On ne compte pas là-dessus : la chaîne vide veut
    // dire « je n'ai rien », ce qui n'est pas un numéro.
    // ─────────────────────────────────────────────────────────────────
    const brut = req.query.version;
    const versionAgent =
      typeof brut === "string" && brut.trim() !== "" ? Number(brut) : null;

    if (
      politique &&
      politique.active &&
      versionAgent !== null &&
      Number.isFinite(versionAgent) &&
      versionAgent === politique.version
    ) {
      return res.json({ active: true, version: politique.version, inchangee: true });
    }

    const config = await construireConfiguration(site.id_site, req.query.ip, site.nom);

    if (!config) {
      // Aucune politique, ou politique désactivée. On le dit
      // explicitement : l'agent doit alors RETIRER son blocage, pas
      // conserver l'ancien. Une politique désactivée qui continue de
      // bloquer serait incompréhensible pour l'administrateur.
      return res.json({ active: false, version: 0 });
    }

    res.json({ active: true, ...config });
  } catch (err) {
    if (schemaWebAbsent(err)) {
      // Migration non passée : l'agent ne doit pas s'arrêter pour autant.
      return res.json({ active: false, version: 0, non_installee: true });
    }
    console.error("Erreur agent politique:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * POST /api/agent/politique/etat
 * body : { id_site, version_appliquee, erreur }
 *
 * L'agent confirme ce qu'il a RÉELLEMENT appliqué.
 *
 * Sans ce retour, l'interface afficherait « politique active » dès
 * l'enregistrement, alors que l'agent ne l'a peut-être jamais reçue ou
 * n'a pas pu recharger son résolveur. Annoncer un blocage qui n'a pas
 * lieu est pire que de ne rien annoncer : le client le découvre en
 * constatant qu'un site interdit s'ouvre normalement.
 */
app.post("/api/agent/politique/etat", async (req, res) => {
  try {
    const site = await authentifierAgent(req);
    if (!site) return res.status(403).json({ error: "Token d'agent invalide pour ce site" });

    const { version_appliquee, erreur } = req.body || {};
    await db.query(
      `UPDATE SITE
       SET politique_version_appliquee = ?,
           politique_date_application = NOW(),
           politique_erreur = ?
       WHERE id_site = ?`,
      [Number(version_appliquee) || null, erreur ? String(erreur).slice(0, 255) : null, site.id_site]
    );
    res.json({ enregistre: true });
  } catch (err) {
    if (schemaWebAbsent(err)) return res.json({ enregistre: false, non_installee: true });
    console.error("Erreur état politique:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * POST /api/agent/stats-blocage
 * body : { id_site, jour, compteurs: [{ categorie, nb }] }
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUE L'AGENT A LE DROIT D'ENVOYER, ET RIEN D'AUTRE.
 *
 * L'agent voit passer toutes les requêtes DNS du site : il pourrait
 * remonter qui a demandé quoi et à quelle heure. Il ne le fait pas, et
 * cette route ne saurait pas quoi en faire — il n'y a pas de colonne
 * pour.
 *
 * Un compteur par catégorie et par jour suffit à démontrer que la
 * politique fonctionne. Descendre à l'heure ou au domaine désignerait
 * quelqu'un sur un petit site aussi sûrement qu'un nom.
 * ─────────────────────────────────────────────────────────────────────
 */
app.post("/api/agent/stats-blocage", async (req, res) => {
  try {
    const site = await authentifierAgent(req);
    if (!site) return res.status(403).json({ error: "Token d'agent invalide pour ce site" });

    const { jour, compteurs } = req.body || {};
    if (!Array.isArray(compteurs) || compteurs.length === 0) {
      return res.json({ enregistres: 0 });
    }

    // Date bornée à aujourd'hui : un agent dont l'horloge dérive ne doit
    // pas créer des lignes datées de 2031 qu'aucun écran n'affichera.
    const jourValide = /^\d{4}-\d{2}-\d{2}$/.test(jour) ? jour : null;

    let n = 0;
    for (const c of compteurs.slice(0, 100)) {
      const nb = Number(c.nb);
      if (!Number.isFinite(nb) || nb <= 0) continue;

      const [[cat]] = await db.query(
        "SELECT id_categorie FROM CATEGORIE_WEB WHERE code = ?",
        [c.categorie || ""]
      );

      await db.query(
        `INSERT INTO STAT_BLOCAGE (id_site, jour, id_categorie, nb_requetes)
         VALUES (?, COALESCE(?, CURDATE()), ?, ?)
         ON DUPLICATE KEY UPDATE nb_requetes = nb_requetes + VALUES(nb_requetes)`,
        [site.id_site, jourValide, cat ? cat.id_categorie : null, Math.min(nb, 10_000_000)]
      );
      n++;
    }
    res.json({ enregistres: n });
  } catch (err) {
    if (schemaWebAbsent(err)) return res.json({ enregistres: 0, non_installee: true });
    console.error("Erreur stats blocage:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/agent/ping", async (req, res) => {
  const { id_site } = req.body || {};
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token d'agent manquant" });
  }
  if (!id_site) {
    return res.status(400).json({ error: "id_site est requis" });
  }

  try {
    const [rows] = await db.query(
      "SELECT id_site, nom, ville, agent_token, dernier_push FROM SITE WHERE id_site = ?",
      [id_site]
    );
    const site = rows[0];
    if (!site || site.agent_token !== header.slice(7)) {
      return res.status(403).json({
        error: "Token d'agent invalide pour ce site",
        aide: "Le jeton a peut-être été régénéré depuis l'interface. Relancez l'installation avec le nouveau.",
      });
    }

    const [[{ nb }]] = await db.query(
      "SELECT COUNT(*) AS nb FROM EQUIPEMENT WHERE id_site = ?",
      [id_site]
    );

    res.json({
      ok: true,
      site: site.nom,
      ville: site.ville,
      dernier_push: site.dernier_push,
      equipements_remontes: nb,
    });
  } catch (err) {
    console.error("Erreur agent ping:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * Réception d'un relevé d'agent.
 *
 * QUI DÉCIDE DU STATUT — l'agent, pas le serveur.
 *
 * Le serveur ne peut pas atteindre le réseau du site : il n'a aucun moyen
 * d'observer quoi que ce soit. Seul l'agent sait distinguer « j'ai sondé
 * cette machine et elle n'a pas répondu » de « je n'ai pas regardé ».
 *
 * L'agent transmet donc, en plus des hôtes vivants :
 *   - `cidr`             : la plage qu'il a réellement balayée
 *   - `balayage_complet` : true si le balayage est allé à son terme
 *
 * Le serveur en déduit le statut des équipements ABSENTS du relevé : s'ils
 * sont dans la plage balayée et que le balayage a abouti, c'est une absence
 * constatée, pas une absence d'information. Sans ces deux champs (ancien
 * agent), le serveur se contente de marquer `up` ce qui a été vu et ne
 * conclut RIEN sur le reste — un agent ancien ne peut donc pas provoquer de
 * fausse panne.
 */
app.post("/api/agent/push", async (req, res) => {
  const { id_site, equipements, cidr, balayage_complet, releves, interfaces } = req.body;

  if (!id_site || !Array.isArray(equipements)) {
    return res.status(400).json({ error: "id_site et equipements (tableau) sont requis" });
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token d'agent manquant" });
  }
  const tokenRecu = header.slice(7);

  try {
    const [siteRows] = await db.query("SELECT agent_token FROM SITE WHERE id_site = ?", [id_site]);
    const site = siteRows[0];
    if (!site || site.agent_token !== tokenRecu) {
      return res.status(403).json({ error: "Token d'agent invalide pour ce site" });
    }

    let enregistres = 0;
    const ipsVues = [];
    for (const eq of equipements) {
      // Un équipement mal formé ne doit pas faire échouer tout le lot.
      try {
        await db.query(
          `INSERT INTO EQUIPEMENT (id_site, nom, adresse_ip, adresse_mac, fabricant, sys_descr, os_detecte, statut, echecs_consecutifs, derniere_decouverte)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'up', 0, NOW())
           ON DUPLICATE KEY UPDATE nom=VALUES(nom), adresse_mac=VALUES(adresse_mac),
             fabricant=VALUES(fabricant), sys_descr=VALUES(sys_descr),
             os_detecte=VALUES(os_detecte), statut='up', echecs_consecutifs=0,
             derniere_decouverte=NOW()`,
          [id_site, eq.nom, eq.adresse_ip, eq.adresse_mac, eq.fabricant, eq.sys_descr, eq.os_detecte]
        );
        enregistres++;
        if (eq.adresse_ip) ipsVues.push(eq.adresse_ip);
      } catch (errEq) {
        console.error(`Agent push — équipement ${eq.adresse_ip} ignoré:`, errEq.message);
      }
    }

    // Un équipement qui répond de nouveau annule son alerte d'indisponibilité.
    if (ipsVues.length > 0) {
      await resoudreAlertesDeRetour(id_site, ipsVues).catch((e) =>
        console.error("Résolution des alertes de retour impossible:", e.message)
      );
    }

    // Absents du relevé : seul un balayage complet et délimité autorise à
    // conclure qu'ils sont hors ligne.
    let horsLigne = 0;
    if (balayage_complet === true && cidr) {
      horsLigne = await traiterAbsents(id_site, cidr, ipsVues).catch((e) => {
        console.error("Traitement des absents impossible:", e.message);
        return 0;
      });
    }

    // Relevés SNMP. Champ absent chez un agent non redéployé : rien ne se
    // passe, aucune erreur — même principe que pour `cidr` et
    // `balayage_complet`.
    const bilanReleves = await enregistrerReleves(id_site, releves).catch((e) => {
      console.error("Enregistrement des relevés impossible:", e.message);
      return { enregistres: 0, evalues: 0 };
    });

    const nbInterfaces = await enregistrerInterfacesAgent(id_site, interfaces).catch((e) => {
      console.error("Enregistrement des interfaces impossible:", e.message);
      return 0;
    });

    // Trace du dernier contact de l'agent : c'est elle qui permet à
    // monitoringService.verifierAgents() de détecter un agent devenu muet,
    // et au cycle central de savoir qu'il ne doit pas superviser ce site.
    // Colonne optionnelle selon l'ancienneté du schéma : on n'échoue pas dessus.
    await db
      .query("UPDATE SITE SET dernier_push = NOW() WHERE id_site = ?", [id_site])
      .catch((e) => console.error("Mise à jour dernier_push impossible:", e.message));

    res.json({
      received: enregistres,
      ignores: equipements.length - enregistres,
      hors_ligne: horsLigne,
      statut_deduit: balayage_complet === true && !!cidr,
      releves: bilanReleves.enregistres,
      seuils_evalues: bilanReleves.evalues,
      interfaces: nbInterfaces,
    });
  } catch (err) {
    console.error("Erreur agent push:", err);
    res.status(500).json({ error: "Erreur serveur pendant la réception des données de l'agent" });
  }
});

app.use("/api", requireAuth, plagesRoutes);
app.use("/api", requireAuth, utilisateursRoutes);
app.use("/api", requireAuth, scanRoutes);
app.use("/api", requireAuth, sitesRoutes);
app.use("/api", requireAuth, rapportsRoutes);
app.use("/api", requireAuth, configurationRoutes);
app.use("/api", requireAuth, accesWebRoutes);
app.use("/api", requireAuth, reinitialisationRoutes);

/* ---------------------------------------------------------------------
   ROUTE INEXISTANTE — répondre en JSON, comme partout ailleurs.

   CE QUI N'ALLAIT PAS. Aucun gestionnaire ne couvrait le cas « cette
   route n'existe pas ». Express renvoyait alors sa page HTML par
   défaut, que le frontend ne sait pas lire : `err.response.data.error`
   restait vide, et l'interface affichait son message de repli le plus
   vague — « Enregistrement impossible ».

   Conséquence pratique : une route mal orthographiée, oubliée au
   déploiement, ou présente dans une version du frontend plus récente
   que celle du backend, produisait exactement le même message qu'une
   panne de base de données. Impossible de distinguer les deux sans
   ouvrir les outils du navigateur.

   Ce middleware ne corrige aucun bug par lui-même. Il rend les bugs
   LISIBLES — ce qui, sur une plateforme déployée chez des clients,
   vaut souvent davantage.

   Il est placé APRÈS toutes les routes et AVANT le gestionnaire
   d'erreurs : l'ordre est ce qui le rend fonctionnel.
   --------------------------------------------------------------------- */
app.use("/api", (req, res) => {
  res.status(404).json({
    error: `Route inconnue : ${req.method} ${req.originalUrl}`,
    aide: "Vérifiez que le backend et le frontend sont sur la même version.",
  });
});

// Filet de sécurité : Express 5 transmet automatiquement les rejets de promesse
// des handlers async ici. Sans ce middleware, le client reçoit une page HTML
// d'erreur au lieu d'un JSON exploitable par le frontend.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Les erreurs client (corps JSON malformé, origine refusée…) portent déjà
  // leur propre statut : ne pas les transformer en 500.
  const statut = err.status || err.statusCode || 500;

  // UNE LIGNE POUR CE QUI EST ATTENDU, LA TRACE POUR CE QUI NE L'EST PAS.
  //
  // Imprimer une trace d'exécution complète à chaque requête mal formée
  // rend le journal illisible le jour où une VRAIE erreur s'y produit.
  // Une origine refusée ou un JSON invalide sont des événements normaux
  // sur un serveur exposé : ils méritent une ligne, pas une page.
  if (statut < 500) {
    console.warn(`Requête refusée (${statut}) : ${err.message}`);
  } else {
    console.error("Erreur non gérée:", err);
  }

  if (res.headersSent) return;

  if (statut < 500) {
    return res.status(statut).json({
      error: statut === 403 ? "Origine non autorisée" : "Requête invalide",
      details: err.message,
      // `aide` dit QUOI FAIRE. Sans elle, « origine non autorisée » laisse
      // l'exploitant deviner quel réglage corriger, et où.
      ...(err.aide ? { aide: err.aide } : {}),
    });
  }
  res.status(500).json({ error: "Erreur serveur", details: err.message });
});

// Un crash du process ferait tomber toute la supervision : on journalise.
process.on("unhandledRejection", (raison) => {
  console.error("Rejet de promesse non géré:", raison);
});

const server = http.createServer(app);

/**
 * ─────────────────────────────────────────────────────────────────────
 * SERVEUR TEMPS RÉEL — désactivé par défaut.
 *
 * Il était instancié avec `cors: { origin: "*" }`, c'est-à-dire ouvert à
 * n'importe quelle page web, et AUCUN code ne s'en servait : pas un seul
 * `emit`, pas un seul `on("connection")`. Une surface d'attaque sans
 * contrepartie — le genre de détail qu'un audit d'acheteur relève, et
 * qu'on a du mal à justifier autrement que par un oubli.
 *
 * Il reste prêt à servir : passer WEBSOCKET_ORIGINE dans le .env
 * l'active, restreint à cette origine.
 *
 *   WEBSOCKET_ORIGINE=http://localhost:5173
 *
 * Quand du temps réel sera réellement implémenté (rafraîchissement des
 * alertes sans rechargement, par exemple), il faudra AUSSI authentifier
 * la connexion — socket.io ne le fait pas tout seul, et un jeton passé
 * en paramètre d'URL se retrouve dans les journaux des serveurs
 * intermédiaires. La bonne voie est l'option `auth` du client, lue dans
 * `socket.handshake.auth` côté serveur.
 * ─────────────────────────────────────────────────────────────────────
 */
let io = null;
if (process.env.WEBSOCKET_ORIGINE) {
  io = new Server(server, { cors: { origin: process.env.WEBSOCKET_ORIGINE } });
  app.set("io", io);
  console.log(`Temps réel activé pour l'origine ${process.env.WEBSOCKET_ORIGINE}`);
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`NetSecureManager backend démarré sur le port ${PORT}`);
  monitoringService.start();
});