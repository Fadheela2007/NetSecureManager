/**
 * tools/etat-migrations.js
 * Dit quelles migrations sont passées et lesquelles manquent.
 *
 *   node tools\etat-migrations.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL EXISTE
 *
 * Rien ne trace les migrations exécutées : elles se lancent à la main
 * dans Workbench, et on croit les avoir toutes passées. Quand il en
 * manque une, le symptôme est indirect et trompeur.
 *
 * Cas réel : la colonne SITE.dernier_push manquait. Le cycle de
 * supervision échouait donc en entier, chaque minute, sur 113
 * équipements — aucun relevé, aucun graphique, aucune bande passante.
 * La seule trace était une ligne d'erreur noyée dans la console, et on
 * a cherché la cause du côté des agents pendant un bon moment.
 *
 * Cet outil regarde la structure RÉELLE de la base et la compare à ce
 * que le code attend. Il ne modifie rien.
 * ─────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

/**
 * Ce que chaque migration apporte, et ce qui casse sans elle.
 *
 * On teste une colonne ou une table TÉMOIN par migration — la plus
 * caractéristique. Une migration à moitié passée reste possible ; le
 * contrôle final liste alors tout ce qui manque, colonne par colonne.
 */
const MIGRATIONS = [
  {
    fichier: "2026-08-10-fiabilite-usage-prolonge.sql",
    table: "SITE",
    colonne: "dernier_push",
    casse: "LA SUPERVISION ENTIÈRE — aucun relevé, aucun graphique, aucune bande passante",
    gravite: "critique",
  },
  {
    fichier: "2026-08-10-interfaces-et-assignation.sql",
    table: "INTERFACE_RESEAU",
    colonne: "index_snmp",
    casse: "l'inventaire des interfaces",
    gravite: "moyenne",
  },
  {
    fichier: "2026-08-12-seuils-performance.sql",
    table: "CONFIGURATION",
    cle: "seuil_cpu_pourcent",
    casse: "les alertes de charge processeur et mémoire",
    gravite: "moyenne",
  },
  {
    fichier: "2026-08-17-oui-fabricant.sql",
    table: "OUI_FABRICANT",
    casse: "la résolution des fabricants par adresse MAC",
    gravite: "faible",
  },
  {
    fichier: "2026-08-17-types-coherents.sql",
    table: "EQUIPEMENT",
    colonne: "fabricant_source",
    casse: "la traçabilité de l'origine du fabricant",
    gravite: "faible",
  },
  {
    fichier: "2026-08-18-alertes-acquittement.sql",
    table: "ALERTE",
    colonne: "occurrences",
    casse: "le dédoublonnage et l'acquittement des alertes",
    gravite: "moyenne",
  },
  {
    fichier: "2026-08-18-bande-passante.sql",
    table: "INTERFACE_RESEAU",
    colonne: "trafic_entrant_kbps",
    casse: "la page Bande passante",
    gravite: "moyenne",
  },
  {
    fichier: "2026-08-19-controle-acces-web.sql",
    table: "POLITIQUE_WEB",
    casse: "le contrôle des accès web",
    gravite: "moyenne",
  },
  {
    fichier: "2026-08-22-colonnes-historiques-manquantes.sql",
    table: "CONFIGURATION",
    colonne: "description",
    casse: "l'écran Configuration (erreur 500) et le référentiel des types d'équipement",
    gravite: "critique",
  },
  {
    fichier: "2026-08-21-attribution-par-port.sql",
    table: "INTERFACE_RESEAU",
    colonne: "id_equipement_connecte",
    casse: "la mesure de bande passante des machines sans SNMP",
    gravite: "moyenne",
  },
];

const COULEUR = {
  critique: "\x1b[31m",
  moyenne: "\x1b[33m",
  faible: "\x1b[90m",
  ok: "\x1b[32m",
  fin: "\x1b[0m",
};

async function tableExiste(nom) {
  const [r] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [nom]
  );
  return Number(r[0].n) > 0;
}

async function colonneExiste(table, colonne) {
  const [r] = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, colonne]
  );
  return Number(r[0].n) > 0;
}

async function cleConfigExiste(cle) {
  const [r] = await db.query("SELECT COUNT(*) AS n FROM CONFIGURATION WHERE cle = ?", [cle]);
  return Number(r[0].n) > 0;
}

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ÉTAT DES MIGRATIONS");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── QUELLE BASE REGARDE-T-ON, AU JUSTE ? ──
  //
  // Sans cette section, un rapport « tout manque » est indéchiffrable :
  // on ne sait pas si les migrations n'ont pas été passées, ou si
  // l'outil et Workbench travaillent sur deux bases différentes.
  //
  // Le cas s'est produit : Workbench exécutait des ALTER TABLE avec
  // succès pendant que l'outil déclarait les neuf migrations absentes.
  // Les deux disaient vrai — sur deux bases distinctes.
  const [[ctx]] = await db.query(
    "SELECT DATABASE() AS base, @@hostname AS serveur, VERSION() AS version"
  );
  console.log(`  Base      : ${ctx.base}   (DB_NAME de backend\\.env)`);
  console.log(`  Serveur   : ${ctx.serveur}  —  MySQL ${ctx.version}`);
  console.log(`  Hôte      : ${process.env.DB_HOST}`);

  // Inventaire réel : nombre de tables et de lignes dans les principales.
  const [inventaire] = await db.query(
    `SELECT TABLE_NAME, TABLE_ROWS
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME`
  );
  console.log(`  Tables    : ${inventaire.length}`);

  if (inventaire.length === 0) {
    console.log("\n\x1b[31m  ⚠ CETTE BASE EST VIDE — aucune table.\x1b[0m");
    console.log("    Ce n'est pas un problème de migrations : le schéma initial");
    console.log("    n'a jamais été appliqué ici, ou DB_NAME désigne la mauvaise base.\n");
    console.log("    Vérifiez DB_NAME dans backend\\.env, puis, si la base est");
    console.log("    bien celle-ci, exécutez d'abord backend\\schema.sql.\n");
    process.exit(1);
  }

  // Les autres bases du serveur qui contiennent aussi une table
  // EQUIPEMENT : c'est là que se trouvent les données si on s'est trompé
  // de nom.
  const [ailleurs] = await db.query(
    `SELECT TABLE_SCHEMA, TABLE_ROWS
     FROM information_schema.TABLES
     WHERE TABLE_NAME = 'EQUIPEMENT' AND TABLE_SCHEMA <> DATABASE()`
  );
  if (ailleurs.length > 0) {
    console.log("\n\x1b[33m  ⚠ Une table EQUIPEMENT existe AUSSI dans :\x1b[0m");
    for (const a of ailleurs) {
      console.log(`      ${a.TABLE_SCHEMA}  (~${a.TABLE_ROWS ?? "?"} lignes)`);
    }
    console.log("    Si vos données sont là, c'est DB_NAME qui désigne la");
    console.log("    mauvaise base — et Workbench ne regarde pas la même.\n");
  }

  const equipements = inventaire.find((t) => t.TABLE_NAME.toUpperCase() === "EQUIPEMENT");
  if (equipements) {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM EQUIPEMENT");
    console.log(`  Équipements : ${n}${n === 0 ? "  ← parc vide, un scan le repeuplera" : ""}`);
  }
  console.log("");

  const manquantes = [];

  for (const m of MIGRATIONS) {
    // On distingue « la table n'existe pas » de « la colonne manque » :
    // le premier cas veut dire que le schéma initial n'est pas appliqué,
    // le second qu'une migration n'est pas passée. Ce ne sont pas les
    // mêmes réparations, et les confondre fait perdre du temps.
    let presente;
    let detail;
    try {
      if (!(await tableExiste(m.table))) {
        presente = false;
        detail = `table ${m.table} absente`;
      } else if (m.colonne) {
        presente = await colonneExiste(m.table, m.colonne);
        detail = `colonne ${m.table}.${m.colonne} absente`;
      } else if (m.cle) {
        presente = await cleConfigExiste(m.cle);
        detail = `clé « ${m.cle} » absente de ${m.table}`;
      } else {
        presente = true;
      }
    } catch (err) {
      presente = false;
      detail = `contrôle impossible : ${err.message}`;
    }

    const c = presente ? COULEUR.ok : COULEUR[m.gravite];
    const marque = presente ? "✓" : "✗";
    console.log(`${c}  ${marque} ${m.fichier}${COULEUR.fin}`);
    if (!presente) {
      console.log(`      manque : ${detail}`);
      console.log(`      casse  : ${m.casse}`);
      manquantes.push(m);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");

  if (manquantes.length === 0) {
    console.log(`${COULEUR.ok}  Toutes les migrations sont passées.${COULEUR.fin}\n`);
    process.exit(0);
  }

  const critiques = manquantes.filter((m) => m.gravite === "critique");
  if (critiques.length > 0) {
    console.log(`${COULEUR.critique}  ⚠ ${critiques.length} migration(s) CRITIQUE(S) manquante(s).${COULEUR.fin}`);
    console.log("    La plateforme fonctionne en mode dégradé.\n");
  }

  console.log("  À exécuter dans MySQL Workbench, DANS CET ORDRE :\n");
  for (const m of manquantes) {
    console.log(`    backend\\migrations\\${m.fichier}`);
  }
  console.log("\n  Rappel : ouvrez un onglet VIDE (Ctrl+T) pour chaque fichier.");
  console.log("  « Error Code: 1060 Duplicate column » = déjà passée, sans gravité.\n");

  process.exit(1);
})().catch((err) => {
  console.error("\nContrôle impossible :", err.message);
  if (/ECONNREFUSED/.test(err.message)) {
    console.error("MySQL ne répond pas. Le service est-il démarré ?\n");
  }
  process.exit(2);
});
