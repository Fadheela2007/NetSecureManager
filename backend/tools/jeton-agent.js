/**
 * tools/jeton-agent.js
 * Affiche le jeton d'agent de chaque site, et la commande à lancer.
 *
 *   node tools\jeton-agent.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL PLUTÔT QU'UNE REQUÊTE SQL
 *
 * La documentation demandait d'ouvrir MySQL et de taper
 * « SELECT id_site, nom, agent_token FROM SITE; ». Ça marche, mais ça
 * suppose de savoir se connecter à la base, et ça recopie à la main une
 * chaîne de plusieurs dizaines de caractères — la moindre coquille
 * donnant un « Jeton refusé » qu'on met dix minutes à comprendre.
 *
 * Cet outil rend la commande COMPLÈTE, prête à copier.
 *
 * ATTENTION : LE JETON EST UN SECRET.
 *
 * Il donne à qui le détient le droit de pousser des données au nom du
 * site : équipements, relevés, alertes. Il ne doit jamais être collé
 * dans un ticket, un courriel, une capture d'écran publiée, ni bien sûr
 * dans le dépôt. C'est pourquoi l'affichage le rappelle à chaque fois.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const path = require("path");
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

(async () => {
  const [sites] = await db.query(
    `SELECT id_site, nom, ville, agent_token, dernier_push
     FROM SITE ORDER BY id_site`
  );

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  JETONS D'AGENT");
  console.log("═══════════════════════════════════════════════════════");

  if (sites.length === 0) {
    console.log(`\n  ${R}Aucun site déclaré.${F} Créez-en un depuis la page Sites.\n`);
    process.exit(0);
  }

  // Chemin du script d'agent, tel que WSL le voit. Le dossier du projet
  // est sous C:\ ; dans WSL il devient /mnt/c/…, et les antislashs des
  // chemins Windows deviennent des barres obliques.
  const racine = path.resolve(__dirname, "..", "..");
  const cheminWsl =
    "/mnt/" +
    racine.charAt(0).toLowerCase() +
    racine.slice(2).split(path.sep).join("/") +
    "/backend/src/agent/lancer-agent-wsl.sh";

  for (const s of sites) {
    console.log(`\n  ${J}Site ${s.id_site} — ${s.nom} (${s.ville})${F}`);
    console.log(
      `  ${G}dernière livraison :${F} ` +
        (s.dernier_push ? new Date(s.dernier_push).toLocaleString("fr-FR") : `${G}jamais${F}`)
    );

    if (!s.agent_token) {
      console.log(`  ${R}Aucun jeton.${F} Générez-le depuis la page Sites de la plateforme.`);
      continue;
    }

    console.log(`\n  ${G}Commande à coller dans Ubuntu :${F}`);
    console.log(`  ${V}sudo bash ${cheminWsl} ${s.id_site} ${s.agent_token}${F}`);
  }

  console.log("\n───────────────────────────────────────────────────────");
  console.log(`  ${R}Ce jeton est un mot de passe.${F} Il autorise à écrire au nom`);
  console.log("  du site. Ne le publiez nulle part : ni capture d'écran, ni");
  console.log("  message, ni dépôt de code.");
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})().catch((err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  process.exit(1);
});
