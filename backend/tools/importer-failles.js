/**
 * tools/importer-failles.js
 *
 *   node tools\importer-failles.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * Interroge le NVD (National Vulnerability Database, NIST) pour chaque
 * logiciel dont le scan a lu la version, et enregistre les failles
 * publiées.
 *
 * POURQUOI C'EST UN OUTIL À LANCER, ET NON UNE ÉTAPE DU SCAN
 *
 * Le scan tourne sur le réseau du client. Cet import a besoin d'internet
 * — deux choses qui n'existent pas toujours en même temps. Les lier
 * ferait échouer un scan parfaitement valide parce que le pare-feu du
 * client bloque nvd.nist.gov.
 *
 * Et la cadence : sans clé d'API, le NVD accepte une requête toutes les
 * six secondes. Trente logiciels font trois minutes. Un scan ne peut pas
 * s'arrêter trois minutes pour ça ; un import lancé quand on veut, si.
 *
 * CLÉ D'API (facultative, gratuite)
 *
 * https://nvd.nist.gov/developers/request-an-api-key — puis dans .env :
 *     NVD_API_KEY=votre-cle
 * La cadence passe de six secondes à moins d'une : trente logiciels en
 * une demi-minute au lieu de trois minutes.
 *
 * CE QUE CET OUTIL N'AFFIRME JAMAIS
 *
 * Il ne dit pas qu'une machine est vulnérable. Il dit quelles failles ont
 * été PUBLIÉES pour la version qu'un service annonce. Le rapprochement se
 * fait sur la version numérique : un correctif de distribution corrige
 * souvent la faille sans changer ce numéro. C'est une liste à vérifier,
 * pas un verdict.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");
const { importerFailles } = require("../src/services/faillesService");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  FAILLES CONNUES — IMPORT DEPUIS LE NVD (NIST)");
  console.log("═══════════════════════════════════════════════════════\n");

  const bilan = await importerFailles((texte) => console.log(`  ${texte}`));

  console.log("");
  console.log(`  ${V}${bilan.interroges}${F} logiciel(s) interrogé(s)`);
  console.log(`  ${V}${bilan.failles}${F} faille(s) enregistrée(s)`);
  if (bilan.sansCpe > 0) {
    console.log(
      `  ${J}${bilan.sansCpe}${F} sans correspondance connue — rien n'est affirmé à leur sujet.\n` +
        `  ${G}Pour en ajouter une : backend/donnees/cpe-produits.json${F}`
    );
  }
  if (bilan.erreurs > 0) {
    console.log(
      `  ${R}${bilan.erreurs}${F} NON interrogé(s) — accès internet ou NVD indisponible.\n` +
        `  ${G}Ces logiciels sont marqués « non vérifié » à l'écran, pas « sans faille ».${F}`
    );
  }

  console.log(
    `\n  ${G}Rappel : ce sont les failles PUBLIÉES pour la version annoncée.\n` +
      `  Un correctif de distribution corrige souvent une faille sans changer\n` +
      `  ce numéro. À vérifier, pas un verdict.${F}\n`
  );

  await db.end();
})().catch(async (e) => {
  console.error(`\n  ${R}Import interrompu :${F} ${e.message}\n`);
  await db.end().catch(() => {});
  process.exitCode = 1;
});
