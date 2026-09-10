/**
 * tools/appliquer-migrations.js
 * Applique le schéma puis toutes les migrations, dans l'ordre.
 *
 *   node tools\appliquer-migrations.js --essai     (montre sans rien faire)
 *   node tools\appliquer-migrations.js             (applique réellement)
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * La procédure manuelle demandait d'ouvrir dix fichiers un par un dans
 * Workbench, chacun dans un onglet neuf, en ignorant au passage les
 * erreurs « colonne déjà présente ». Dix occasions de coller au mauvais
 * endroit, d'exécuter un onglet qui contient déjà autre chose, ou de
 * s'arrêter à la première ligne rouge.
 *
 * C'est exactement ce qui s'est produit : des ALTER TABLE recopiés dans
 * un onglet mélangé, jamais exécutés, et une base restée à l'état
 * initial pendant qu'on cherchait la panne ailleurs.
 *
 * Cet outil fait la même chose, dans le bon ordre, sans intervention.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QU'IL NE FAIT PAS
 *
 * Il n'exécute AUCUN DROP, ne supprime aucune donnée, ne renomme aucune
 * colonne. Les fichiers de migration eux-mêmes n'en contiennent pas —
 * c'est une règle du projet — et l'outil refuse d'exécuter une
 * instruction destructrice s'il en rencontrait une.
 * ─────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

const ESSAI = process.argv.includes("--essai");
const RACINE = path.join(__dirname, "..");

/**
 * Erreurs qui signifient « c'était déjà fait ».
 *
 * Une migration doit pouvoir être rejouée sans dommage. Ces codes
 * disent tous la même chose : l'objet existe déjà. Les traiter comme
 * des échecs arrêterait la procédure au premier fichier déjà passé.
 */
const DEJA_FAIT = new Set([
  1050, // table déjà existante
  1060, // colonne déjà existante
  1061, // index déjà existant
  1826, // clé étrangère de même nom
  1022, // clé dupliquée
  1091, // rien à supprimer
]);

/** Instructions qu'on refuse d'exécuter, quoi qu'il arrive. */
const INTERDIT = /^\s*(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE|DELETE\s+FROM)\b/i;

/**
 * Découpe un fichier SQL en instructions.
 *
 * Les commentaires sont retirés AVANT le découpage : nos fichiers en
 * contiennent beaucoup, et plusieurs incluent des points-virgules dans
 * des exemples commentés (« -- DROP TABLE X; »). Découper d'abord
 * produirait des fragments invalides — et, pire, exécuterait des
 * exemples qu'on avait justement commentés.
 */
function decouper(sql) {
  // ── POURQUOI UN PARCOURS CARACTÈRE PAR CARACTÈRE ──
  //
  // La première version retirait les commentaires ligne à ligne puis
  // découpait sur « ; ». Elle cassait sur ce genre de ligne, bien
  // présente dans nos migrations :
  //
  //   'Jour d''envoi — hebdomadaire : 1=lundi à 7=dimanche ; mensuel : 1 à 28'
  //
  // Le point-virgule est DANS la chaîne. Le découpage produisait deux
  // fragments invalides, dont l'un commençait par « mensuel » — du texte
  // envoyé à MySQL comme une instruction.
  //
  // Détecté par un contrôle qui vérifiait que chaque instruction commence
  // par un mot-clé SQL. Sans lui, l'erreur ne serait apparue qu'à
  // l'exécution, sur la base du client.
  //
  // Le parcours ci-dessous suit l'état réel du texte : dans une chaîne,
  // dans un commentaire de ligne, dans un commentaire de bloc, ou dans du
  // code. On ne coupe que dans le dernier cas.
  const instructions = [];
  let courante = "";
  let dansChaine = null; // ' ou " quand on est dans une chaîne
  let dansCommentaireLigne = false;
  let dansCommentaireBloc = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const suivant = sql[i + 1];

    if (dansCommentaireLigne) {
      if (c === "\n") {
        dansCommentaireLigne = false;
        courante += c;
      }
      continue;
    }

    if (dansCommentaireBloc) {
      if (c === "*" && suivant === "/") {
        dansCommentaireBloc = false;
        i++;
      }
      continue;
    }

    if (dansChaine) {
      courante += c;
      if (c === "\\") {
        // Échappement antislash : le caractère suivant est littéral.
        courante += suivant ?? "";
        i++;
      } else if (c === dansChaine) {
        // Deux quotes de suite = une quote littérale, on reste dedans.
        if (suivant === dansChaine) {
          courante += suivant;
          i++;
        } else {
          dansChaine = null;
        }
      }
      continue;
    }

    // Hors chaîne et hors commentaire : les débuts de commentaire comptent.
    if (c === "-" && suivant === "-") {
      dansCommentaireLigne = true;
      i++;
      continue;
    }
    if (c === "/" && suivant === "*") {
      dansCommentaireBloc = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      dansChaine = c;
      courante += c;
      continue;
    }
    if (c === ";") {
      const t = courante.trim();
      if (t) instructions.push(t);
      courante = "";
      continue;
    }
    courante += c;
  }

  const reste = courante.trim();
  if (reste) instructions.push(reste);
  return instructions;
}

/** Le schéma d'abord, puis les migrations par ordre chronologique. */
function fichiers() {
  const liste = [{ nom: "schema.sql", chemin: path.join(RACINE, "schema.sql") }];

  const dossier = path.join(RACINE, "migrations");
  if (fs.existsSync(dossier)) {
    for (const f of fs.readdirSync(dossier).filter((f) => f.endsWith(".sql")).sort()) {
      liste.push({ nom: f, chemin: path.join(dossier, f) });
    }
  }
  return liste;
}

(async () => {
  const [[ctx]] = await db.query("SELECT DATABASE() AS base, @@hostname AS serveur");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(ESSAI ? "  ESSAI — aucune modification ne sera faite" : "  APPLICATION DES MIGRATIONS");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Base    : ${ctx.base}`);
  console.log(`  Serveur : ${ctx.serveur}  (${process.env.DB_HOST})`);
  console.log("");

  /**
   * ── POURQUOI DEUX PASSES ──
   *
   * Les fichiers s'exécutent dans l'ordre des dates. Or une migration
   * tardive peut ajouter une colonne dont un fichier ANTÉRIEUR a besoin.
   *
   * Cas réel : `CONFIGURATION.description` manquait dans la base. Les
   * INSERT de `schema.sql` et de `types-coherents` échouaient donc, et la
   * migration qui ajoute cette colonne — datée plus tard — ne s'exécutait
   * qu'après eux. Un seul passage laissait le référentiel des types vide,
   * donc TOUT équipement classé « inconnu ».
   *
   * Les migrations étant rejouables sans dommage — les erreurs « déjà
   * fait » sont ignorées — une seconde passe règle ces dépendances
   * croisées sans qu'on ait à réordonner les fichiers à la main.
   *
   * On ne la déclenche que s'il reste des erreurs : sur une base saine,
   * rien ne change et la sortie reste identique.
   */
  async function passe(silencieuse) {
    const bilan = { executees: 0, dejaFaites: 0, echecs: [] };

    for (const f of fichiers()) {
      if (!fs.existsSync(f.chemin)) {
        if (!silencieuse) console.log(`  ⚠ ${f.nom} — introuvable, ignoré`);
        continue;
      }

      const instructions = decouper(fs.readFileSync(f.chemin, "utf8"));
      let executees = 0;
      let dejaFaites = 0;
      const erreurs = [];

      for (const sql of instructions) {
        if (INTERDIT.test(sql)) {
          erreurs.push(`instruction destructrice refusée : ${sql.slice(0, 60)}…`);
          continue;
        }
        // `USE` est inutile : la connexion pointe déjà sur la bonne base,
        // et l'exécuter permettrait à un fichier de basculer ailleurs.
        if (/^\s*USE\b/i.test(sql)) continue;

        if (ESSAI) {
          executees++;
          continue;
        }

        try {
          await db.query(sql);
          executees++;
        } catch (err) {
          if (DEJA_FAIT.has(err.errno)) {
            dejaFaites++;
            continue;
          }
          erreurs.push(`${err.errno} — ${err.message.slice(0, 110)}`);
        }
      }

      bilan.executees += executees;
      bilan.dejaFaites += dejaFaites;

      if (!silencieuse) {
        const etat = erreurs.length === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
        console.log(
          `  ${etat} ${f.nom.padEnd(46)} ${executees} exécutée(s)` +
            (dejaFaites ? `, ${dejaFaites} déjà faite(s)` : "")
        );
        for (const e of erreurs) console.log(`      \x1b[31m${e}\x1b[0m`);
      }
      for (const e of erreurs) bilan.echecs.push({ fichier: f.nom, erreur: e });
    }
    return bilan;
  }

  let bilan = await passe(false);
  let totalExecutees = bilan.executees;
  let totalDejaFaites = bilan.dejaFaites;
  let echecs = bilan.echecs;

  if (echecs.length > 0 && !ESSAI) {
    console.log("\n  Des instructions ont échoué. Seconde passe : une migration");
    console.log("  tardive vient peut-être d'ajouter ce qui leur manquait.\n");

    bilan = await passe(false);
    totalExecutees += bilan.executees;
    totalDejaFaites += bilan.dejaFaites;
    echecs = bilan.echecs; // seules les erreurs QUI PERSISTENT comptent
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  ${totalExecutees} instruction(s) exécutée(s), ${totalDejaFaites} déjà en place`);

  if (echecs.length > 0) {
    console.log(`\n  \x1b[31m${echecs.length} erreur(s) — à me transmettre telles quelles.\x1b[0m`);
    console.log("  Les instructions suivantes ont quand même été tentées :");
    console.log("  une erreur isolée n'arrête pas la procédure.\n");
    process.exit(1);
  }

  if (ESSAI) {
    console.log("\n  Essai terminé, rien n'a été modifié.");
    console.log("  Pour appliquer réellement :  node tools\\appliquer-migrations.js\n");
  } else {
    console.log("\n  \x1b[32mTerminé.\x1b[0m Contrôlez avec :");
    console.log("    node tools\\etat-migrations.js");
    console.log("\n  Puis redémarrez le backend et lancez un scan.\n");
  }
  process.exit(0);
})().catch((err) => {
  console.error("\nApplication interrompue :", err.message);
  if (/ECONNREFUSED/.test(err.message)) {
    console.error("MySQL ne répond pas. Le service est-il démarré ?\n");
  } else if (/Unknown database/.test(err.message)) {
    console.error(`\nLa base « ${process.env.DB_NAME} » n'existe pas sur ce serveur.`);
    console.error("Créez-la d'abord dans Workbench :");
    console.error(`  CREATE DATABASE ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`);
  }
  process.exit(2);
});
