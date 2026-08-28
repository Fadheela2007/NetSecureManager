/**
 * tools/diagnostic-noms.js
 * Sur quelques adresses du parc, essaie CHAQUE méthode de nommage et dit
 * laquelle répond. Ne modifie rien.
 *
 *   node tools\diagnostic-noms.js
 *   node tools\diagnostic-noms.js 192.168.0.8 192.168.0.50
 *
 * POURQUOI CET OUTIL. La colonne « nom » peut rester vide pour trois
 * raisons complètement différentes — SNMP absent, DNS inverse non
 * renseigné, NetBIOS filtré — qui appellent trois réponses opposées.
 * Deviner coûte plus cher que mesurer.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const dns = require("dns").promises;
const db = require("../src/db");
const { nomNetbios, nomMdns } = require("../src/services/nomService");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[90m", F = "\x1b[0m";

async function dnsInverse(ip) {
  try {
    const noms = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error("délai")), 2000)),
    ]);
    return noms && noms[0] ? noms[0] : null;
  } catch (err) {
    return null;
  }
}

(async () => {
  let ips = process.argv.slice(2);

  if (ips.length === 0) {
    const [lignes] = await db.query(
      `SELECT adresse_ip, nom, sys_descr FROM EQUIPEMENT
       WHERE statut = 'up' ORDER BY INET_ATON(adresse_ip) LIMIT 12`
    );
    if (lignes.length === 0) {
      console.error("Aucun équipement en ligne. Lancez un scan, ou passez des adresses en argument.");
      process.exit(1);
    }
    ips = lignes.map((l) => l.adresse_ip);
    console.log(`\n${G}12 premiers équipements en ligne du parc.${F}`);
  }

  console.log("\nMéthodes testées sur chaque adresse :");
  console.log(`  ${G}DNS   — résolution inverse (le serveur DHCP enregistre-t-il ses baux ?)${F}`);
  console.log(`  ${G}NBT   — NetBIOS, port 137/UDP (nom que le poste Windows annonce)${F}`);
  console.log(`  ${G}MDNS  — mDNS, port 5353/UDP (caméras, imprimantes, Apple, Android)${F}\n`);

  const resultats = [];
  for (const ip of ips) {
    const [rdns, nbt, mdns] = await Promise.all([
      dnsInverse(ip),
      nomNetbios(ip),
      nomMdns(ip),
    ]);
    resultats.push({ ip, rdns, nbt, mdns });
    const aff = (v, l) => (v ? `${V}${v}${F}` : `${R}—${F}`).padEnd(l + 9);
    console.log(
      `  ${ip.padEnd(16)} DNS ${aff(rdns, 18)} NBT ${aff(nbt, 18)} MDNS ${aff(mdns, 0)}`
    );
  }

  const total = resultats.length;
  const nbDns = resultats.filter((r) => r.rdns).length;
  const nbNbt = resultats.filter((r) => r.nbt).length;
  const nbMdns = resultats.filter((r) => r.mdns).length;
  const nomme = resultats.filter((r) => r.rdns || r.nbt || r.mdns).length;

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  DNS inverse : ${nbDns}/${total}`);
  console.log(`  NetBIOS     : ${nbNbt}/${total}`);
  console.log(`  mDNS        : ${nbMdns}/${total}`);
  console.log(`  ${V}Nommés au total : ${nomme}/${total}${F}`);
  console.log(`  Sans nom        : ${total - nomme}/${total}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // Ce que le mDNS apporte SEUL, c'est-à-dire les équipements qu'aucune
  // autre méthode n'aurait nommés. C'est la mesure qui compte : un
  // équipement déjà nommé par NetBIOS ne gagne rien à répondre aussi
  // en mDNS.
  const apportMdns = resultats.filter((r) => r.mdns && !r.rdns && !r.nbt).length;
  if (apportMdns > 0) {
    console.log(`Le mDNS nomme à lui seul ${apportMdns} équipement(s) qu'aucune`);
    console.log("autre méthode n'aurait identifié.\n");
  }

  if (nomme === 0) {
    console.log("Aucune méthode ne répond. Deux explications possibles :");
    console.log("  • le pare-feu des postes bloque les ports 137 et 5353 ;");
    console.log("  • ce sont des équipements sans nom (sondes, modules, capteurs).");
    console.log("\nDans ce cas la colonne restera vide — ce n'est pas un défaut de");
    console.log("la plateforme mais une caractéristique de ce réseau.\n");
  } else if (nbDns === 0) {
    console.log("Le DNS n'enregistre pas les baux sur ce réseau : les noms");
    console.log("viennent de ce que les équipements annoncent eux-mêmes.\n");
  }

  process.exit(0);
})().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
