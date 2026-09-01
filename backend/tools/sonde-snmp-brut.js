/**
 * tools/sonde-snmp-brut.js
 * Interroge un équipement en SNMP SANS filet, et montre l'erreur exacte.
 *
 *   node tools\sonde-snmp-brut.js 192.168.0.239
 *   node tools\sonde-snmp-brut.js 192.168.0.239 macommunaute
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI
 *
 * La lecture SNMP dans discoveryService renvoie un objet vide dans TOUS
 * les cas d'échec : refus, délai dépassé, version de protocole
 * incompatible, table absente. C'est volontaire — un équipement muet ne
 * doit pas faire échouer un scan — mais cela rend l'échec indiagnostiquable.
 *
 * Cet outil fait les mêmes appels en laissant remonter l'erreur, et
 * essaie les DEUX versions du protocole.
 *
 * CE QUE CET OUTIL A TROUVÉ, LE 31 AOÛT 2026
 *
 * Sur une imprimante HP : le parcours d'une COLONNE rendait 0 ligne, le
 * parcours de la TABLE en rendait 4, et le parcours BRUT de la même
 * colonne en rendait 4 également — LOOPBACK, Ethernet, wifi0, wifiUAP.
 * Identique en v1 et en v2c.
 *
 * L'équipement répondait donc parfaitement : c'est notre lecture qui
 * était fausse. `session.table()` attend l'identifiant d'une TABLE ; nous
 * lui passions celui d'une COLONNE. Corrigé depuis, par un parcours brut
 * indexé (voir snmpColonne dans discoveryService).
 *
 * Cet outil reste utile pour distinguer un équipement muet d'une
 * mauvaise communauté sur un nouveau parc.
 *
 * CE QUE LA COMPARAISON v1 / v2c APPREND
 *
 * La session est créée sans préciser de version : la bibliothèque
 * retient alors SNMPv1. Or beaucoup d'équipements récents acceptent une
 * simple lecture en v1 — ce qui suffit à obtenir le fabricant — mais
 * refusent les PARCOURS de table, réservés à v2c.
 *
 * Si v2c répond là où v1 échoue, la correction est d'une ligne, et elle
 * débloque toute la mesure de bande passante.
 * ─────────────────────────────────────────────────────────────────────
 */
const snmp = require("net-snmp");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const ip = process.argv[2];
const communaute = process.argv[3] || "public";
if (!ip) {
  console.error("\nUsage : node tools\\sonde-snmp-brut.js <adresse-ip> [communaute]\n");
  process.exit(1);
}

const OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const OID_IF_DESCR = "1.3.6.1.2.1.2.2.1.2";   // colonne « nom d'interface »
const OID_IF_IN = "1.3.6.1.2.1.2.2.1.10";     // colonne « octets reçus »
const OID_IF_TABLE = "1.3.6.1.2.1.2.2";       // LA TABLE elle-même

function lireUnique(version, oid) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, communaute, { timeout: 3000, retries: 0, version });
    session.on("error", (e) => resolve({ erreur: e.message }));
    session.get([oid], (err, vb) => {
      session.close();
      if (err) return resolve({ erreur: err.message });
      if (!vb || !vb[0] || snmp.isVarbindError(vb[0])) {
        return resolve({ erreur: "varbind en erreur" });
      }
      resolve({ valeur: vb[0].value.toString().slice(0, 60) });
    });
  });
}

function parcourir(version, oid) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, communaute, { timeout: 3000, retries: 1, version });
    session.on("error", (e) => resolve({ erreur: e.message }));
    session.table(oid, 20, (err, table) => {
      session.close();
      if (err) return resolve({ erreur: err.message });
      resolve({ lignes: Object.keys(table || {}).length, table });
    });
  });
}

/**
 * Parcours BRUT : `subtree` remonte les paires identifiant/valeur telles
 * quelles, sans tenter de les organiser en tableau. C'est la vérité de
 * terrain — si des valeurs remontent ici alors que `table()` n'en rend
 * aucune, le défaut est dans notre façon d'appeler `table()`, pas dans
 * l'équipement.
 */
function parcoursBrut(version, oid, limite = 8) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, communaute, { timeout: 4000, retries: 1, version });
    const vus = [];
    session.on("error", (e) => resolve({ erreur: e.message, vus }));
    session.subtree(
      oid,
      20,
      (varbinds) => {
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          if (vus.length < limite) vus.push(`${vb.oid} = ${String(vb.value).slice(0, 28)}`);
        }
      },
      (err) => {
        session.close();
        resolve({ erreur: err ? err.message : null, vus });
      }
    );
  });
}

const nomVersion = (v) => (v === snmp.Version1 ? "v1 " : "v2c");

(async () => {
  console.log(`\n  ${J}${ip}${F}  communauté « ${communaute} »\n`);

  for (const version of [snmp.Version1, snmp.Version2c]) {
    console.log(`  ─── SNMP ${nomVersion(version)} ───`);

    const descr = await lireUnique(version, OID_SYS_DESCR);
    console.log(
      `    lecture simple (sysDescr)  ` +
        (descr.erreur ? `${R}${descr.erreur}${F}` : `${V}${descr.valeur}${F}`)
    );

    for (const [libelle, oid] of [["noms d'interfaces", OID_IF_DESCR], ["octets reçus", OID_IF_IN]]) {
      const r = await parcourir(version, oid);
      console.log(
        `    parcours ${libelle.padEnd(18)} ` +
          (r.erreur ? `${R}${r.erreur}${F}` : `${V}${r.lignes} ligne(s)${F}`)
      );
      // Un aperçu des valeurs vaut mieux qu'un simple compte.
      if (!r.erreur && r.lignes > 0 && oid === OID_IF_DESCR) {
        for (const [idx, colonnes] of Object.entries(r.table).slice(0, 6)) {
          const v = Object.values(colonnes)[0];
          console.log(`      ${G}index ${idx} : ${v}${F}`);
        }
      }
    }
    // Décisif : la TABLE au lieu de la colonne.
    const parTable = await parcourir(version, OID_IF_TABLE);
    console.log(
      `    parcours ${"TABLE ifTable".padEnd(18)} ` +
        (parTable.erreur ? `${R}${parTable.erreur}${F}` : `${V}${parTable.lignes} ligne(s)${F}`)
    );

    // Vérité de terrain : les paires brutes, sans mise en forme.
    const brut = await parcoursBrut(version, OID_IF_DESCR);
    console.log(
      `    parcours ${"BRUT (subtree)".padEnd(18)} ` +
        (brut.erreur ? `${R}${brut.erreur}${F}` : `${V}${brut.vus.length} valeur(s)${F}`)
    );
    for (const v of brut.vus) console.log(`      ${G}${v}${F}`);

    console.log("");
  }

  console.log("───────────────────────────────────────────────────────");
  console.log("  Si les parcours réussissent en v2c mais pas en v1, la");
  console.log("  correction consiste à créer les sessions en v2c.");
  console.log("  S'ils échouent dans les deux, l'équipement n'expose pas");
  console.log("  sa table d'interfaces et rien ne peut le forcer.");
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(0);
})();
