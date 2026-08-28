/**
 * tests/attributionPort.test.js
 *
 * L'attribution du trafic d'un port de switch à une machine est utile
 * précisément parce qu'elle fonctionne SANS rien installer sur cette
 * machine. C'est aussi ce qui la rend risquée : personne ne peut
 * vérifier le chiffre à la source.
 *
 * Le danger n'est donc pas l'absence de mesure — elle se voit — mais la
 * mesure FAUSSE qui a l'air juste. Un client qui lit « le poste de la
 * comptabilité consomme 400 Mbit/s » alors que c'est le trafic de tout
 * un étage derrière une borne Wi-Fi ne reviendra pas.
 *
 * Ces tests portent donc surtout sur les cas où le service doit REFUSER
 * d'attribuer.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  normaliserMac,
  estMacTechnique,
  construireCorrespondance,
  attribuer,
  choisirSource,
} = require("../src/services/attributionPortService");

// ─────────────────────────────────────────────────────────────────────
// NORMALISATION
// ─────────────────────────────────────────────────────────────────────
test("les écritures d'adresse MAC sont ramenées à une seule forme", () => {
  // Le switch, le scan ARP et la base n'écrivent pas les MAC pareil.
  // Sans normalisation, la correspondance échouerait silencieusement :
  // aucune erreur, simplement aucune machine reconnue.
  const attendu = "a4:bb:6d:01:02:03";
  for (const forme of [
    "a4:bb:6d:01:02:03",
    "A4:BB:6D:01:02:03",
    "a4-bb-6d-01-02-03",
    "a4bb.6d01.0203",
    "A4BB6D010203",
    " a4:bb:6d:01:02:03 ",
  ]) {
    assert.strictEqual(normaliserMac(forme), attendu, `forme : ${forme}`);
  }
});

test("une MAC incomplète ou absurde est rejetée", () => {
  for (const mauvaise of ["", "  ", "a4:bb:6d", "pas une mac", null, undefined, 42, "a4:bb:6d:01:02:03:04"]) {
    assert.strictEqual(normaliserMac(mauvaise), null, `devrait être rejetée : ${mauvaise}`);
  }
});

test("les adresses de diffusion et de multidiffusion sont écartées", () => {
  // Elles ne désignent aucune machine. Les compter ferait passer un port
  // parfaitement attribuable pour un port à plusieurs machines — et on
  // perdrait la mesure sans raison.
  assert.strictEqual(estMacTechnique("ff:ff:ff:ff:ff:ff"), true, "diffusion");
  assert.strictEqual(estMacTechnique("01:00:5e:00:00:fb"), true, "multidiffusion IPv4");
  assert.strictEqual(estMacTechnique("33:33:00:00:00:01"), true, "multidiffusion IPv6");
  assert.strictEqual(estMacTechnique("00:00:00:00:00:00"), true, "adresse nulle");

  // Une vraie machine ne doit pas être écartée.
  assert.strictEqual(estMacTechnique("a4:bb:6d:01:02:03"), false);
  assert.strictEqual(estMacTechnique("02:42:ac:11:00:02"), false, "MAC localement administrée mais réelle");
});

// ─────────────────────────────────────────────────────────────────────
// CORRESPONDANCE PORT ↔ MACHINE
// ─────────────────────────────────────────────────────────────────────
test("un port avec une seule machine est attribuable", () => {
  const c = construireCorrespondance({
    fdb: [{ mac: "a4:bb:6d:01:02:03", portPont: 12 }],
    portVersIfIndex: { 12: 10012 },
  });

  assert.strictEqual(c.size, 1);
  assert.deepStrictEqual(c.get(10012).macs, ["a4:bb:6d:01:02:03"]);
  assert.strictEqual(c.get(10012).attribuable, true);
});

test("un port avec PLUSIEURS machines est refusé, pas deviné", () => {
  // Le cas d'une borne Wi-Fi, d'un switch en cascade ou d'un
  // hyperviseur. Attribuer le total à l'une des machines produirait un
  // chiffre plausible et faux — le pire résultat possible.
  const c = construireCorrespondance({
    fdb: [
      { mac: "a4:bb:6d:01:02:03", portPont: 24 },
      { mac: "a4:bb:6d:01:02:04", portPont: 24 },
      { mac: "a4:bb:6d:01:02:05", portPont: 24 },
    ],
    portVersIfIndex: { 24: 10024 },
  });

  const port = c.get(10024);
  assert.strictEqual(port.attribuable, false);
  assert.strictEqual(port.macs.length, 3);
  assert.match(port.raison, /3 machines/);
});

test("le numéro de port du pont est traduit en ifIndex, jamais utilisé tel quel", () => {
  // Piège classique : la numérotation des ports du pont est
  // indépendante de celle des interfaces. Confondre les deux attribue
  // le trafic du port 3 à une tout autre prise — sans aucune erreur
  // visible.
  const c = construireCorrespondance({
    fdb: [{ mac: "a4:bb:6d:01:02:03", portPont: 3 }],
    portVersIfIndex: { 3: 10103 },
  });

  assert.ok(c.has(10103), "l'entrée doit être indexée par l'ifIndex");
  assert.ok(!c.has(3), "le numéro de port du pont ne doit jamais servir d'index");
});

test("un port sans traduction connue est ignoré", () => {
  // Mieux vaut perdre un port que l'attribuer au hasard.
  const c = construireCorrespondance({
    fdb: [{ mac: "a4:bb:6d:01:02:03", portPont: 7 }],
    portVersIfIndex: {},
  });
  assert.strictEqual(c.size, 0);
});

test("la même MAC vue deux fois sur un port ne la compte qu'une fois", () => {
  // Les switches réapprennent les adresses en permanence : la table
  // contient des doublons. Sans déduplication, un port normal passerait
  // pour un port à plusieurs machines.
  const c = construireCorrespondance({
    fdb: [
      { mac: "a4:bb:6d:01:02:03", portPont: 5 },
      { mac: "A4-BB-6D-01-02-03", portPont: 5 },
    ],
    portVersIfIndex: { 5: 10005 },
  });

  assert.strictEqual(c.get(10005).macs.length, 1);
  assert.strictEqual(c.get(10005).attribuable, true);
});

test("les adresses de diffusion ne font pas basculer un port en « plusieurs machines »", () => {
  const c = construireCorrespondance({
    fdb: [
      { mac: "a4:bb:6d:01:02:03", portPont: 8 },
      { mac: "ff:ff:ff:ff:ff:ff", portPont: 8 },
      { mac: "01:00:5e:00:00:fb", portPont: 8 },
    ],
    portVersIfIndex: { 8: 10008 },
  });

  assert.strictEqual(c.get(10008).attribuable, true, "seule la vraie machine compte");
});

// ─────────────────────────────────────────────────────────────────────
// RATTACHEMENT AU PARC
// ─────────────────────────────────────────────────────────────────────
test("une machine connue est rattachée à son port", () => {
  const c = construireCorrespondance({
    fdb: [{ mac: "a4:bb:6d:01:02:03", portPont: 12 }],
    portVersIfIndex: { 12: 10012 },
  });

  const r = attribuer(c, [
    { id_equipement: 42, adresse_mac: "A4:BB:6D:01:02:03", nom: "PC-COMPTA" },
    { id_equipement: 43, adresse_mac: "00:11:22:33:44:55", nom: "PC-RH" },
  ]);

  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id_equipement, 42);
  assert.strictEqual(r[0].attribuable, true);
});

test("une machine que le switch voit mais que le scan ignore n'est pas attribuée", () => {
  // Elle était éteinte au moment du balayage, ou ne répond ni au ping
  // ni à l'ARP. On garde sa MAC : la prochaine découverte fera le lien
  // sans intervention.
  const c = construireCorrespondance({
    fdb: [{ mac: "de:ad:be:ef:00:01", portPont: 15 }],
    portVersIfIndex: { 15: 10015 },
  });

  const r = attribuer(c, [{ id_equipement: 1, adresse_mac: "a4:bb:6d:01:02:03" }]);

  assert.strictEqual(r[0].id_equipement, null);
  assert.strictEqual(r[0].adresse_mac, "de:ad:be:ef:00:01", "la MAC est conservée");
  assert.strictEqual(r[0].attribuable, false);
  assert.match(r[0].raison, /inconnue du parc/);
});

test("un équipement sans MAC en base ne fait pas échouer le rattachement", () => {
  const c = construireCorrespondance({
    fdb: [{ mac: "a4:bb:6d:01:02:03", portPont: 12 }],
    portVersIfIndex: { 12: 10012 },
  });

  assert.doesNotThrow(() =>
    attribuer(c, [{ id_equipement: 1, adresse_mac: null }, { id_equipement: 2 }])
  );
});

test("un port à plusieurs machines n'est jamais rattaché, même si l'une est connue", () => {
  const c = construireCorrespondance({
    fdb: [
      { mac: "a4:bb:6d:01:02:03", portPont: 24 },
      { mac: "00:11:22:33:44:55", portPont: 24 },
    ],
    portVersIfIndex: { 24: 10024 },
  });

  const r = attribuer(c, [{ id_equipement: 42, adresse_mac: "a4:bb:6d:01:02:03" }]);

  assert.strictEqual(r[0].id_equipement, null, "aucune machine ne doit récupérer le trafic du groupe");
  assert.strictEqual(r[0].nb_mac, 2);
});

// ─────────────────────────────────────────────────────────────────────
// CHOIX DE LA SOURCE
// ─────────────────────────────────────────────────────────────────────
test("le SNMP direct l'emporte sur la mesure par port", () => {
  // L'équipement compte lui-même ce qui traverse SA carte réseau. La
  // mesure du port inclut en plus le trafic de diffusion qu'il subit.
  const r = choisirSource({
    snmpDirect: { trafic_entrant_kbps: 120, trafic_sortant_kbps: 40 },
    parPort: { trafic_entrant_kbps: 135, trafic_sortant_kbps: 45 },
  });

  assert.strictEqual(r.source, "snmp");
  assert.strictEqual(r.trafic_entrant_kbps, 120);
});

test("sans SNMP direct, la mesure par port prend le relais", () => {
  // C'est tout l'objet de ce service : neuf machines sur dix n'exposent
  // pas SNMP et restaient sans mesure.
  const r = choisirSource({
    snmpDirect: null,
    parPort: { trafic_entrant_kbps: 135, trafic_sortant_kbps: 45 },
  });

  assert.strictEqual(r.source, "port");
  assert.strictEqual(r.trafic_entrant_kbps, 135);
});

test("sans aucune source, on renvoie NULL et pas zéro", () => {
  // Zéro se lit « cette machine ne consomme rien ». NULL se lit « on ne
  // sait pas ». Les confondre ferait passer une absence de mesure pour
  // une machine au repos.
  const r = choisirSource({ snmpDirect: null, parPort: null });

  assert.strictEqual(r.source, null);
  assert.strictEqual(r.trafic_entrant_kbps, null);
});

test("un relevé SNMP présent mais vide ne masque pas la mesure par port", () => {
  // Cas réel : l'équipement répond en SNMP mais son compteur n'est pas
  // encore exploitable (premier relevé). La mesure du port doit alors
  // servir, sinon on perdrait l'information pour rien.
  const r = choisirSource({
    snmpDirect: { trafic_entrant_kbps: null, trafic_sortant_kbps: null },
    parPort: { trafic_entrant_kbps: 90, trafic_sortant_kbps: 12 },
  });

  assert.strictEqual(r.source, "port");
  assert.strictEqual(r.trafic_entrant_kbps, 90);
});
