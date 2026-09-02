/**
 * tools/historique-parc.js
 * Qu'est-il arrivé au parc, et quand ?
 *
 *   node tools\historique-parc.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * Le parc du siège est passé de 92 à 35 équipements sans que personne
 * n'ait touché à la plateforme. Trois explications possibles, de gravité
 * très différente :
 *
 *   1. Une réinitialisation a été lancée. Elle est journalisée AVANT
 *      exécution, avec l'auteur et l'heure : le journal le dira.
 *
 *   2. Un scan a repeuplé un parc précédemment vidé. Les équipements
 *      porteraient alors tous la même date d'ajout, récente.
 *
 *   3. Le produit supprime des équipements de lui-même. Ce serait le
 *      cas le plus grave : un outil de supervision qui EFFACE une
 *      machine au lieu de la marquer absente fait disparaître son
 *      historique, et personne ne voit jamais qu'un poste a disparu.
 *
 * Les trois laissent des traces différentes. Cet outil les montre.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  HISTORIQUE DU PARC");
  console.log("═══════════════════════════════════════════════════════\n");

  /* ── 1. Réinitialisations ─────────────────────────────────────────── */
  const [reinits] = await db
    .query(
      `SELECT l.date_log, l.description, u.email
       FROM LOG_ACTIVITE l
       LEFT JOIN UTILISATEUR u ON u.id_utilisateur = l.id_utilisateur
       WHERE l.action = 'reinitialisation'
       ORDER BY l.date_log DESC LIMIT 10`
    )
    .catch(() => [[]]);

  console.log(`  ${G}Réinitialisations enregistrées${F}`);
  if (reinits.length === 0) {
    console.log(`    ${G}aucune${F}`);
  } else {
    for (const r of reinits) {
      console.log(
        `    ${new Date(r.date_log).toLocaleString("fr-FR")}  ` +
          `${(r.email || "auteur inconnu").padEnd(30)} ${r.description}`
      );
    }
  }

  /* ── 2. Quand les équipements actuels ont-ils été ajoutés ? ───────── */
  const [parJour] = await db.query(
    `SELECT DATE(date_ajout) AS jour, COUNT(*) AS n, MIN(id_site) AS site_min, MAX(id_site) AS site_max
     FROM EQUIPEMENT
     GROUP BY DATE(date_ajout)
     ORDER BY jour DESC LIMIT 10`
  );

  console.log(`\n  ${G}Date d'ajout des équipements PRÉSENTS${F}`);
  console.log(`  ${G}  jour          nombre   sites${F}`);
  for (const j of parJour) {
    const sites = j.site_min === j.site_max ? `${j.site_min}` : `${j.site_min}–${j.site_max}`;
    console.log(
      `    ${new Date(j.jour).toLocaleDateString("fr-FR").padEnd(12)} ${String(j.n).padStart(6)}   ${sites}`
    );
  }

  /* ── 3. Depuis quand ne répondent-ils plus ? ──────────────────────── */
  const [[etat]] = await db.query(
    `SELECT
       SUM(statut = 'up') AS actifs,
       SUM(statut = 'down') AS eteints,
       SUM(statut = 'inconnu') AS inconnus,
       SUM(derniere_decouverte IS NULL) AS jamais_vus
     FROM EQUIPEMENT`
  );
  console.log(`\n  ${G}État actuel${F}`);
  console.log(`    répondent      ${String(etat.actifs || 0).padStart(5)}`);
  console.log(`    éteints        ${String(etat.eteints || 0).padStart(5)}`);
  console.log(`    inconnus       ${String(etat.inconnus || 0).padStart(5)}`);
  console.log(`    jamais vus     ${String(etat.jamais_vus || 0).padStart(5)}`);

  /* ── 4. Le dernier scan ──────────────────────────────────────────── */
  const [scans] = await db
    .query(
      `SELECT l.date_log, l.description, u.email
       FROM LOG_ACTIVITE l
       LEFT JOIN UTILISATEUR u ON u.id_utilisateur = l.id_utilisateur
       WHERE l.action LIKE '%scan%'
       ORDER BY l.date_log DESC LIMIT 5`
    )
    .catch(() => [[]]);

  console.log(`\n  ${G}Derniers scans journalisés${F}`);
  if (scans.length === 0) {
    console.log(`    ${G}aucun${F}`);
  } else {
    for (const s of scans) {
      console.log(
        `    ${new Date(s.date_log).toLocaleString("fr-FR")}  ` +
          `${(s.email || "—").padEnd(30)} ${String(s.description).slice(0, 60)}`
      );
    }
  }

  /* ── Lecture ─────────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if (reinits.length > 0) {
    console.log(`  Une réinitialisation figure au journal : comparez son heure`);
    console.log("  à celle de la disparition. Si elle correspond, l'explication");
    console.log("  est là, et le produit s'est comporté comme demandé.");
  } else if (parJour.length === 1) {
    console.log(`  ${J}Tous les équipements portent la MÊME date d'ajout.${F}`);
    console.log("  Le parc a donc été vidé puis repeuplé par un scan — et");
    console.log("  aucune réinitialisation n'est journalisée pour l'expliquer.");
  } else {
    console.log(`  Aucune réinitialisation journalisée, et des dates d'ajout`);
    console.log("  échelonnées : les équipements manquants ont disparu sans");
    console.log(`  ${R}qu'aucune trace n'en rende compte.${F} C'est ce point qu'il faut`);
    console.log("  élucider avant toute vente.");
  }
  console.log("───────────────────────────────────────────────────────\n");

  await db.end().catch(() => {});
})().catch(async (err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  await db.end().catch(() => {});
  process.exitCode = 1;
});
