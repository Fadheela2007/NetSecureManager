/**
 * tools/verifier-tout.js
 * Contrôle général de la plateforme, en une commande.
 *
 *   node tools\verifier-tout.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QU'IL VÉRIFIE, ET CE QU'IL NE PEUT PAS VÉRIFIER
 *
 * Il contrôle tout ce qui se lit depuis cette machine : configuration,
 * base de données, structure, cohérence des données, tests unitaires.
 *
 * Il ne remplace PAS le protocole de test manuel (TESTER-LA-PLATEFORME.md).
 * Aucun programme ne peut vérifier qu'un scan trouve les bonnes machines,
 * qu'une alerte part par e-mail, ou qu'un blocage DNS fonctionne : ces
 * choses-là dépendent du réseau, pas du code.
 *
 * Son rôle est d'éliminer en trente secondes tout ce qui n'a PAS besoin
 * d'être testé à la main — pour que le temps passé sur le protocole
 * manuel soit consacré aux vraies questions.
 * ─────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const resultats = [];
function noter(categorie, libelle, etat, detail) {
  resultats.push({ categorie, libelle, etat, detail });
  const marque = { ok: `${V}✓${F}`, alerte: `${J}!${F}`, ko: `${R}✗${F}`, info: `${G}·${F}` }[etat];
  console.log(`  ${marque} ${libelle}`);
  if (detail) console.log(`      ${G}${detail}${F}`);
}

function titre(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CONTRÔLE GÉNÉRAL DE LA PLATEFORME");
  console.log("═══════════════════════════════════════════════════════");

  // ── 1. CONFIGURATION ───────────────────────────────────────────────
  titre("1. Configuration");

  const manquantes = db.configurationManquante();
  noter("config", "Variables de base de données", manquantes.length === 0 ? "ok" : "ko",
    manquantes.length ? `absentes : ${manquantes.join(", ")}` : null);

  noter("config", "JWT_SECRET défini", process.env.JWT_SECRET ? "ok" : "ko",
    process.env.JWT_SECRET ? null : "sans lui, le serveur refuse de démarrer");

  const smtp = ["SMTP_HOST", "SMTP_USER"].filter((c) => !process.env[c]);
  noter("config", "Envoi d'e-mails configuré", smtp.length === 0 ? "ok" : "alerte",
    smtp.length ? `${smtp.join(", ")} absent — les notifications ne partiront pas` : null);

  // ── 2. BASE DE DONNÉES ─────────────────────────────────────────────
  titre("2. Base de données");

  const [[ctx]] = await db.query("SELECT DATABASE() AS base, VERSION() AS version");
  noter("base", `Connexion à « ${ctx.base} »`, "ok", `MySQL ${ctx.version}`);

  const [tables] = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  );
  const attendues = [
    "SITE", "EQUIPEMENT", "TYPE_EQUIPEMENT", "UTILISATEUR", "ALERTE", "INCIDENT",
    "RELEVE", "INTERFACE_RESEAU", "SERVICE_DETECTE", "CONFIGURATION", "LOG_ACTIVITE",
    "NOTIFICATION", "PLAGE_SCAN", "VULNERABILITE_CONNUE", "OUI_FABRICANT",
    "CATEGORIE_WEB", "DOMAINE_CATEGORIE", "POLITIQUE_WEB", "POLITIQUE_CATEGORIE",
    "POLITIQUE_DOMAINE", "STAT_BLOCAGE",
  ];
  const presentes = new Set(tables.map((t) => t.TABLE_NAME.toUpperCase()));
  const absentes = attendues.filter((t) => !presentes.has(t));
  noter("base", `Tables (${presentes.size} présentes)`, absentes.length === 0 ? "ok" : "ko",
    absentes.length ? `manquantes : ${absentes.join(", ")}` : null);

  // Colonnes critiques — celles dont l'absence casse une fonction entière.
  const critiques = [
    ["SITE", "dernier_push", "LA SUPERVISION ENTIÈRE"],
    ["CONFIGURATION", "description", "l'écran Configuration"],
    ["ALERTE", "occurrences", "le dédoublonnage des alertes"],
    ["INTERFACE_RESEAU", "trafic_entrant_kbps", "la page Bande passante"],
    ["EQUIPEMENT", "type_source", "la traçabilité du typage"],
    ["NOTIFICATION", "destinataire", "l'historique des notifications"],
  ];
  const colonnesKo = [];
  for (const [table, colonne, casse] of critiques) {
    const [r] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, colonne]
    );
    if (Number(r[0].n) === 0) colonnesKo.push(`${table}.${colonne} (casse ${casse})`);
  }
  noter("base", "Colonnes critiques", colonnesKo.length === 0 ? "ok" : "ko",
    colonnesKo.length ? colonnesKo.join(" · ") : null);

  // ── 3. COHÉRENCE DES DONNÉES ───────────────────────────────────────
  titre("3. Cohérence des données");

  const [[{ nbTypes }]] = await db.query("SELECT COUNT(*) AS nbTypes FROM TYPE_EQUIPEMENT");
  noter("donnees", `Référentiel des types (${nbTypes})`, nbTypes >= 9 ? "ok" : "ko",
    nbTypes >= 9 ? null : "sans lui, tout équipement retombe sur « inconnu »");

  const [[{ nbAdmins }]] = await db.query(
    "SELECT COUNT(*) AS nbAdmins FROM UTILISATEUR WHERE role = 'admin'"
  );
  noter("donnees", `Comptes administrateurs (${nbAdmins})`, nbAdmins > 0 ? "ok" : "ko",
    nbAdmins > 0 ? null : "personne ne peut se connecter — node tools\\creer-admin.js");

  const [[{ nbEq }]] = await db.query("SELECT COUNT(*) AS nbEq FROM EQUIPEMENT");
  const [[{ nbSitesLocaux }]] = await db.query(
    "SELECT COUNT(*) AS nbSitesLocaux FROM SITE WHERE dernier_push IS NULL"
  );

  noter("donnees", `Parc (${nbEq} équipements)`, nbEq > 0 ? "ok" : "alerte",
    nbEq > 0 ? null : "aucun équipement — lancez un scan");

  // LE PIÈGE QUI A COÛTÉ UNE JOURNÉE : tous les sites marqués « agent »,
  // donc aucun supervisé par le cycle central, en silence.
  noter("donnees", "Sites supervisés par le cycle central", nbSitesLocaux > 0 ? "ok" : "ko",
    nbSitesLocaux > 0
      ? `${nbSitesLocaux} site(s) local(aux)`
      : "TOUS les sites sont marqués « pris en charge par un agent » : le cycle central ne supervise rien");

  const [[{ nbRecents }]] = await db.query(
    "SELECT COUNT(*) AS nbRecents FROM RELEVE WHERE date_releve >= NOW() - INTERVAL 15 MINUTE"
  );
  noter("donnees", `Relevés des 15 dernières minutes (${nbRecents})`,
    nbRecents > 0 ? "ok" : nbEq === 0 ? "info" : "alerte",
    nbRecents > 0 ? null : "le backend tourne-t-il ? la supervision produit un relevé par minute");

  const [[{ nbOui }]] = await db.query("SELECT COUNT(*) AS nbOui FROM OUI_FABRICANT");
  noter("donnees", `Registre des fabricants (${nbOui} préfixes)`,
    nbOui > 1000 ? "ok" : "alerte",
    nbOui > 1000 ? null : "peu de fabricants seront identifiés — node tools\\importer-oui.js");

  // ── 4. FICHIERS ────────────────────────────────────────────────────
  titre("4. Fichiers du projet");

  const racine = path.join(__dirname, "..");
  const essentiels = ["schema.sql", "src/server.js", "package.json"];
  const fichiersKo = essentiels.filter((f) => !fs.existsSync(path.join(racine, f)));
  noter("fichiers", "Fichiers essentiels", fichiersKo.length === 0 ? "ok" : "ko",
    fichiersKo.join(", ") || null);

  const nbMigrations = fs.existsSync(path.join(racine, "migrations"))
    ? fs.readdirSync(path.join(racine, "migrations")).filter((f) => f.endsWith(".sql")).length
    : 0;
  noter("fichiers", `Migrations disponibles (${nbMigrations})`, nbMigrations > 0 ? "ok" : "alerte");

  // ── 5. TESTS AUTOMATIQUES ──────────────────────────────────────────
  titre("5. Tests automatiques");

  // Fichiers énumérés explicitement (pas de glob "*.test.js" laissé à la
  // charge du shell) : sous PowerShell/cmd.exe, un programme externe reçoit
  // l'astérisk tel quel — c'est Node qui doit l'interpréter, et selon la
  // version installée ce n'est pas garanti. Le reporter est fixé à "tap"
  // explicitement, pour ne pas dépendre du choix par défaut (qui varie
  // selon que la sortie est un terminal ou non).
  const dossierTests = path.join(racine, "tests");
  const fichiersTest = fs.existsSync(dossierTests)
    ? fs.readdirSync(dossierTests).filter((f) => f.endsWith(".test.js"))
    : [];

  if (fichiersTest.length === 0) {
    noter("tests", "Tests unitaires", "ko", "aucun fichier tests/*.test.js trouvé");
  } else {
    try {
      const sortie = execSync(
        `node --test --test-reporter=tap --test-reporter-destination=stdout ${fichiersTest
          .map((f) => `"tests/${f}"`)
          .join(" ")}`,
        { cwd: racine, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }
      );
      const pass = (sortie.match(/^# pass (\d+)/m) || [])[1];
      const fail = (sortie.match(/^# fail (\d+)/m) || [])[1];
      if (pass === undefined || fail === undefined) {
        noter("tests", "Tests unitaires — sortie inattendue", "alerte",
          "le résumé TAP n'a pas été reconnu ; lancez « npm test » pour lire le détail");
      } else {
        noter("tests", `Tests unitaires (${pass} réussis, ${fail} échoués)`,
          Number(fail) === 0 ? "ok" : "ko");
      }
    } catch (err) {
      const sortie = (err.stdout || "") + (err.stderr || "");
      const fail = (sortie.match(/^# fail (\d+)/m) || [])[1] || "?";
      noter("tests", `Tests unitaires — ${fail} échec(s)`, "ko", "lancez : npm test");
    }
  }

  // ── BILAN ──────────────────────────────────────────────────────────
  const ko = resultats.filter((r) => r.etat === "ko");
  const alertes = resultats.filter((r) => r.etat === "alerte");

  console.log("\n═══════════════════════════════════════════════════════");
  if (ko.length === 0 && alertes.length === 0) {
    console.log(`  ${V}Tout est conforme.${F}`);
    console.log("\n  Le contrôle automatique ne couvre pas le réseau :");
    console.log("  reprenez TESTER-LA-PLATEFORME.md pour le scan, les");
    console.log("  notifications et le blocage DNS.\n");
    process.exit(0);
  }

  if (ko.length > 0) {
    console.log(`  ${R}${ko.length} problème(s) bloquant(s) :${F}`);
    for (const r of ko) console.log(`    ✗ ${r.libelle}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  if (alertes.length > 0) {
    console.log(`\n  ${J}${alertes.length} point(s) d'attention :${F}`);
    for (const r of alertes) console.log(`    ! ${r.libelle}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log("");
  process.exit(ko.length > 0 ? 1 : 0);
})().catch((err) => {
  console.error(`\n${R}Contrôle interrompu :${F}`, err.message);
  if (/ECONNREFUSED/.test(err.message)) console.error("MySQL ne répond pas.\n");
  process.exit(2);
});
