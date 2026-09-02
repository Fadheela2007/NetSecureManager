/**
 * tools/diagnostic-blocage-web.js
 * Où la chaîne du blocage web s'interrompt.
 *
 *   node tools\diagnostic-blocage-web.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * Le blocage web tient à SIX conditions, dans six endroits différents :
 * les tables existent, une liste de domaines est importée, une politique
 * existe, elle est active, elle est reliée à des catégories QUI ONT des
 * domaines, et un agent est venu la chercher.
 *
 * Si l'une manque, il ne se passe rien — et le symptôme est le même dans
 * les six cas : les sites s'ouvrent normalement. Chercher au hasard fait
 * perdre des heures, comme cela vient d'arriver : le document de suivi
 * annonçait « 95 664 domaines, politique active » alors que la base
 * n'avait plus une seule liste importée.
 *
 * Cet outil regarde les six, dans l'ordre, et dit LEQUEL manque.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const marque = (ok) => (ok ? `${V}✓${F}` : `${R}✗${F}`);

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  BLOCAGE WEB — OÙ LA CHAÎNE S'INTERROMPT");
  console.log("═══════════════════════════════════════════════════════\n");

  /* ── 1. Les tables existent-elles ? ──────────────────────────────── */
  let tablesOk = true;
  try {
    await db.query("SELECT 1 FROM CATEGORIE_WEB LIMIT 1");
    await db.query("SELECT 1 FROM POLITIQUE_WEB LIMIT 1");
    await db.query("SELECT 1 FROM DOMAINE_CATEGORIE LIMIT 1");
  } catch (err) {
    tablesOk = false;
    console.log(`  ${marque(false)} 1. Tables du blocage web : ${R}absentes${F}`);
    console.log(`      ${J}${err.message}${F}`);
    console.log(`      ${J}Lancez : node tools\\appliquer-migrations.js${F}\n`);
    process.exit(0);
  }
  console.log(`  ${marque(true)} 1. Tables du blocage web présentes`);

  /* ── 2. Les catégories et leurs domaines ─────────────────────────── */
  const [categories] = await db.query(
    `SELECT c.id_categorie, c.code, c.libelle, c.nb_domaines, c.date_import,
            (SELECT COUNT(*) FROM DOMAINE_CATEGORIE d
              WHERE d.id_categorie = c.id_categorie) AS reels
     FROM CATEGORIE_WEB c ORDER BY c.code`
  );

  const totalDomaines = categories.reduce((s, c) => s + Number(c.reels || 0), 0);
  console.log(
    `  ${marque(totalDomaines > 0)} 2. Domaines importés : ${totalDomaines.toLocaleString("fr-FR")}`
  );

  console.log(`\n  ${G}  catégorie          annoncés     réels   importée le${F}`);
  for (const c of categories) {
    const annonces = Number(c.nb_domaines || 0);
    const reels = Number(c.reels || 0);
    // Un écart entre les deux signifie que le compteur n'a pas été mis à
    // jour, ou qu'un import s'est interrompu : l'interface afficherait
    // alors un nombre de domaines qui ne correspond à rien.
    const couleur = reels === 0 ? R : annonces !== reels ? J : V;
    console.log(
      `    ${couleur}${String(c.code).padEnd(18)}${F} ` +
        `${String(annonces).padStart(8)}  ${String(reels).padStart(8)}   ` +
        `${c.date_import ? new Date(c.date_import).toLocaleString("fr-FR") : `${G}jamais${F}`}` +
        (annonces !== reels ? `  ${J}← compteur incohérent${F}` : "")
    );
  }

  /* ── 3, 4, 5. Les politiques ─────────────────────────────────────── */
  const [politiques] = await db.query(
    `SELECT p.id_politique, p.id_site, p.nom, p.active, p.version,
            s.nom AS site_nom
     FROM POLITIQUE_WEB p
     LEFT JOIN SITE s ON s.id_site = p.id_site
     ORDER BY p.id_site IS NULL DESC, p.id_site`
  );

  console.log(`\n  ${marque(politiques.length > 0)} 3. Politiques déclarées : ${politiques.length}`);

  if (politiques.length === 0) {
    console.log(`      ${J}Créez-en une depuis la page Contrôle d'accès web.${F}`);
  }

  for (const p of politiques) {
    const [liees] = await db.query(
      `SELECT c.code, c.libelle,
              (SELECT COUNT(*) FROM DOMAINE_CATEGORIE d
                WHERE d.id_categorie = c.id_categorie) AS reels
       FROM POLITIQUE_CATEGORIE pc
       JOIN CATEGORIE_WEB c ON c.id_categorie = pc.id_categorie
       WHERE pc.id_politique = ?
       ORDER BY c.code`,
      [p.id_politique]
    );

    const utiles = liees.filter((c) => Number(c.reels) > 0);
    const bloques = utiles.reduce((s, c) => s + Number(c.reels), 0);

    console.log(
      `\n  ${J}Politique « ${p.nom} »${F} — ` +
        `${p.id_site ? `site ${p.id_site} (${p.site_nom})` : "tous les sites"} · v${p.version}`
    );
    console.log(`    ${marque(!!p.active)} 4. Active : ${p.active ? "oui" : `${R}NON${F}`}`);
    console.log(
      `    ${marque(liees.length > 0)} 5. Catégories cochées : ${liees.length}` +
        (liees.length ? ` (${liees.map((c) => c.code).join(", ")})` : "")
    );
    console.log(
      `    ${marque(bloques > 0)} 6. Domaines réellement bloqués : ${bloques.toLocaleString("fr-FR")}`
    );

    // Le piège le plus courant : des catégories cochées mais vides.
    const vides = liees.filter((c) => Number(c.reels) === 0);
    if (vides.length > 0) {
      console.log(
        `      ${J}Cochées mais VIDES : ${vides.map((c) => c.code).join(", ")}${F}`
      );
      console.log(`      ${J}Elles ne bloquent rien tant qu'aucune liste n'est importée.${F}`);
    }
  }

  /* ── 6. Ce que les agents ont réellement appliqué ────────────────── */
  const [sites] = await db.query(
    `SELECT id_site, nom, politique_version_appliquee, politique_date_application,
            politique_erreur
     FROM SITE ORDER BY id_site`
  ).catch(() => [[]]);

  if (sites.length) {
    console.log(`\n  ${G}Ce que les agents ont appliqué${F}`);
    for (const s of sites) {
      const etat = s.politique_erreur
        ? `${R}erreur : ${s.politique_erreur}${F}`
        : s.politique_version_appliquee
        ? `${V}v${s.politique_version_appliquee}${F} le ${new Date(s.politique_date_application).toLocaleString("fr-FR")}`
        : `${G}jamais${F}`;
      console.log(`    site ${s.id_site} — ${String(s.nom).slice(0, 22).padEnd(22)} ${etat}`);
    }
  }

  /* ── Verdict ─────────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if (totalDomaines === 0) {
    console.log(`  ${R}Aucun domaine importé.${F} Rien ne peut être bloqué.`);
    console.log("  node tools\\importer-listes-web.js publicite --recommandee --remplacer");
  } else {
    const utilisable = politiques.some((p) => p.active);
    if (!utilisable) {
      console.log(`  ${J}Des domaines existent mais aucune politique n'est active.${F}`);
      console.log("  Cochez « Politique active » et enregistrez.");
    } else {
      console.log(`  ${V}La chaîne côté plateforme est complète.${F}`);
      console.log("  S'il ne se passe rien, le maillon suivant est l'agent :");
      console.log("  relancez-le et lisez la ligne « Politique web ... ».");
    }
  }
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})().catch((err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  process.exit(1);
});
