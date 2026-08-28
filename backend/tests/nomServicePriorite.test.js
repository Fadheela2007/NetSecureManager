/**
 * tests/nomServicePriorite.test.js
 * Arbitrage entre sources de noms.
 *
 * `choisirNom` est une fonction pure : elle reçoit les réponses des
 * quatre sources et rend son verdict, sans réseau. C'est la partie qui
 * peut se tromper silencieusement — un mauvais arbitrage donne un nom
 * plausible mais faux, ce qu'aucune inspection visuelle ne rattrape.
 */
const test = require("node:test");
const assert = require("node:assert");
const { choisirNom } = require("../src/services/nomService");

test("SNMP l'emporte sur toutes les sources réseau", () => {
  assert.deepStrictEqual(
    choisirNom({ snmp: "SRV-FICHIERS", dns: "par-dns", netbios: "par-nbt", mdns: "par-mdns" }),
    { nom: "SRV-FICHIERS", source: "snmp" }
  );
});

test("un sysName vide ne compte pas comme un nom", () => {
  // Un équipement SNMP mal configuré renvoie une chaîne d'espaces. La
  // retenir donnerait un nom vide en base — indistinguable d'une
  // absence, mais échappant aux replis qui auraient trouvé mieux.
  assert.deepStrictEqual(choisirNom({ snmp: "   ", netbios: "PC-REEL" }), {
    nom: "PC-REEL",
    source: "netbios",
  });
});

test("le DNS l'emporte sur NetBIOS et mDNS", () => {
  // Un nom enregistré au DNS a été posé par l'administrateur du réseau :
  // il porte une intention, là où les autres sont auto-générés.
  assert.deepStrictEqual(
    choisirNom({ dns: "srv-comptabilite", netbios: "SRV-COMPTA", mdns: "SRV-COMPTABILITE-01" }),
    { nom: "srv-comptabilite", source: "dns" }
  );
});

test("aucune source disponible ne produit jamais de nom inventé", () => {
  assert.deepStrictEqual(choisirNom({}), { nom: null, source: null });
  assert.deepStrictEqual(choisirNom(), { nom: null, source: null });
});

/* ---------------------------------------------------------------------
   Troncature NetBIOS.

   Constaté sur le parc : NetBIOS « HP694AA2 » quand le mDNS annonçait
   « HPA8B13B694AA2 » pour la même imprimante. NetBIOS plafonne à 15
   caractères — c'est une limite du protocole, pas de l'appareil.
   --------------------------------------------------------------------- */

test("le mDNS l'emporte quand il prolonge le nom NetBIOS", () => {
  assert.deepStrictEqual(
    choisirNom({ netbios: "IMPRIMANTE-COMP", mdns: "IMPRIMANTE-COMPTABILITE" }),
    { nom: "IMPRIMANTE-COMPTABILITE", source: "mdns" }
  );
});

test("le prolongement est reconnu quelle que soit la casse", () => {
  assert.strictEqual(
    choisirNom({ netbios: "HPA8B13B", mdns: "hpa8b13b694aa2" }).source,
    "mdns"
  );
});

test("deux noms DIFFÉRENTS ne se substituent jamais l'un à l'autre", () => {
  // Le cas dangereux : sans condition de préfixe, on remplacerait un nom
  // correct par celui d'un appareil voisin, plus long par hasard.
  assert.deepStrictEqual(
    choisirNom({ netbios: "DESKTOP-A89OVC3", mdns: "AUTRE-MACHINE-PLUS-LONGUE" }),
    { nom: "DESKTOP-A89OVC3", source: "netbios" }
  );
});

test("un mDNS plus court ne remplace pas le NetBIOS", () => {
  assert.strictEqual(
    choisirNom({ netbios: "DESKTOP-A89OVC3", mdns: "DESKTOP" }).nom,
    "DESKTOP-A89OVC3"
  );
});

test("deux noms identiques ne déclenchent pas de remplacement", () => {
  // Cas le plus fréquent sur le parc : les deux protocoles s'accordent.
  assert.deepStrictEqual(choisirNom({ netbios: "KMBFD6FC", mdns: "KMBFD6FC" }), {
    nom: "KMBFD6FC",
    source: "netbios",
  });
});

test("le mDNS sert de repli quand NetBIOS ne répond pas", () => {
  // Relevé sur le parc : cette imprimante n'était nommée par aucune
  // autre méthode.
  assert.deepStrictEqual(choisirNom({ mdns: "NPI4DDD0A" }), {
    nom: "NPI4DDD0A",
    source: "mdns",
  });
});

test("les noms relevés sur le parc réel sont arbitrés comme attendu", () => {
  // Jeu de données issu de tools\diagnostic-noms.js sur le réseau de
  // l'entreprise : la référence la plus fiable dont on dispose.
  const cas = [
    { entree: { netbios: "KMBFD6FC", mdns: "KMBFD6FC" }, attendu: "KMBFD6FC" },
    { entree: { netbios: "KM287A2C", mdns: "KM287A2C" }, attendu: "KM287A2C" },
    { entree: { netbios: "KM2879F9", mdns: "KM2879F9" }, attendu: "KM2879F9" },
    { entree: { netbios: "HP694AA2", mdns: "HPA8B13B694AA2" }, attendu: "HP694AA2" },
    { entree: { mdns: "NPI4DDD0A" }, attendu: "NPI4DDD0A" },
    { entree: { netbios: "DESKTOP-A89OVC3" }, attendu: "DESKTOP-A89OVC3" },
    { entree: { netbios: "LAPTOP-H0L6ETC6" }, attendu: "LAPTOP-H0L6ETC6" },
    { entree: {}, attendu: null },
  ];
  for (const { entree, attendu } of cas) {
    assert.strictEqual(choisirNom(entree).nom, attendu, JSON.stringify(entree));
  }
});
