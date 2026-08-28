/**
 * tests/conflitIp.test.js
 * Détection des conflits d'adresses IP.
 *
 * L'enjeu de ces tests n'est pas de trouver les conflits — c'est de NE
 * PAS en inventer. Un outil qui signale des conflits inexistants est
 * abandonné en trois jours, et emporte avec lui la crédibilité des
 * alertes qui, elles, sont justes.
 */
const test = require("node:test");
const assert = require("node:assert");

const { detecterConflits, decrireConflit } = require("../src/services/conflitIpService");

const eq = (ip, mac, extra = {}) => ({
  id_equipement: ip,
  adresse_ip: ip,
  adresse_mac: mac,
  ...extra,
});

test("deux adresses partageant une carte réseau sont signalées", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "a4:bb:6d:01:02:03"),
    eq("192.168.0.11", "a4:bb:6d:01:02:03"),
    eq("192.168.0.12", "b8:27:eb:aa:bb:cc"),
  ]);
  assert.strictEqual(conflits.length, 1);
  assert.deepStrictEqual(conflits[0].adresses, ["192.168.0.10", "192.168.0.11"]);
});

test("un parc sain ne produit aucun signalement", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "a4:bb:6d:01:02:03"),
    eq("192.168.0.11", "b8:27:eb:aa:bb:cc"),
    eq("192.168.0.12", "00:1a:2b:3c:4d:5e"),
  ]);
  assert.deepStrictEqual(conflits, []);
});

/* ---------------------------------------------------------------------
   Le faux positif principal : la passerelle.
   --------------------------------------------------------------------- */

test("une passerelle répondant pour tout un sous-réseau n'est PAS un conflit", () => {
  // Scanné au-delà d'une frontière de sous-réseau, le routeur répond à
  // la place de chaque machine : son adresse matérielle apparaît sur des
  // dizaines d'adresses. C'est du routage normal.
  //
  // Sans ce filtre, un scan inter-sous-réseaux produirait une alerte par
  // machine du parc, toutes fausses.
  const parc = [];
  for (let i = 1; i <= 40; i++) {
    parc.push(eq(`192.168.5.${i}`, "00:11:22:33:44:55"));
  }
  assert.deepStrictEqual(detecterConflits(parc), []);
});

test("le seuil sépare la machine multi-adressée du routeur", () => {
  const trois = [
    eq("192.168.0.10", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.11", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.12", "aa:bb:cc:dd:ee:01"),
  ];
  assert.strictEqual(detecterConflits(trois).length, 1, "trois adresses : encore plausible");

  const quatre = [...trois, eq("192.168.0.13", "aa:bb:cc:dd:ee:01")];
  assert.strictEqual(detecterConflits(quatre).length, 0, "quatre : plutôt du routage");
});

/* ---------------------------------------------------------------------
   Les autres sources de faux positifs.
   --------------------------------------------------------------------- */

test("les adresses matérielles aléatoires sont ignorées", () => {
  // Téléphones et portables modernes en changent à chaque réseau pour
  // préserver la vie privée. Un même appareil en change entre deux
  // scans : les inclure produirait des conflits que personne ne pourrait
  // reproduire.
  const conflits = detecterConflits([
    eq("192.168.0.10", "a4:bb:6d:01:02:03", { mac_aleatoire: true }),
    eq("192.168.0.11", "a4:bb:6d:01:02:03", { mac_aleatoire: true }),
  ]);
  assert.deepStrictEqual(conflits, []);
});

test("les équipements sans adresse matérielle sont ignorés", () => {
  // Deux machines dont la MAC est inconnue ne partagent rien : elles
  // manquent toutes deux d'information. Les regrouper créerait un
  // conflit à partir de deux absences.
  const conflits = detecterConflits([
    eq("192.168.0.10", null),
    eq("192.168.0.11", null),
    eq("192.168.0.12", ""),
    eq("192.168.0.13", undefined),
  ]);
  assert.deepStrictEqual(conflits, []);
});

test("les adresses de diffusion et nulles sont ignorées", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "ff:ff:ff:ff:ff:ff"),
    eq("192.168.0.11", "ff:ff:ff:ff:ff:ff"),
    eq("192.168.0.20", "00:00:00:00:00:00"),
    eq("192.168.0.21", "00:00:00:00:00:00"),
    eq("192.168.0.30", "01:00:5e:00:00:fb"), // multidiffusion
    eq("192.168.0.31", "01:00:5e:00:00:fb"),
  ]);
  assert.deepStrictEqual(conflits, []);
});

test("les formats d'écriture différents désignent la même carte", () => {
  // Une même adresse peut arriver en tirets, en majuscules ou sans
  // séparateur selon la source (table ARP Windows, SNMP, nmap). Sans
  // normalisation, le conflit passerait inaperçu.
  const conflits = detecterConflits([
    eq("192.168.0.10", "A4-BB-6D-01-02-03"),
    eq("192.168.0.11", "a4bb6d010203"),
  ]);
  assert.strictEqual(conflits.length, 1);
  assert.strictEqual(conflits[0].adresse_mac, "a4:bb:6d:01:02:03");
});

test("une adresse matérielle mal formée est écartée", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "pas-une-adresse"),
    eq("192.168.0.11", "pas-une-adresse"),
  ]);
  assert.deepStrictEqual(conflits, []);
});

/* ---------------------------------------------------------------------
   Robustesse et présentation.
   --------------------------------------------------------------------- */

test("une entrée vide ou absente ne fait pas tomber la détection", () => {
  assert.doesNotThrow(() => {
    detecterConflits([]);
    detecterConflits(null);
    detecterConflits(undefined);
    detecterConflits([null, undefined, {}]);
  });
  assert.deepStrictEqual(detecterConflits(null), []);
});

test("les adresses sont triées par valeur numérique", () => {
  // « .9 » avant « .10 » : un tri alphabétique donnerait l'inverse et
  // rendrait le message déroutant.
  const conflits = detecterConflits([
    eq("192.168.0.10", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.9", "aa:bb:cc:dd:ee:01"),
  ]);
  assert.deepStrictEqual(conflits[0].adresses, ["192.168.0.9", "192.168.0.10"]);
});

test("plusieurs conflits distincts sont tous rapportés", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.11", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.20", "aa:bb:cc:dd:ee:02"),
    eq("192.168.0.21", "aa:bb:cc:dd:ee:02"),
    eq("192.168.0.22", "aa:bb:cc:dd:ee:02"),
  ]);
  assert.strictEqual(conflits.length, 2);
  // Le plus de machines concernées en premier.
  assert.strictEqual(conflits[0].adresses.length, 3);
});

test("le message reste au conditionnel", () => {
  const conflits = detecterConflits([
    eq("192.168.0.10", "aa:bb:cc:dd:ee:01"),
    eq("192.168.0.11", "aa:bb:cc:dd:ee:01"),
  ]);
  const message = decrireConflit(conflits[0]);
  assert.match(message, /192\.168\.0\.10/);
  assert.match(message, /192\.168\.0\.11/);
  assert.match(message, /aa:bb:cc:dd:ee:01/);
  // Le service constate ce qu'il a mesuré ; il ne conclut pas à la place
  // de l'opérateur.
  assert.match(message, /probable|ou machine/);
});
