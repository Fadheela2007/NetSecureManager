/**
 * tools/sonde-stockage.js
 * Ce que les équipements déclarent VRAIMENT dans leur table de stockage.
 *
 *   node tools\sonde-stockage.js                 (tous les équipements SNMP)
 *   node tools\sonde-stockage.js 192.168.0.42    (un seul)
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUI A DÉCLENCHÉ CET OUTIL
 *
 * Le graphique CPU/RAM d'un équipement affichait « RAM : 0 » sur toute la
 * période, tandis que la courbe processeur, elle, était absente.
 *
 * Cette ASYMÉTRIE est le point de départ. Une absence de mesure se traduit
 * par une courbe manquante — c'est ce que fait le processeur. Une courbe
 * à zéro est autre chose : c'est une AFFIRMATION. Elle dit « cette
 * machine n'utilise aucune mémoire », ce qui n'arrive jamais sur un
 * équipement allumé.
 *
 * DEUX EXPLICATIONS POSSIBLES, ET LA DIFFÉRENCE COMPTE
 *
 *   A. L'équipement déclare réellement 0 octet utilisé. Certains agents
 *      SNMP embarqués publient un compteur qu'ils ne remplissent pas.
 *      Il faudrait alors REFUSER cette valeur plutôt que l'afficher.
 *
 *   B. Nous lisons la mauvaise ligne. La table du stockage mélange
 *      mémoire vive, disques, partitions et caches. Notre règle retient
 *      le premier libellé contenant « physical memory », « real memory »
 *      ou le mot « ram ». Or « RAM disk » contient le mot « ram » — et un
 *      disque en mémoire vide est à 0 %. Nous afficherions alors le
 *      remplissage d'un disque en croyant montrer la mémoire.
 *
 * Cet outil montre la table brute, sans interprétation, et signale la
 * ligne que notre règle retiendrait. C'est la comparaison entre les deux
 * qui tranche.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const snmp = require("net-snmp");
const db = require("../src/db");
const { tauxMemoire } = require("../src/services/discoveryService");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const OID_DESCR = "1.3.6.1.2.1.25.2.3.1.3";
const OID_UNITE = "1.3.6.1.2.1.25.2.3.1.4";
const OID_TAILLE = "1.3.6.1.2.1.25.2.3.1.5";
const OID_UTILISE = "1.3.6.1.2.1.25.2.3.1.6";
const OID_CPU = "1.3.6.1.2.1.25.3.3.1.2";

/** Parcours brut d'une colonne, indexé — même principe que snmpColonne. */
function colonne(ip, communaute, oid, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let session;
    try {
      session = snmp.createSession(ip, communaute, { timeout: timeoutMs, retries: 1 });
    } catch {
      return resolve({});
    }
    const valeurs = {};
    const prefixe = `${oid}.`;
    let fini = false;
    const finir = () => {
      if (fini) return;
      fini = true;
      try { session.close(); } catch { /* déjà fermée */ }
      resolve(valeurs);
    };
    session.on("error", finir);
    try {
      session.subtree(oid, 20, (vbs) => {
        for (const vb of vbs) {
          if (snmp.isVarbindError(vb)) continue;
          const o = String(vb.oid);
          if (o.startsWith(prefixe)) valeurs[o.slice(prefixe.length)] = vb.value;
        }
      }, () => finir());
    } catch {
      finir();
    }
  });
}

async function examiner(ip, communaute, nom) {
  console.log(`\n  ${J}${ip}${F}  ${G}${nom || "—"}${F}`);

  const [descr, unite, taille, utilise, cpu] = await Promise.all([
    colonne(ip, communaute, OID_DESCR),
    colonne(ip, communaute, OID_UNITE),
    colonne(ip, communaute, OID_TAILLE),
    colonne(ip, communaute, OID_UTILISE),
    colonne(ip, communaute, OID_CPU),
  ]);

  const index = Object.keys(descr);
  if (index.length === 0) {
    console.log(`    ${G}aucune table de stockage — normal pour une imprimante${F}`);
  } else {
    console.log(`    ${G}idx  libellé                          unité      taille      utilisé   %${F}`);
    for (const i of index) {
      const t = Number(taille[i]);
      const u = Number(utilise[i]);
      const pct = Number.isFinite(t) && Number.isFinite(u) && t > 0 ? ((u / t) * 100).toFixed(1) : "—";
      console.log(
        `    ${String(i).padStart(3)}  ${String(descr[i]).slice(0, 32).padEnd(32)} ` +
          `${String(unite[i] ?? "—").padStart(6)}  ${String(taille[i] ?? "—").padStart(10)}  ` +
          `${String(utilise[i] ?? "—").padStart(9)}  ${String(pct).padStart(5)}`
      );
    }
  }

  // Ce que NOTRE règle retient, et pourquoi.
  const retenu = tauxMemoire(descr, taille, utilise);
  const ligneRetenue = Object.entries(descr).find(([idx]) => {
    const seul = { [idx]: descr[idx] };
    return tauxMemoire(seul, taille, utilise) !== null;
  });

  if (retenu === null) {
    console.log(`    ${G}→ mémoire : aucune ligne reconnue, la case restera vide${F}`);
  } else {
    const libelle = ligneRetenue ? ligneRetenue[1] : "?";
    const couleur = retenu === 0 ? R : V;
    console.log(`    ${couleur}→ mémoire retenue : ${retenu.toFixed(1)} % via « ${libelle} »${F}`);
    if (retenu === 0) {
      console.log(`    ${R}  Un zéro affiché comme une mesure. Soit l'agent ne remplit${F}`);
      console.log(`    ${R}  pas ce compteur, soit ce n'est pas la mémoire vive.${F}`);
    }
  }

  const nbCpu = Object.keys(cpu).length;
  console.log(`    ${G}→ processeur : ${nbCpu === 0 ? "aucune ligne" : nbCpu + " cœur(s) déclaré(s)"}${F}`);
}

(async () => {
  const ipDemandee = process.argv[2];
  const communaute = process.argv[3] || "public";

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  TABLE DE STOCKAGE — CE QUE DISENT LES ÉQUIPEMENTS");
  console.log("═══════════════════════════════════════════════════════");

  let cibles;
  if (ipDemandee) {
    cibles = [{ adresse_ip: ipDemandee, nom: null }];
  } else {
    // On vise en priorité les équipements dont un relevé annonce 0 % de
    // mémoire : ce sont eux qui posent la question.
    const [rows] = await db.query(
      `SELECT DISTINCT e.adresse_ip, e.nom,
              EXISTS (SELECT 1 FROM RELEVE r
                      WHERE r.id_equipement = e.id_equipement
                        AND r.ram_pourcent = 0) AS ram_a_zero
       FROM EQUIPEMENT e
       WHERE e.sys_descr IS NOT NULL
       ORDER BY ram_a_zero DESC, INET_ATON(e.adresse_ip)`
    );
    cibles = rows;
    const suspects = rows.filter((r) => r.ram_a_zero).length;
    console.log(
      `\n  ${rows.length} équipement(s) SNMP · ` +
        (suspects > 0 ? `${R}${suspects} annonçant 0 % de mémoire${F}` : `${V}aucun à 0 %${F}`)
    );
  }

  for (const c of cibles) {
    await examiner(c.adresse_ip, communaute, c.nom);
  }

  console.log("\n───────────────────────────────────────────────────────");
  console.log("  Une ligne en ROUGE signifie qu'on afficherait 0 % comme");
  console.log("  une mesure. Comparez son libellé avec la table brute :");
  console.log("  si c'est un disque ou un cache, la règle est à corriger.");
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})().catch((err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  process.exit(1);
});
