/**
 * tools/diagnostic-doublons.js
 * Pourquoi le même équipement apparaît deux fois.
 *
 *   node tools\diagnostic-doublons.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUI A DÉCLENCHÉ CET OUTIL
 *
 * Le diagnostic de bande passante a listé quatorze équipements SNMP,
 * mais seulement SEPT adresses — chacune apparaissant deux fois :
 *
 *     192.168.0.125   iR-ADV C3525 III    2 interfaces   2 avec débit
 *     192.168.0.125   iR-ADV C3525 III    2 interfaces   0 avec débit
 *
 * Deux lignes, deux jeux d'interfaces, un seul mesuré. Le parc annoncé
 * est passé de 101 à 189 machines sans que le réseau ne change.
 *
 * DEUX CAUSES POSSIBLES, ET ELLES N'APPELLENT PAS LE MÊME REMÈDE
 *
 *   A. Deux SITES existent en base et couvrent la même plage. Chaque
 *      scan crée alors légitimement sa propre copie : la clé unique
 *      porte sur (site, adresse), pas sur l'adresse seule. Le remède est
 *      de supprimer le site en trop.
 *
 *   B. La clé unique uniq_ip_site n'existe PAS dans la vraie base. Le
 *      schéma la déclare, mais `CREATE TABLE IF NOT EXISTS` ne modifie
 *      jamais une table déjà présente. Chaque scan ajoute alors une
 *      ligne au lieu de mettre à jour l'existante, indéfiniment. Le
 *      remède est de créer la clé — après avoir fusionné les doublons.
 *
 * Le cas B s'est DÉJÀ produit sur ce projet, avec la colonne `oui` de
 * la table des fabricants. C'est pourquoi on mesure au lieu de deviner.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  DOUBLONS D'ÉQUIPEMENTS — LA CAUSE");
  console.log("═══════════════════════════════════════════════════════\n");

  /* ── 1. La clé unique existe-t-elle VRAIMENT ? ───────────────────── */
  const [index] = await db.query("SHOW INDEX FROM EQUIPEMENT");
  const parNom = new Map();
  for (const i of index) {
    if (!parNom.has(i.Key_name)) parNom.set(i.Key_name, { unique: i.Non_unique === 0, colonnes: [] });
    parNom.get(i.Key_name).colonnes[i.Seq_in_index - 1] = i.Column_name;
  }

  console.log(`  ${G}Index présents sur EQUIPEMENT${F}`);
  for (const [nom, info] of parNom) {
    console.log(`    ${info.unique ? "UNIQUE " : "       "}${nom.padEnd(24)} (${info.colonnes.join(", ")})`);
  }

  const cle = parNom.get("uniq_ip_site");
  const cleOk = !!cle && cle.unique && cle.colonnes.includes("id_site") && cle.colonnes.includes("adresse_ip");
  console.log(
    `\n  ${cleOk ? V + "✓" : R + "✗"}${F} clé unique (id_site, adresse_ip) : ` +
      (cleOk ? `${V}présente${F}` : `${R}ABSENTE${F}`)
  );

  /* ── 2. Les sites ────────────────────────────────────────────────── */
  // La plage scannée n'est PAS stockée sur le site : elle est fournie à
  // chaque scan. On identifie donc les sites par nom et ville.
  const [sites] = await db.query(
    `SELECT s.id_site, s.nom, s.ville, s.dernier_push,
            (SELECT COUNT(*) FROM EQUIPEMENT e WHERE e.id_site = s.id_site) AS nb
     FROM SITE s ORDER BY s.id_site`
  );
  console.log(`\n  ${G}Sites déclarés${F}`);
  // C'est `dernier_push`, et NON `agent_token`, qui distingue un site
  // distant : un jeton peut avoir été généré sans qu'aucun agent n'ait
  // jamais transmis. Confondre les deux fait croire qu'un site est pris
  // en charge par un agent alors que personne ne le supervise.
  console.log(`  ${G}  id  nom                       ville            supervision   équipements${F}`);
  for (const s of sites) {
    const mode = s.dernier_push ? "agent distant" : "cycle central";
    console.log(
      `    ${String(s.id_site).padStart(3)}  ${String(s.nom || "—").slice(0, 23).padEnd(23)} ` +
        `${String(s.ville || "—").slice(0, 15).padEnd(15)} ` +
        `${mode.padEnd(13)} ${String(s.nb).padStart(6)}`
    );
  }

  // Deux sites portant le même nom : c'est le piège le plus courant —
  // un site créé deux fois, puis scanné deux fois.
  const etiquettes = sites.map((s) => `${s.nom} / ${s.ville}`);
  const doublees = etiquettes.filter((p, i) => etiquettes.indexOf(p) !== i);
  if (doublees.length) {
    console.log(`\n  ${J}Sites portant le MÊME nom : ${[...new Set(doublees)].join(", ")}${F}`);
    console.log(`  ${J}Chacun scanne la même plage et tient sa propre copie du parc.${F}`);
  }

  /* ── 3. Les doublons, comptés de deux façons ─────────────────────── */
  const [[total]] = await db.query("SELECT COUNT(*) AS n FROM EQUIPEMENT");

  // (a) Même adresse DANS le même site : impossible si la clé existe.
  const [dansSite] = await db.query(
    `SELECT id_site, adresse_ip, COUNT(*) AS n
     FROM EQUIPEMENT GROUP BY id_site, adresse_ip HAVING n > 1
     ORDER BY n DESC, INET_ATON(adresse_ip) LIMIT 15`
  );

  // (b) Même adresse dans des sites DIFFÉRENTS : autorisé, mais suspect
  //     quand cela concerne tout le parc.
  const [entreSites] = await db.query(
    `SELECT adresse_ip, COUNT(DISTINCT id_site) AS nb_sites, COUNT(*) AS n
     FROM EQUIPEMENT GROUP BY adresse_ip HAVING n > 1
     ORDER BY n DESC, INET_ATON(adresse_ip) LIMIT 15`
  );

  const [[recap]] = await db.query(
    `SELECT COUNT(*) AS adresses_doublees, SUM(n) - COUNT(*) AS lignes_en_trop FROM (
       SELECT adresse_ip, COUNT(*) AS n FROM EQUIPEMENT GROUP BY adresse_ip HAVING n > 1
     ) t`
  );

  console.log(`\n  ${G}Comptage${F}`);
  console.log(`    équipements enregistrés      ${String(total.n).padStart(6)}`);
  console.log(`    adresses présentes 2 fois +  ${String(recap.adresses_doublees || 0).padStart(6)}`);
  console.log(`    lignes en trop               ${String(recap.lignes_en_trop || 0).padStart(6)}`);

  if (dansSite.length) {
    console.log(`\n  ${R}Doublons DANS un même site — la clé unique ne joue pas son rôle${F}`);
    for (const d of dansSite) console.log(`    site ${d.id_site} · ${d.adresse_ip} · ${d.n} fois`);
  }

  if (entreSites.length) {
    console.log(`\n  ${J}Mêmes adresses réparties sur plusieurs sites${F}`);
    for (const d of entreSites) {
      console.log(`    ${d.adresse_ip.padEnd(16)} ${d.n} lignes sur ${d.nb_sites} site(s)`);
    }
  }

  /* ── 4. Verdict ──────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if ((recap.lignes_en_trop || 0) === 0) {
    console.log(`  ${V}Aucun doublon.${F} Le parc annoncé est le parc réel.`);
  } else if (dansSite.length > 0) {
    console.log(`  ${R}CAUSE B — la clé unique est absente ou inopérante.${F}`);
    console.log("  Chaque scan AJOUTE au lieu de mettre à jour. Le parc");
    console.log("  gonflera indéfiniment. C'est un défaut du produit : il");
    console.log("  se reproduira chez tout client dont la base a été créée");
    console.log("  avant l'ajout de cette clé.");
  } else {
    console.log(`  ${J}CAUSE A — plusieurs sites couvrent la même plage.${F}`);
    console.log("  Les copies sont légitimes du point de vue de la base :");
    console.log("  la clé unique porte sur (site, adresse). Il faut décider");
    console.log("  quel site garder, puis supprimer l'autre.");
    console.log("  Aucun script ne le fera à votre place : supprimer un site");
    console.log("  efface ses équipements, ses relevés et ses alertes.");
  }
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})().catch((err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  process.exit(1);
});
