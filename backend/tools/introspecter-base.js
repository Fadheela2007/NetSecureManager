/**
 * tools/introspecter-base.js
 *
 * Script d'INTROSPECTION (lecture seule) — ne modifie jamais la base.
 *
 * Exécute SHOW CREATE TABLE sur les 14 tables et écrit le résultat brut dans
 * un fichier. C'est LA source de vérité : le schéma réel de votre base, tel
 * que MySQL le décrit lui-même.
 *
 * Usage, depuis le dossier backend :
 *
 *     node tools/introspecter-base.js
 *
 * Produit backend/tools/schema-reel.sql. Transmettez-moi ce fichier et je
 * régénère schema.sql à l'identique, sans aucune interprétation.
 *
 * Options :
 *     node tools/introspecter-base.js --console   (affiche au lieu d'écrire)
 */

// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ quiet: true });
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

const TABLES = [
  "SITE",
  "TYPE_EQUIPEMENT",
  "UTILISATEUR",
  "EQUIPEMENT",
  "INTERFACE_RESEAU",
  "SERVICE_DETECTE",
  "RELEVE",
  "ALERTE",
  "INCIDENT",
  "LOG_ACTIVITE",
  "VULNERABILITE_CONNUE",
  "CONFIGURATION",
  "PLAGE_SCAN",
  "NOTIFICATION",
];

async function main() {
  const absentes = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"].filter((c) => !process.env[c]);
  if (absentes.length) {
    console.error(`Variables absentes de backend/.env : ${absentes.join(", ")}`);
    process.exit(1);
  }

  let cx;
  try {
    cx = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectTimeout: 8000,
    });
  } catch (err) {
    console.error(`Connexion MySQL impossible (${err.code || err.message}).`);
    process.exit(1);
  }

  const lignes = [];
  const ecrire = (s) => lignes.push(s);

  ecrire(`-- Schéma RÉEL de la base ${process.env.DB_NAME}`);
  ecrire(`-- Généré le ${new Date().toISOString()} par tools/introspecter-base.js`);
  ecrire(`-- Source de vérité : sortie brute de SHOW CREATE TABLE.`);
  ecrire("");

  const [rows] = await cx.query("SHOW TABLES");
  const cle = Object.keys(rows[0] || {})[0];
  const presentes = new Set(rows.map((r) => String(r[cle]).toUpperCase()));

  ecrire(`-- Tables présentes en base (${presentes.size}) : ${[...presentes].sort().join(", ")}`);
  ecrire("");

  for (const table of TABLES) {
    if (!presentes.has(table)) {
      ecrire(`-- ============ ${table} : TABLE ABSENTE DE LA BASE ============`);
      ecrire("");
      continue;
    }

    ecrire(`-- ============================== ${table} ==============================`);
    const [res] = await cx.query(`SHOW CREATE TABLE \`${table}\``);
    ecrire(res[0]["Create Table"] + ";");
    ecrire("");

    // Détail des colonnes : type exact, nullabilité, défaut, valeurs d'ENUM
    const [cols] = await cx.query(`SHOW FULL COLUMNS FROM \`${table}\``);
    ecrire(`-- Colonnes de ${table} :`);
    for (const c of cols) {
      ecrire(
        `--   ${c.Field.padEnd(26)} ${String(c.Type).padEnd(46)} ` +
          `null=${c.Null} defaut=${c.Default === null ? "NULL" : c.Default} ${c.Extra || ""}`
      );
    }
    ecrire("");
  }

  // Contenu des tables de référence : ce sont des données, pas de la structure,
  // mais elles conditionnent le comportement de l'application.
  for (const table of ["CONFIGURATION", "TYPE_EQUIPEMENT"]) {
    if (!presentes.has(table)) continue;
    const [data] = await cx.query(`SELECT * FROM \`${table}\``);
    ecrire(`-- ---------- Contenu actuel de ${table} (${data.length} ligne(s)) ----------`);
    for (const d of data) {
      ecrire(`--   ${JSON.stringify(d)}`);
    }
    ecrire("");
  }

  const sortie = lignes.join("\n");

  if (process.argv.includes("--console")) {
    console.log(sortie);
  } else {
    const dest = path.join(__dirname, "schema-reel.sql");
    fs.writeFileSync(dest, sortie, "utf8");
    console.log(`Schéma réel écrit dans : ${dest}`);
    console.log(`${TABLES.filter((t) => presentes.has(t)).length}/${TABLES.length} tables introspectées.`);
    const manquantes = TABLES.filter((t) => !presentes.has(t));
    if (manquantes.length) {
      console.log(`Tables absentes de la base : ${manquantes.join(", ")}`);
    }
  }

  await cx.end();
}

main().catch((err) => {
  console.error("Erreur :", err);
  process.exit(1);
});
