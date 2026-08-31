/**
 * tools/diagnostic-types.js
 * Pourquoi chaque équipement a reçu son type.
 *
 *   node tools\diagnostic-types.js              tout le parc, groupé
 *   node tools\diagnostic-types.js routeur      seulement ce type
 *   node tools\diagnostic-types.js 192.168.0.51 une adresse précise
 *
 * ─────────────────────────────────────────────────────────────────────
 * À QUOI SERT CET OUTIL
 *
 * Un type contesté par un client — « ce n'est pas un routeur, c'est mon
 * téléphone » — doit se diagnostiquer en lisant une ligne, pas en
 * relançant un scan et en lisant du code.
 *
 * La colonne `type_source` enregistre QUELLE RÈGLE a décidé :
 *
 *   snmp         le texte que l'équipement donne de lui-même
 *   port         un port révélateur ouvert (9100 → imprimante…)
 *   nmap_device  la catégorie annoncée par nmap
 *   nmap_os      le système d'exploitation deviné par nmap
 *   fabricant    déduit du constructeur de la carte réseau
 *   aucune       aucun signal exploitable → « inconnu »
 *
 * Sans cette trace, on ne peut ni expliquer la décision, ni savoir
 * quelle règle corriger.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const filtre = process.argv[2] || null;
const estAdresse = filtre && /^\d+\.\d+\.\d+\.\d+$/.test(filtre);

(async () => {
  let where = "";
  const params = [];
  if (estAdresse) {
    where = "WHERE e.adresse_ip = ?";
    params.push(filtre);
  } else if (filtre) {
    where = "WHERE t.libelle = ?";
    params.push(filtre);
  }

  const [lignes] = await db.query(
    `SELECT e.adresse_ip, e.nom, e.fabricant, e.fabricant_source,
            e.type_source, e.sys_descr, e.os_detecte,
            t.libelle AS type
     FROM EQUIPEMENT e
     LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
     ${where}
     ORDER BY t.libelle, INET_ATON(e.adresse_ip)`,
    params
  );

  if (lignes.length === 0) {
    console.log("\nAucun équipement ne correspond.\n");
    process.exit(0);
  }

  // Vue d'ensemble : quelle règle décide le plus souvent, et pour quel type.
  const parType = new Map();
  for (const l of lignes) {
    const type = l.type || "inconnu";
    if (!parType.has(type)) parType.set(type, new Map());
    const sources = parType.get(type);
    const src = l.type_source || "(non enregistrée)";
    sources.set(src, (sources.get(src) || 0) + 1);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  QUELLE RÈGLE A DÉCIDÉ DE CHAQUE TYPE");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const [type, sources] of parType) {
    const total = [...sources.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${type}  ${G}(${total})${F}`);
    for (const [src, n] of [...sources].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${G}${src.padEnd(14)}${F} ${n}`);
    }
  }

  // Détail, seulement quand on a filtré : sinon la sortie est illisible.
  if (filtre) {
    console.log("\n───────────────────────────────────────────────────────");
    console.log("  DÉTAIL");
    console.log("───────────────────────────────────────────────────────\n");
    for (const l of lignes) {
      console.log(`  ${J}${l.adresse_ip}${F}  ${l.nom || "(sans nom)"}`);
      console.log(`      type         ${V}${l.type || "inconnu"}${F}`);
      console.log(`      décidé par   ${l.type_source || "(non enregistrée)"}`);
      console.log(`      fabricant    ${l.fabricant || "—"} ${G}(${l.fabricant_source || "—"})${F}`);
      // Ce sont ces deux textes que lisent les règles : les voir permet
      // de reproduire la décision à la main.
      console.log(`      sys_descr    ${G}${(l.sys_descr || "—").slice(0, 90)}${F}`);
      console.log(`      os_detecte   ${G}${(l.os_detecte || "—").slice(0, 90)}${F}`);
      console.log("");
    }
  } else {
    console.log(`\n  ${G}Pour le détail d'un type : node tools\\diagnostic-types.js routeur${F}`);
    console.log(`  ${G}Pour une machine précise  : node tools\\diagnostic-types.js 192.168.0.51${F}`);
  }

  console.log("");
  process.exit(0);
})().catch((err) => {
  console.error("Erreur :", err.message);
  if (/type_source/.test(err.message)) {
    console.error("La colonne type_source manque : node tools\\appliquer-migrations.js");
  }
  process.exit(1);
});
