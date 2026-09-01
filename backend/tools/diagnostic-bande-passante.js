/**
 * tools/diagnostic-bande-passante.js
 * Pourquoi la page Bande passante est vide.
 *
 *   node tools\diagnostic-bande-passante.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * LA MESURE SE FAIT EN DEUX TEMPS, ET C'EST LA SOURCE DE CONFUSION
 *
 *   1. L'INVENTAIRE des interfaces a lieu pendant un SCAN. Sans lui,
 *      aucune ligne n'existe à mettre à jour.
 *
 *   2. Le DÉBIT est calculé par le cycle de supervision, entre deux
 *      relevés successifs des compteurs SNMP. Un compteur seul ne donne
 *      aucun débit : il faut une différence.
 *
 * Un écran vide peut donc venir de trois endroits très différents, et
 * cet outil dit lequel :
 *
 *   • aucun équipement n'expose SNMP        → rien à faire, c'est le parc
 *   • SNMP répond mais aucune interface     → l'inventaire n'a pas eu lieu
 *   • interfaces présentes mais sans débit  → le cycle n'a pas encore mesuré
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BANDE PASSANTE — OÙ LA CHAÎNE S'INTERROMPT");
  console.log("═══════════════════════════════════════════════════════\n");

  const [[etape1]] = await db.query(
    "SELECT COUNT(*) AS n FROM EQUIPEMENT WHERE sys_descr IS NOT NULL"
  );
  const [[etape2]] = await db.query("SELECT COUNT(*) AS n FROM INTERFACE_RESEAU");
  const [[etape3]] = await db.query(
    "SELECT COUNT(*) AS n FROM INTERFACE_RESEAU WHERE trafic_entrant_kbps IS NOT NULL"
  );
  const [[etape4]] = await db.query(
    `SELECT COUNT(*) AS n FROM INTERFACE_RESEAU
     WHERE trafic_entrant_kbps IS NOT NULL
       AND date_trafic >= NOW() - INTERVAL 24 HOUR`
  );

  const ligne = (n, libelle, valeur, aide) => {
    const marque = valeur > 0 ? `${V}✓${F}` : `${R}✗${F}`;
    console.log(`  ${marque} ${n}. ${libelle} : ${valeur}`);
    if (valeur === 0 && aide) console.log(`      ${J}${aide}${F}`);
  };

  ligne(1, "Équipements répondant en SNMP", etape1.n,
    "Aucun équipement n'expose SNMP : la bande passante ne peut pas être mesurée. Ce n'est pas un défaut.");
  ligne(2, "Interfaces inventoriées", etape2.n,
    "L'inventaire des interfaces a lieu pendant un SCAN. Relancez un scan complet.");
  ligne(3, "Interfaces avec un débit", etape3.n,
    "Les interfaces existent mais aucun débit n'a été calculé. Le cycle de supervision doit tourner AU MOINS DEUX FOIS, backend démarré, pour produire une différence.");
  ligne(4, "Débits de moins de 24 h", etape4.n,
    "Des débits existent mais tous datent de plus de 24 h : la page les écarte. Laissez le backend tourner quelques minutes.");

  // Détail : quels équipements SNMP ont — ou non — des interfaces.
  const [detail] = await db.query(
    `SELECT e.adresse_ip, e.nom,
            COUNT(i.id_interface) AS nb_interfaces,
            SUM(i.trafic_entrant_kbps IS NOT NULL) AS avec_debit
     FROM EQUIPEMENT e
     LEFT JOIN INTERFACE_RESEAU i ON i.id_equipement = e.id_equipement
     WHERE e.sys_descr IS NOT NULL
     GROUP BY e.id_equipement, e.adresse_ip, e.nom
     ORDER BY INET_ATON(e.adresse_ip)`
  );

  if (detail.length > 0) {
    console.log("\n───────────────────────────────────────────────────────");
    console.log("  ÉQUIPEMENTS SNMP, UN PAR UN");
    console.log("───────────────────────────────────────────────────────\n");
    console.log(`  ${G}adresse           nom                interfaces  avec débit${F}`);
    for (const d of detail) {
      const couleur = d.nb_interfaces === 0 ? R : d.avec_debit > 0 ? V : J;
      console.log(
        `  ${couleur}${d.adresse_ip.padEnd(16)}${F}  ${(d.nom || "—").slice(0, 18).padEnd(18)} ` +
          `${String(d.nb_interfaces).padStart(6)}  ${String(d.avec_debit || 0).padStart(10)}`
      );
    }
  }

  console.log("\n───────────────────────────────────────────────────────");
  if (etape1.n === 0) {
    console.log("  Aucun équipement SNMP : la fonction ne peut rien mesurer ici.");
  } else if (etape2.n === 0) {
    console.log(`  ${J}L'inventaire des interfaces n'a jamais eu lieu.${F}`);
    console.log("  Relancez un scan depuis le tableau de bord : c'est le scan,");
    console.log("  et non le cycle de supervision, qui découvre les interfaces.");
  } else if (etape3.n === 0) {
    console.log(`  ${J}Les interfaces sont connues mais aucun débit n'a été calculé.${F}`);
    console.log("  Le débit se calcule entre DEUX relevés : laissez le backend");
    console.log("  tourner au moins deux cycles, puis rechargez la page.");
  } else {
    console.log(`  ${V}La chaîne est complète.${F} Si la page reste vide,`);
    console.log("  le défaut est à l'affichage et non à la collecte.");
  }
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
