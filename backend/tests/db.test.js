/**
 * tests/db.test.js
 *
 * Reproduit la panne observée :
 *
 *   node tools\mesurer-scan.js 192.168.0.0/23
 *   Error: Variables d'environnement manquantes dans backend/.env
 *
 * Un outil qui mesure des durées de ping ne touche jamais la base. Il
 * mourait pourtant à l'import, par une chaîne de dépendances :
 *   mesurer-scan -> discoveryService -> ouiService -> db
 *
 * Le principe « échouer tôt » restait bon ; c'est son emplacement qui ne
 * l'était pas. Un module de connexion qui lève à l'IMPORT fait tomber
 * tout programme qui l'importe sans jamais s'en servir.
 *
 * Ces tests fixent le nouveau contrat pour qu'il ne se reperde pas.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const CHEMIN_DB = require.resolve("../src/db");

/** Recharge db.js avec un environnement vidé de sa configuration. */
function chargerSansConfiguration() {
  const sauvegarde = {};
  for (const cle of ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"]) {
    sauvegarde[cle] = process.env[cle];
    delete process.env[cle];
  }
  delete require.cache[CHEMIN_DB];
  const db = require(CHEMIN_DB);
  return { db, restaurer: () => {
    for (const [cle, valeur] of Object.entries(sauvegarde)) {
      if (valeur === undefined) delete process.env[cle];
      else process.env[cle] = valeur;
    }
    delete require.cache[CHEMIN_DB];
  } };
}

// ─────────────────────────────────────────────────────────────────────
test("importer db.js sans configuration ne lève pas", () => {
  const { restaurer } = chargerSansConfiguration();
  try {
    // Le simple fait d'arriver ici est le test : avant, le require
    // lui-même levait.
    assert.ok(true);
  } finally {
    restaurer();
  }
});

test("configurationManquante() énumère précisément ce qui manque", () => {
  const { db, restaurer } = chargerSansConfiguration();
  try {
    assert.deepStrictEqual(db.configurationManquante(), [
      "DB_HOST",
      "DB_USER",
      "DB_PASS",
      "DB_NAME",
    ]);
  } finally {
    restaurer();
  }
});

test("verifierConfiguration() lève avec un message exploitable", () => {
  const { db, restaurer } = chargerSansConfiguration();
  try {
    assert.throws(() => db.verifierConfiguration(), /backend\/\.env/);
    // Le message doit nommer les variables : « erreur de configuration »
    // tout court obligerait à ouvrir le code pour savoir laquelle.
    assert.throws(() => db.verifierConfiguration(), /DB_HOST/);
  } finally {
    restaurer();
  }
});

test("une requête sans configuration REJETTE, elle ne lève pas", async () => {
  // Le point le plus important du fichier.
  //
  // Plusieurs endroits du code écrivent `db.query(...).catch(...)` pour
  // dégrader proprement quand une migration n'est pas passée. Une
  // exception synchrone traverserait ces .catch() sans être rattrapée et
  // ferait tomber la requête HTTP — précisément là où l'on avait pris
  // soin de prévoir un repli.
  const { db, restaurer } = chargerSansConfiguration();
  try {
    const promesse = db.query("SELECT 1");
    assert.ok(promesse instanceof Promise, "query doit renvoyer une promesse");

    let rattrapee = null;
    await promesse.catch((e) => {
      rattrapee = e;
    });
    assert.ok(rattrapee, ".catch() doit rattraper l'erreur");
    assert.match(rattrapee.message, /DB_HOST/);
  } finally {
    restaurer();
  }
});

test("getConnection sans configuration rejette aussi", async () => {
  const { db, restaurer } = chargerSansConfiguration();
  try {
    await assert.rejects(() => db.getConnection(), /backend\/\.env/);
  } finally {
    restaurer();
  }
});

test("end() sans pool ouvert ne plante pas", async () => {
  // Un outil qui se termine sans avoir jamais interrogé la base ne doit
  // pas échouer sur sa fermeture.
  const { db, restaurer } = chargerSansConfiguration();
  try {
    await assert.doesNotReject(() => db.end());
  } finally {
    restaurer();
  }
});

// ─────────────────────────────────────────────────────────────────────
test("discoveryService se charge sans configuration de base", async () => {
  // Le scénario exact de la panne : la chaîne d'imports de l'outil de
  // mesure ne doit plus dépendre de la base.
  const { restaurer } = chargerSansConfiguration();
  const cheminDecouverte = require.resolve("../src/services/discoveryService");
  const cheminOui = require.resolve("../src/services/ouiService");
  delete require.cache[cheminDecouverte];
  delete require.cache[cheminOui];

  try {
    const decouverte = require(cheminDecouverte);
    assert.strictEqual(typeof decouverte.scanRange, "function");
  } finally {
    delete require.cache[cheminDecouverte];
    delete require.cache[cheminOui];
    restaurer();
  }
});

test("l'outil de mesure charge son .env par chemin absolu", () => {
  // Sans cela, l'outil ne fonctionne que lancé depuis backend/ — et le
  // message d'erreur ne dit pas que c'est le dossier courant le
  // problème.
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "..", "tools", "mesurer-scan.js"), "utf8");

  assert.match(source, /dotenv/, "le .env doit être chargé");
  assert.match(source, /__dirname/, "le chemin doit être absolu, pas relatif au dossier courant");
});
