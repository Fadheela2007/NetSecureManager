/**
 * tools/importer-oui.js
 * Alimente la table OUI_FABRICANT à partir du registre IEEE.
 *
 * Trois sources, par ordre de préférence selon votre situation :
 *
 *   node tools/importer-oui.js
 *       Depuis la graine embarquée data/oui-ieee.json.gz.
 *       AUCUN accès Internet requis — c'est le cas d'usage principal sur
 *       un réseau d'entreprise isolé.
 *
 *   node tools/importer-oui.js --fichier /chemin/oui.csv
 *       Depuis un fichier téléchargé ailleurs puis recopié sur le serveur.
 *       Accepte le CSV officiel de l'IEEE ou un JSON { "A434D9": "Intel" }.
 *
 *   node tools/importer-oui.js --telecharger
 *       Directement depuis standards-oui.ieee.org, si le serveur a Internet.
 *
 * L'import est idempotent (INSERT ... ON DUPLICATE KEY UPDATE) : le relancer
 * met à jour les libellés modifiés et ajoute les nouvelles attributions,
 * sans jamais supprimer ce qui existe.
 */

// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");
const db = require("../src/db");

const URL_IEEE = "https://standards-oui.ieee.org/oui/oui.csv";
const CHEMIN_GRAINE = path.join(__dirname, "..", "data", "oui-ieee.json.gz");
const TAILLE_LOT = 1000;

/** Retire les suffixes juridiques pour un affichage lisible. */
function nettoyerNom(nom) {
  return String(nom)
    .split("\n")[0]
    .trim()
    .replace(
      /,?\s*(Inc\.?|Corp\.?|Corporation|Co\.?,? ?Ltd\.?|Ltd\.?|LLC|GmbH|S\.A\.|B\.V\.|A\/S|AB|Pty|PLC|N\.V\.|SAS|S\.p\.A\.)\.?\s*$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normaliserOui(brut) {
  const hex = String(brut).replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length >= 6 ? hex.slice(0, 6) : null;
}

/** Analyse le CSV de l'IEEE : Registry,Assignment,Organization Name,Address */
function analyserCsv(texte) {
  const entrees = new Map();
  for (const ligne of texte.split(/\r?\n/)) {
    if (!ligne || /^Registry/i.test(ligne)) continue;
    // Le nom d'organisation peut contenir des virgules et être entre guillemets.
    const champs = ligne.match(/(".*?"|[^,]+)/g);
    if (!champs || champs.length < 3) continue;
    const oui = normaliserOui(champs[1]);
    if (!oui) continue;
    const nom = nettoyerNom(champs[2].replace(/^"|"$/g, ""));
    if (nom) entrees.set(oui, nom);
  }
  return entrees;
}

/**
 * BUG CORRIGÉ : cette fonction chargeait les clés/valeurs de la graine
 * telles quelles, sans passer par normaliserOui()/nettoyerNom() comme les
 * deux autres sources. Le registre IEEE contient, en plus des blocs
 * classiques à 24 bits (6 caractères hex), des attributions étendues
 * MA-M (28 bits) et MA-S/CID (36 bits) — jusqu'à 9 caractères. Ces clés
 * plus longues passaient telles quelles, et provoquaient
 * « Data too long for column 'oui' » (CHAR(6)) au 727ᵉ lot inséré.
 * On retombe sur le préfixe à 6 caractères commun aux trois formats —
 * suffisant pour l'identification par MAC, qui ne regarde que l'OUI-24.
 */
function lireGraine() {
  const brut = zlib.gunzipSync(fs.readFileSync(CHEMIN_GRAINE));
  return normaliserEntrees(JSON.parse(brut.toString("utf8")));
}

/**
 * Le registre IEEE contient, en plus des blocs classiques à 24 bits
 * (6 caractères hex), des attributions étendues MA-M (28 bits) et
 * MA-S/CID (36 bits) — jusqu'à 9 caractères. Sans cette normalisation,
 * ces clés plus longues passaient telles quelles et provoquaient
 * « Data too long for column 'oui' » (CHAR(6)) en cours d'import.
 * On retombe sur le préfixe à 6 caractères commun aux trois formats —
 * suffisant pour l'identification par MAC, qui ne regarde que l'OUI-24.
 */
function normaliserEntrees(obj) {
  const entrees = new Map();
  for (const [cle, valeur] of Object.entries(obj)) {
    const oui = normaliserOui(cle);
    const nom = nettoyerNom(valeur);
    if (oui && nom) entrees.set(oui, nom);
  }
  return entrees;
}

function lireFichier(chemin) {
  const brut = fs.readFileSync(chemin);
  if (chemin.endsWith(".gz")) {
    return normaliserEntrees(JSON.parse(zlib.gunzipSync(brut).toString("utf8")));
  }
  const texte = brut.toString("utf8");
  if (texte.trimStart().startsWith("{")) {
    return normaliserEntrees(JSON.parse(texte));
  }
  return analyserCsv(texte);
}

function telecharger() {
  return new Promise((resolve, reject) => {
    console.log(`Téléchargement depuis ${URL_IEEE} …`);
    https
      .get(URL_IEEE, { timeout: 120000 }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const morceaux = [];
        res.on("data", (c) => morceaux.push(c));
        res.on("end", () => resolve(analyserCsv(Buffer.concat(morceaux).toString("utf8"))));
      })
      .on("timeout", function () {
        this.destroy(new Error("délai dépassé"));
      })
      .on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const iFichier = args.indexOf("--fichier");

  let entrees;
  let origine;

  try {
    if (args.includes("--telecharger")) {
      entrees = await telecharger();
      origine = "IEEE (téléchargement)";
    } else if (iFichier !== -1 && args[iFichier + 1]) {
      entrees = lireFichier(args[iFichier + 1]);
      origine = `fichier ${args[iFichier + 1]}`;
    } else {
      entrees = lireGraine();
      origine = "graine embarquée";
    }
  } catch (err) {
    console.error(`Lecture de la source impossible : ${err.message}`);
    console.error("Repli possible : node tools/importer-oui.js (graine embarquée, sans réseau)");
    process.exit(1);
  }

  entrees.delete(null);
  console.log(`Source : ${origine} — ${entrees.size} entrée(s).`);
  if (entrees.size === 0) {
    console.error("Aucune entrée exploitable, rien à importer.");
    process.exit(1);
  }

  const lignes = [...entrees.entries()].filter(([o, f]) => o && f);
  let traites = 0;

  for (let i = 0; i < lignes.length; i += TAILLE_LOT) {
    const lot = lignes.slice(i, i + TAILLE_LOT);
    const placeholders = lot.map(() => "(?, ?)").join(",");
    const valeurs = lot.flat();
    await db.query(
      `INSERT INTO OUI_FABRICANT (oui, fabricant) VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE fabricant = VALUES(fabricant), date_maj = NOW()`,
      valeurs
    );
    traites += lot.length;
    if (traites % 10000 === 0 || traites === lignes.length) {
      process.stdout.write(`\r  ${traites}/${lignes.length} importées…`);
    }
  }

  const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM OUI_FABRICANT");
  console.log(`\nTerminé. ${total} entrée(s) dans OUI_FABRICANT.`);
  console.log("Le cache du serveur se rafraîchit dans l'heure, ou au redémarrage.");
  process.exit(0);
}

main().catch((err) => {
  if (err.code === "ER_NO_SUCH_TABLE") {
    console.error("La table OUI_FABRICANT n'existe pas.");
    console.error("Exécutez d'abord backend/migrations/2026-08-17-oui-fabricant.sql");
  } else {
    console.error("Erreur :", err.message);
  }
  process.exit(1);
});
