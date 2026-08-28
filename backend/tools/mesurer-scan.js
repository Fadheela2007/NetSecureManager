/**
 * tools/mesurer-scan.js
 *
 * Mesure la durée réelle d'un scan sur VOTRE réseau, en séquentiel puis
 * en parallèle, et affiche le gain.
 *
 * Pourquoi cet outil existe : je n'ai aucun accès à votre réseau. Les
 * durées que je pourrais annoncer ne seraient que des estimations. Une
 * estimation présentée comme une mesure est un mensonge poli — celle-ci
 * est faite sur vos machines, avec vos délais de réponse.
 *
 * USAGE
 *   cd C:\Users\LENOVO\Documents\NetSecureManager\backend
 *   node tools\mesurer-scan.js 192.168.0.0/23
 *
 * Le scan est lancé DEUX FOIS (une fois en séquentiel, une fois par lots
 * de 5). Comptez le double du temps d'un scan normal. Aucune écriture en
 * base, aucune modification : c'est une mesure, pas un scan de
 * production.
 */

// Chargement du .env par CHEMIN ABSOLU, et non relatif au dossier courant :
// l'outil doit fonctionner qu'on le lance depuis backend/, depuis la racine
// du projet, ou par un raccourci Windows.
// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const { scanRange } = require("../src/services/discoveryService");
const db = require("../src/db");

const cidr = process.argv[2];

if (!cidr || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) {
  console.error("\nUsage :  node tools\\mesurer-scan.js 192.168.0.0/23\n");
  console.error("La plage doit être au format CIDR, par exemple :");
  console.error("  192.168.1.0/24   254 adresses");
  console.error("  192.168.0.0/23   510 adresses\n");
  process.exit(1);
}

const prefixe = Number(cidr.split("/")[1]);
const nbAdresses = Math.max(1, 2 ** (32 - prefixe) - 2);

function duree(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Lance un scan et renvoie { ms, equipements, actifs }. */
async function mesurer(libelle, concurrence) {
  process.env.SCAN_CONCURRENCE = String(concurrence);

  // Le module lit SCAN_CONCURRENCE à chaque appel de scanRange : pas
  // besoin de le recharger.
  console.log(`\n▸ ${libelle}`);
  const debut = Date.now();
  let dernier = 0;

  const equipements = await scanRange({
    cidr,
    onProgress: (etape, courant, total) => {
      if (etape === "balayage") {
        console.log(`   Balayage ping de ${total} adresses...`);
        return;
      }
      const maintenant = Date.now();
      if (courant === total || maintenant - dernier > 3000) {
        dernier = maintenant;
        process.stdout.write(
          `\r   Identification ${courant}/${total} — ${duree(maintenant - debut)} écoulées   `
        );
      }
    },
  });

  const ms = Date.now() - debut;
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  console.log(`   Terminé en ${duree(ms)} — ${equipements.length} équipement(s) trouvé(s)`);
  return { ms, equipements };
}

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  MESURE DE LA DURÉE DE SCAN — ${cidr}`);
  console.log(`  ${nbAdresses} adresses à balayer`);
  console.log("═══════════════════════════════════════════════════════");

  // La base ne sert ici QU'À résoudre les fabricants par adresse MAC —
  // un agrément d'affichage, sans effet sur les durées mesurées. Son
  // absence ne doit donc pas empêcher la mesure : c'est précisément le
  // cas sur une machine d'agent distante, là où l'on veut mesurer.
  const manquantes = db.configurationManquante();
  if (manquantes.length > 0) {
    console.log(`\n  ℹ Base non configurée (${manquantes.join(", ")} absent de backend\\.env).`);
    console.log("    La mesure fonctionne quand même : les durées ne dépendent pas");
    console.log("    de la base. Seuls les noms de fabricants resteront vides.");
  }
  console.log("\n  Deux scans vont être lancés à la suite.");
  console.log("  Le premier (séquentiel) est le plus long : c'est l'ancien");
  console.log("  comportement, gardé comme point de comparaison.\n");

  const sequentiel = await mesurer("1/2  Séquentiel (une machine à la fois)", 1);
  const parallele = await mesurer("2/2  Parallèle (lots de 5)", 5);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  RÉSULTAT");
  console.log("═══════════════════════════════════════════════════════\n");
  console.log(`  Séquentiel  : ${duree(sequentiel.ms)}`);
  console.log(`  Lots de 5   : ${duree(parallele.ms)}`);

  // GARDE-FOU SUR LE RAPPORT DE DURÉES.
  //
  // Sur un scan qui ne trouve rien, les deux durées valoisent quelques
  // dizaines de millisecondes et leur rapport n'a aucun sens : on
  // afficherait « 12,9× plus rapide » pour du bruit de mesure. Un chiffre
  // absurde ici décrédibiliserait toute la mesure — or c'est justement
  // celui qui sert à décider.
  const echantillonSuffisant = sequentiel.equipements.length >= 3 && sequentiel.ms >= 3000;

  if (echantillonSuffisant) {
    const gain = sequentiel.ms / Math.max(1, parallele.ms);
    console.log(`  Gain        : ${gain.toFixed(1)}× plus rapide`);
    console.log(`  Économie    : ${duree(sequentiel.ms - parallele.ms)} par cycle\n`);
  } else {
    console.log(`  Gain        : non mesurable\n`);
    console.log(`  ℹ Échantillon trop petit pour un rapport fiable`);
    console.log(`    (${sequentiel.equipements.length} machine(s) trouvée(s), scan de ${duree(sequentiel.ms)}).`);
    console.log("    La parallélisation ne se voit que s'il y a des machines à");
    console.log("    interroger. Vérifiez la plage : est-ce la bonne ? Les machines");
    console.log("    du réseau répondent-elles au ping ?\n");
  }

  // CONTRÔLE DE NON-RÉGRESSION.
  //
  // Aller cinq fois plus vite ne sert à rien si le scan trouve moins de
  // machines : un délai d'attente dépassé sous la charge parallèle se
  // traduirait par des équipements manquants. C'est le risque principal
  // de ce changement, donc le seul chiffre qui décide vraiment.
  const a = sequentiel.equipements.length;
  const b = parallele.equipements.length;

  if (b >= a) {
    console.log(`  ✓ Même détection : ${b} équipement(s) dans les deux cas.`);
    console.log("    La parallélisation ne fait rien perdre.\n");
  } else {
    console.log(`  ⚠ ATTENTION : ${a} équipement(s) en séquentiel, ${b} en parallèle.`);
    console.log("    Le scan parallèle en a manqué. Baissez la concurrence :");
    console.log("    ajoutez SCAN_CONCURRENCE=3 dans le fichier .env du backend,");
    console.log("    puis relancez cette mesure.\n");

    const manquants = sequentiel.equipements
      .filter((e) => !parallele.equipements.some((p) => p.adresse_ip === e.adresse_ip))
      .map((e) => e.adresse_ip);
    if (manquants.length > 0) {
      console.log(`    Adresses manquées : ${manquants.join(", ")}\n`);
    }
  }

  // Une comparaison des types est utile : un scan plus rapide qui
  // classe moins bien serait aussi une régression, moins visible.
  const typesSeq = {};
  const typesPar = {};
  for (const e of sequentiel.equipements) typesSeq[e.type_detecte] = (typesSeq[e.type_detecte] || 0) + 1;
  for (const e of parallele.equipements) typesPar[e.type_detecte] = (typesPar[e.type_detecte] || 0) + 1;

  const tousTypes = [...new Set([...Object.keys(typesSeq), ...Object.keys(typesPar)])].sort();
  if (tousTypes.length > 0) {
    console.log("  Types identifiés :");
    console.log("    " + "type".padEnd(18) + "séquentiel   parallèle");
    for (const t of tousTypes) {
      const s = typesSeq[t] || 0;
      const p = typesPar[t] || 0;
      const marque = s === p ? " " : "⚠";
      console.log(`    ${t.padEnd(18)}${String(s).padStart(6)}${String(p).padStart(12)}  ${marque}`);
    }
    console.log("");
  }

  process.exit(0);
})().catch((err) => {
  console.error("\nMesure interrompue :", err.message);
  console.error("\nCauses fréquentes :");
  console.error("  • plage CIDR invalide");
  console.error("  • nmap absent (le scan fonctionne, mais sans empreinte TCP/IP)");
  console.error("  • droits insuffisants pour le ping brut sous Windows\n");
  process.exit(1);
});
