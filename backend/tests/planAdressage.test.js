/**
 * tests/planAdressage.test.js
 *
 * Le plan d'adressage repose entièrement sur une arithmétique : combien
 * d'adresses une plage contient, lesquelles sont attribuables, laquelle
 * appartient à laquelle. Une erreur d'une unité y est invisible à l'œil
 * et fausse un chiffre montré au client.
 *
 * Le cas du /23 est retenu explicitement : sur ce projet, un masque
 * 255.255.254.0 lu comme un /24 a laissé la moitié d'un parc invisible
 * pendant des semaines. Un filtrage par préfixe de chaîne
 * (« l'adresse commence par 192.168.0. ») referait exactement la même
 * faute — d'où le test sur l'appartenance.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  nbAttribuables,
  nbIntermediairesReservees,
} = require("../src/services/planAdressageService");
const { cidrSubnet } = require("../src/services/adressesIp");

test("le nombre d'adresses attribuables retranche réseau et diffusion", () => {
  assert.strictEqual(nbAttribuables(24), 254);
  assert.strictEqual(nbAttribuables(23), 510);
  assert.strictEqual(nbAttribuables(25), 126);
  assert.strictEqual(nbAttribuables(30), 2);
});

test("/31 et /32 ne retranchent rien — RFC 3021 et adresse unique", () => {
  assert.strictEqual(nbAttribuables(31), 2);
  assert.strictEqual(nbAttribuables(32), 1);
});

test("un /23 contient bien les deux moitiés, pas seulement la première", () => {
  const plage = cidrSubnet("192.168.0.0/23");
  assert.ok(plage.contains("192.168.0.1"), "première moitié");
  assert.ok(plage.contains("192.168.1.254"), "seconde moitié — le piège du /23");
  assert.ok(!plage.contains("192.168.2.1"), "hors plage");
});

test("les bornes d'un /23 sont celles attendues", () => {
  const plage = cidrSubnet("192.168.0.0/23");
  assert.strictEqual(plage.networkAddress, "192.168.0.0");
  assert.strictEqual(plage.broadcastAddress, "192.168.1.255");
  assert.strictEqual(plage.firstAddress, "192.168.0.1");
  assert.strictEqual(plage.lastAddress, "192.168.1.254");
});

test("les .0 et .255 intérieurs sont comptés à part, jamais comme libres", () => {
  // Un /24 n'en contient aucun : ses .0 et .255 SONT le réseau et la
  // diffusion, déjà retranchés.
  assert.strictEqual(nbIntermediairesReservees(24), 0);
  assert.strictEqual(nbIntermediairesReservees(25), 0);
  // Un /23 en contient deux : 192.168.0.255 et 192.168.1.0.
  assert.strictEqual(nbIntermediairesReservees(23), 2);
  assert.strictEqual(nbIntermediairesReservees(22), 6);
  assert.strictEqual(nbIntermediairesReservees(16), 510);
});

test("le plan compte exactement ce que le balayage ira voir", () => {
  // LA PROPRIÉTÉ QUI COMPTE : deux écrans du même logiciel ne doivent pas
  // se contredire. Le balayage d'un /23 sonde 508 adresses ; le plan doit
  // donc annoncer 510 attribuables dont 2 non balayées — jamais 510
  // disponibles.
  for (const prefixe of [24, 23, 22]) {
    const sondables = nbAttribuables(prefixe) - nbIntermediairesReservees(prefixe);
    assert.strictEqual(
      sondables,
      { 24: 254, 23: 508, 22: 1016 }[prefixe],
      `préfixe /${prefixe}`
    );
  }
});

test("une adresse d'un autre réseau n'occupe pas la plage", () => {
  const plage = cidrSubnet("10.20.30.0/24");
  assert.ok(!plage.contains("10.20.31.5"));
  assert.ok(!plage.contains("110.20.30.5"), "préfixe de chaîne trompeur");
});

test("occupation et libre se somment toujours au total", () => {
  // La propriété qui doit tenir quoi qu'il arrive : ce qui est montré au
  // client ne peut pas ne pas s'additionner.
  for (const prefixe of [24, 23, 25, 30]) {
    const total = nbAttribuables(prefixe);
    const reservees = nbIntermediairesReservees(prefixe);
    for (const occupees of [0, 1, 2, total - reservees]) {
      const libres = Math.max(0, total - occupees - reservees);
      assert.strictEqual(occupees + reservees + libres, total, `préfixe /${prefixe}`);
    }
  }
});
