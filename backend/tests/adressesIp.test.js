/**
 * tests/adressesIp.test.js
 *
 * Le paquet « ip » a été remplacé par services/adressesIp.js. Ces tests
 * fixent le comportement attendu — ils sont ce qui empêche une
 * réécriture future de casser silencieusement le balayage réseau.
 *
 * L'équivalence avec l'ancienne bibliothèque a été vérifiée une fois, sur
 * 1 089 676 comparaisons, avant le remplacement. Ces cas-ci en retiennent
 * les points où une erreur est facile et invisible.
 */
const test = require("node:test");
const assert = require("node:assert");
const { toLong, fromLong, cidrSubnet } = require("../src/services/adressesIp");

test("un aller-retour entier ↔ adresse redonne la même valeur", () => {
  for (const ip of ["0.0.0.0", "10.0.0.1", "192.168.1.77", "255.255.255.255"]) {
    assert.strictEqual(fromLong(toLong(ip)), ip);
  }
});

test("les adresses au-dessus de 127 restent positives", () => {
  // Le piège du décalage signé : sans `>>> 0`, 192.168.1.1 ressort négatif
  // et toute comparaison de plage devient fausse sur les réseaux privés.
  assert.ok(toLong("192.168.1.1") > 0);
  assert.strictEqual(toLong("255.255.255.255"), 4294967295);
});

test("une adresse malformée est refusée", () => {
  for (const mauvais of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "a.b.c.d", "192.168.1"]) {
    assert.throws(() => toLong(mauvais), /invalide/i, `accepté à tort : ${mauvais}`);
  }
});

test("un /24 écarte le réseau et la diffusion", () => {
  const s = cidrSubnet("192.168.1.0/24");
  assert.strictEqual(s.networkAddress, "192.168.1.0");
  assert.strictEqual(s.broadcastAddress, "192.168.1.255");
  assert.strictEqual(s.firstAddress, "192.168.1.1");
  assert.strictEqual(s.lastAddress, "192.168.1.254");
});

test("un /23 couvre bien deux blocs de 256", () => {
  // Le cas qui a coûté deux tiers d'un parc : un /23 écrit /24 rend la
  // moitié du réseau invisible.
  const s = cidrSubnet("192.168.0.0/23");
  assert.strictEqual(s.firstAddress, "192.168.0.1");
  assert.strictEqual(s.lastAddress, "192.168.1.254");
  assert.ok(s.contains("192.168.1.42"));
});

test("l'adresse donnée n'a pas besoin d'être celle du réseau", () => {
  const s = cidrSubnet("192.168.1.77/24");
  assert.strictEqual(s.networkAddress, "192.168.1.0");
});

test("/31 et /32 gardent leurs bornes", () => {
  // Sans ce cas particulier, un /32 ne rendrait aucun hôte — or c'est la
  // notation employée pour vérifier une machine précise.
  const trenteDeux = cidrSubnet("10.0.0.5/32");
  assert.strictEqual(trenteDeux.firstAddress, "10.0.0.5");
  assert.strictEqual(trenteDeux.lastAddress, "10.0.0.5");

  const trenteEtUn = cidrSubnet("10.0.0.4/31");
  assert.strictEqual(trenteEtUn.firstAddress, "10.0.0.4");
  assert.strictEqual(trenteEtUn.lastAddress, "10.0.0.5");
});

test("un /0 couvre tout sans déborder", () => {
  // Décaler de 32 bits en JavaScript équivaut à ne pas décaler : le masque
  // vaudrait 0xffffffff au lieu de 0 si le cas n'était pas traité à part.
  const s = cidrSubnet("0.0.0.0/0");
  assert.strictEqual(s.networkAddress, "0.0.0.0");
  assert.strictEqual(s.broadcastAddress, "255.255.255.255");
  assert.ok(s.contains("8.8.8.8"));
});

test("contains distingue l'intérieur de l'extérieur", () => {
  const s = cidrSubnet("10.108.11.0/24");
  assert.ok(s.contains("10.108.11.202"));
  assert.ok(!s.contains("10.108.12.1"));
  assert.ok(!s.contains("192.168.1.1"));
});

test("contains ne lève jamais sur une entrée illisible", () => {
  // Les appelants balaient des listes hétérogènes (table ARP, relevés
  // d'agent) : une ligne abîmée ne doit pas interrompre le traitement.
  const s = cidrSubnet("192.168.1.0/24");
  assert.strictEqual(s.contains("pas-une-adresse"), false);
  assert.strictEqual(s.contains(null), false);
});

test("une notation CIDR invalide est refusée", () => {
  for (const mauvais of ["192.168.1.0", "192.168.1.0/33", "192.168.1.0/-1", "192.168.1.0/abc"]) {
    assert.throws(() => cidrSubnet(mauvais), /invalide/i, `accepté à tort : ${mauvais}`);
  }
});
