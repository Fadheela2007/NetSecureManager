/**
 * tools/sonde-interfaces.js
 * Interroge directement les interfaces SNMP d'un équipement.
 *
 *   node tools\sonde-interfaces.js 192.168.0.239
 *   node tools\sonde-interfaces.js 192.168.0.239 macommunaute
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * L'inventaire des interfaces échoue en silence pendant un scan : le
 * code enveloppe l'appel dans un try/catch qui écrit dans la console du
 * serveur et continue — un choix volontaire, car un équipement muet ne
 * doit pas faire échouer le scan entier. Mais du coup, la cause de
 * l'échec se perd au milieu du journal.
 *
 * Cet outil rejoue exactement le même appel, seul, et montre ce que
 * l'équipement répond vraiment.
 *
 * TROIS RÉSULTATS POSSIBLES, TROIS CAUSES OPPOSÉES :
 *
 *   • aucune réponse SNMP        → la communauté est différente de
 *                                  celle utilisée par le scan
 *   • réponse sans interfaces    → l'équipement n'expose pas IF-MIB
 *   • interfaces listées ici     → l'échec vient du scan, pas du réseau
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const { snmpMetrics } = require("../src/services/discoveryService");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const ip = process.argv[2];
const communaute = process.argv[3] || "public";

if (!ip) {
  console.error("\nUsage : node tools\\sonde-interfaces.js <adresse-ip> [communaute]\n");
  process.exit(1);
}

(async () => {
  console.log(`\n  Interrogation de ${J}${ip}${F} avec la communauté « ${communaute} »…\n`);

  let metrics;
  try {
    metrics = await snmpMetrics(ip, communaute, { avecInventaire: true });
  } catch (err) {
    console.error(`  ${R}Échec de l'interrogation :${F} ${err.message}\n`);
    process.exit(1);
  }

  if (!metrics) {
    console.log(`  ${R}Aucune réponse SNMP.${F}`);
    console.log("  La communauté est probablement différente. Essayez celle");
    console.log("  configurée sur l'imprimante, souvent « public » ou « private ».\n");
    process.exit(0);
  }

  // Noms exacts renvoyes par snmpMetrics : cpuPercent / ramPercent.
  console.log(`  ${G}Mesures generales${F}`);
  for (const [libelle, v] of [["processeur", metrics.cpuPercent], ["memoire", metrics.ramPercent]]) {
    console.log(`    ${libelle.padEnd(12)} ${v === null || v === undefined ? `${G}—${F}` : Math.round(v) + " %"}`);
  }

  const interfaces = metrics.interfaces || [];
  console.log(`\n  ${G}Interfaces remontées : ${interfaces.length}${F}\n`);

  if (interfaces.length === 0) {
    console.log(`  ${R}Aucune interface.${F}`);
    console.log("  L'équipement répond en SNMP mais n'expose pas sa table");
    console.log("  d'interfaces (IF-MIB), ou la refuse à cette communauté.");
    console.log("  La bande passante ne peut alors pas être mesurée sur lui.\n");
    process.exit(0);
  }

  console.log(`  ${G}index  nom                 admin      etat       vitesse   octets recus${F}`);
  for (const i of interfaces) {
    // `nom` est le filtre appliqué par le scan : une interface sans nom
    // est écartée. C'est souvent LÀ que l'inventaire se vide.
    const marque = i.nom ? `${V}✓${F}` : `${R}✗${F}`;
    console.log(
      `  ${marque} ${String(i.index).padStart(4)}  ${String(i.nom || "(sans nom)").slice(0, 18).padEnd(18)} ` +
        `${String(i.etatAdmin || "—").padEnd(10)} ${String(i.etatOperationnel || "—").padEnd(10)} ` +
        `${String(i.vitesseMbps ? i.vitesseMbps + " Mb" : "—").padEnd(9)} ${i.inOctets}`
    );
  }

  const nommees = interfaces.filter((i) => i.nom).length;
  console.log("\n───────────────────────────────────────────────────────");
  if (nommees === 0) {
    console.log(`  ${J}Des interfaces existent mais AUCUNE n'a de nom.${F}`);
    console.log("  Le scan les écarte toutes, car il filtre sur le nom.");
    console.log("  C'est la cause de l'inventaire vide.");
  } else {
    console.log(`  ${V}${nommees} interface(s) exploitable(s).${F}`);
    console.log("  L'inventaire devrait donc se remplir au prochain scan.");
    console.log("  S'il reste vide, l'échec est dans le scan lui-même :");
    console.log("  regardez la console du backend pendant un scan.");
  }
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})();
