/**
 * tools/combler-colonnes.js
 * Compare `schema.sql` à la base réelle et comble les colonnes absentes.
 *
 *   node tools\combler-colonnes.js              (rapport seul, ne modifie rien)
 *   node tools\combler-colonnes.js --appliquer  (ajoute les colonnes manquantes)
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL EXISTE
 *
 * `CREATE TABLE IF NOT EXISTS` ne sait pas faire évoluer une table qui
 * existe déjà. Sur une base ancienne, `schema.sql` passe donc sans rien
 * faire, en laissant la structure réelle en retard sur la structure
 * déclarée — silencieusement.
 *
 * Le symptôme arrive plus tard, sous la forme « Unknown column 'X' »,
 * une colonne à la fois. Nous en avons traité trois par aller-retour
 * successifs — `description`, `destinataire`, puis `erreur` — sans
 * jamais savoir combien il en restait.
 *
 * Cet outil règle la question d'un coup : il lit les colonnes DÉCLARÉES
 * dans schema.sql, les compare à celles PRÉSENTES en base, et liste
 * l'écart complet.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QU'IL NE FAIT JAMAIS
 *
 * Il n'ajoute que des colonnes ABSENTES. Il ne modifie aucun type, ne
 * renomme rien, ne supprime rien — pas même une colonne présente en base
 * et absente de schema.sql, qui est signalée mais laissée intacte.
 *
 * C'est la règle du projet : la base réelle fait foi. On la complète,
 * on ne la redresse pas.
 * ─────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

const APPLIQUER = process.argv.includes("--appliquer");
const SCHEMA = path.join(__dirname, "..", "schema.sql");

/**
 * Extrait les colonnes déclarées par chaque CREATE TABLE de schema.sql.
 *
 * On ne garde que les vraies définitions de colonnes : les lignes
 * commençant par KEY, UNIQUE, PRIMARY, CONSTRAINT, INDEX ou FOREIGN
 * décrivent des index et des contraintes, pas des colonnes. Les
 * confondre produirait des ALTER TABLE absurdes.
 */
function colonnesDeclarees(sql) {
  const tables = new Map();

  const blocs = sql.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\)\s*ENGINE/gi
  );

  for (const bloc of blocs) {
    const table = bloc[1];
    const corps = bloc[2];
    const colonnes = [];

    // ── DÉCOUPAGE PAR VIRGULES DE PREMIER NIVEAU ──
    //
    // Une première version découpait ligne par ligne. Elle prenait pour
    // des colonnes les lignes de continuation d'une contrainte :
    //
    //   CONSTRAINT fk_x FOREIGN KEY (id)
    //     REFERENCES AUTRE (id) ON DELETE CASCADE      ← lue comme
    //                                                    colonne
    //                                                    « REFERENCES »
    //
    // et aurait produit `ALTER TABLE X ADD COLUMN REFERENCES ...`.
    //
    // Une définition est en réalité délimitée par une virgule, pas par un
    // saut de ligne — et cette virgule doit être HORS parenthèses, sans
    // quoi on couperait au milieu d'un `ENUM('a','b')` ou d'un
    // `KEY (a, b)`.
    const morceaux = [];
    let courant = "";
    let profondeur = 0;
    let dansChaine = false;

    for (const c of corps.replace(/--[^\n]*/g, "")) {
      if (dansChaine) {
        courant += c;
        if (c === "'") dansChaine = false;
        continue;
      }
      if (c === "'") {
        dansChaine = true;
        courant += c;
        continue;
      }
      if (c === "(") profondeur++;
      if (c === ")") profondeur--;
      if (c === "," && profondeur === 0) {
        morceaux.push(courant);
        courant = "";
        continue;
      }
      courant += c;
    }
    if (courant.trim()) morceaux.push(courant);

    for (const morceau of morceaux) {
      const complet = morceau.replace(/\s+/g, " ").trim();
      if (!complet) continue;
      if (/^(KEY|UNIQUE|PRIMARY|CONSTRAINT|INDEX|FOREIGN|FULLTEXT|CHECK)\b/i.test(complet)) continue;

      const m = complet.match(/^`?(\w+)`?\s+(.+)$/);
      if (!m) continue;
      colonnes.push({ nom: m[1], definition: m[2].trim() });
    }

    tables.set(table.toUpperCase(), colonnes);
  }
  return tables;
}

(async () => {
  const [[ctx]] = await db.query("SELECT DATABASE() AS base");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(APPLIQUER ? "  COMBLEMENT DES COLONNES" : "  ÉCART SCHÉMA / BASE RÉELLE  (lecture seule)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Base : ${ctx.base}\n`);

  const declarees = colonnesDeclarees(fs.readFileSync(SCHEMA, "utf8"));

  const [reelles] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()`
  );

  const parTable = new Map();
  for (const r of reelles) {
    const t = r.TABLE_NAME.toUpperCase();
    if (!parTable.has(t)) parTable.set(t, new Set());
    parTable.get(t).add(r.COLUMN_NAME.toLowerCase());
  }

  const aAjouter = [];
  const tablesAbsentes = [];
  let enTrop = 0;

  for (const [table, colonnes] of declarees) {
    const existantes = parTable.get(table);
    if (!existantes) {
      tablesAbsentes.push(table);
      continue;
    }

    // ── COLONNES QU'ON N'AJOUTE JAMAIS APRÈS COUP ──
    //
    // Une clé primaire auto-incrémentée ne s'ajoute pas à une table qui
    // en a déjà une : MySQL refuse, et si par malheur elle acceptait,
    // elle renumérerait les lignes existantes.
    //
    // En pratique ces colonnes existent toujours — ce sont les `id_*`
    // d'origine. Mais si l'analyse de schema.sql dérivait un jour, le
    // garde-fou évite que l'outil ne propose une opération qui touche
    // aux identifiants de lignes déjà en base.
    const manquantes = colonnes.filter(
      (c) =>
        !existantes.has(c.nom.toLowerCase()) &&
        !/AUTO_INCREMENT|PRIMARY\s+KEY/i.test(c.definition)
    );

    const ecartees = colonnes.filter(
      (c) =>
        !existantes.has(c.nom.toLowerCase()) &&
        /AUTO_INCREMENT|PRIMARY\s+KEY/i.test(c.definition)
    );
    for (const c of ecartees) {
      console.log(
        `  \x1b[31m${table}.${c.nom}\x1b[0m — clé primaire absente, NON ajoutée automatiquement.`
      );
      console.log("      Cette table a probablement une structure très ancienne.");
      console.log("      À traiter à la main, avec sauvegarde préalable.");
    }
    if (manquantes.length > 0) {
      console.log(`  \x1b[33m${table}\x1b[0m — ${manquantes.length} colonne(s) manquante(s)`);
      for (const c of manquantes) {
        console.log(`      ${c.nom}  ${c.definition.slice(0, 60)}`);
        aAjouter.push({ table, ...c });
      }
    }

    // Informatif : colonnes en base mais pas dans schema.sql. On n'y
    // touche pas — la base fait foi — mais un écart peut signaler un
    // schema.sql en retard sur la réalité.
    const declareesNoms = new Set(colonnes.map((c) => c.nom.toLowerCase()));
    for (const nom of existantes) {
      if (!declareesNoms.has(nom)) enTrop++;
    }
  }

  if (tablesAbsentes.length > 0) {
    console.log(`\n  \x1b[31mTables absentes de la base : ${tablesAbsentes.join(", ")}\x1b[0m`);
    console.log("  Exécutez d'abord : node tools\\appliquer-migrations.js\n");
  }

  if (aAjouter.length === 0) {
    console.log("  \x1b[32m✓ Aucune colonne manquante.\x1b[0m");
    console.log(`    (${enTrop} colonne(s) présente(s) en base mais absente(s) de schema.sql —`);
    console.log("     informatif, rien n'est modifié : la base fait foi.)\n");
    process.exit(0);
  }

  console.log(`\n  ${aAjouter.length} colonne(s) à ajouter.`);

  if (!APPLIQUER) {
    console.log("\n  Instructions correspondantes :\n");
    for (const c of aAjouter) {
      console.log(`    ALTER TABLE ${c.table} ADD COLUMN ${c.nom} ${c.definition};`);
    }
    console.log("\n  Pour les appliquer :  node tools\\combler-colonnes.js --appliquer\n");
    process.exit(0);
  }

  console.log("");
  let ok = 0;
  const echecs = [];

  for (const c of aAjouter) {
    const sql = `ALTER TABLE ${c.table} ADD COLUMN ${c.nom} ${c.definition}`;
    try {
      await db.query(sql);
      console.log(`  \x1b[32m✓\x1b[0m ${c.table}.${c.nom}`);
      ok++;
    } catch (err) {
      if (err.errno === 1060) {
        console.log(`  \x1b[90m·\x1b[0m ${c.table}.${c.nom} — déjà présente`);
        continue;
      }
      console.log(`  \x1b[31m✗\x1b[0m ${c.table}.${c.nom} — ${err.errno} ${err.message.slice(0, 80)}`);
      echecs.push({ ...c, erreur: err.message });
    }
  }

  console.log(`\n  ${ok} colonne(s) ajoutée(s).`);
  if (echecs.length > 0) {
    console.log(`  \x1b[31m${echecs.length} échec(s) — à me transmettre.\x1b[0m\n`);
    process.exit(1);
  }
  console.log("\n  Relancez ensuite :  node tools\\appliquer-migrations.js\n");
  process.exit(0);
})().catch((err) => {
  console.error("\nContrôle impossible :", err.message);
  process.exit(2);
});
