/**
 * tools/diagnostic-releves.js
 * Ce que contiennent réellement les relevés d'un équipement.
 *
 *   node tools\diagnostic-releves.js 192.168.0.239
 *   node tools\diagnostic-releves.js              vue d'ensemble du parc
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI
 *
 * Un graphique vide a trois causes possibles, indiscernables à l'écran :
 *
 *   1. aucun relevé n'existe ;
 *   2. des relevés existent mais toutes leurs valeurs sont nulles ;
 *   3. les relevés existent et sont valides — le défaut est à l'affichage.
 *
 * Chacune appelle une correction différente. Cet outil tranche.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";
const ip = process.argv[2] || null;

(async () => {
  if (!ip) {
    // Vue d'ensemble : quelles colonnes sont réellement remplies ?
    const [[r]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(latence_ms    IS NOT NULL) AS avec_latence,
              SUM(cpu_pourcent  IS NOT NULL) AS avec_cpu,
              SUM(ram_pourcent  IS NOT NULL) AS avec_ram,
              SUM(trafic_entrant_kbps IS NOT NULL) AS avec_trafic
       FROM RELEVE WHERE date_releve >= NOW() - INTERVAL 24 HOUR`
    );
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  RELEVÉS DES 24 DERNIÈRES HEURES — TOUT LE PARC");
    console.log("═══════════════════════════════════════════════════════\n");
    console.log(`  total          ${r.total}`);
    const part = (n) => (r.total ? `${Math.round((n / r.total) * 100)} %` : "—");
    console.log(`  avec latence   ${r.avec_latence || 0}  ${G}(${part(r.avec_latence || 0)})${F}`);
    console.log(`  avec CPU       ${r.avec_cpu || 0}  ${G}(${part(r.avec_cpu || 0)})${F}`);
    console.log(`  avec RAM       ${r.avec_ram || 0}  ${G}(${part(r.avec_ram || 0)})${F}`);
    console.log(`  avec trafic    ${r.avec_trafic || 0}  ${G}(${part(r.avec_trafic || 0)})${F}`);
    console.log(`\n  ${G}Pour une machine : node tools\\diagnostic-releves.js 192.168.0.239${F}\n`);
    process.exit(0);
  }

  const [eqs] = await db.query(
    "SELECT id_equipement, nom, adresse_ip, statut FROM EQUIPEMENT WHERE adresse_ip = ?",
    [ip]
  );
  if (eqs.length === 0) {
    console.error(`\nAucun équipement à l'adresse ${ip}.\n`);
    process.exit(1);
  }
  const eq = eqs[0];

  const [releves] = await db.query(
    `SELECT date_releve, latence_ms, cpu_pourcent, ram_pourcent,
            trafic_entrant_kbps, trafic_sortant_kbps
     FROM RELEVE
     WHERE id_equipement = ? AND date_releve >= NOW() - INTERVAL 24 HOUR
     ORDER BY date_releve DESC LIMIT 15`,
    [eq.id_equipement]
  );

  const [[compte]] = await db.query(
    `SELECT COUNT(*) AS n, SUM(latence_ms IS NOT NULL) AS avec_latence
     FROM RELEVE WHERE id_equipement = ? AND date_releve >= NOW() - INTERVAL 24 HOUR`,
    [eq.id_equipement]
  );

  console.log(`\n  ${J}${eq.adresse_ip}${F}  ${eq.nom || "(sans nom)"}  —  ${eq.statut}`);
  console.log(`  ${compte.n} relevé(s) sur 24 h, dont ${compte.avec_latence || 0} avec une latence\n`);

  if (releves.length === 0) {
    console.log(`  ${R}Aucun relevé : le graphique EST censé être vide.${F}`);
    console.log("  La supervision ne mesure que les équipements des sites locaux.\n");
    process.exit(0);
  }

  console.log(`  ${G}date                 latence   cpu    ram    entrant${F}`);
  const col = (v, u = "") => (v === null || v === undefined ? `${R}—${F}`.padEnd(15) : `${v}${u}`.padEnd(7));
  for (const r of releves) {
    console.log(
      `  ${new Date(r.date_releve).toLocaleString("fr-FR").padEnd(20)} ` +
        `${col(r.latence_ms)} ${col(r.cpu_pourcent)} ${col(r.ram_pourcent)} ${col(r.trafic_entrant_kbps)}`
    );
  }

  console.log("");
  if ((compte.avec_latence || 0) === 0) {
    console.log(`  ${R}CAUSE : des relevés existent, mais AUCUNE latence n'est enregistrée.${F}`);
    console.log("  Le graphique n'a donc rien à tracer. Le défaut est dans la");
    console.log("  collecte, pas dans l'affichage.\n");
  } else {
    console.log(`  ${V}Des latences sont enregistrées : le graphique devrait les afficher.${F}`);
    console.log("  Si l'écran reste vide, le défaut est à l'affichage.\n");
  }
  process.exit(0);
})().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
