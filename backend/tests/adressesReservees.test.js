/**
 * tests/adressesReservees.test.js
 * Les adresses de diffusion ne sont pas des équipements.
 *
 * Né d'un cas réel : 192.168.0.255 s'était enregistrée comme machine et
 * générait une alerte « ne répond plus » permanente. Un outil de
 * supervision qui invente des pannes perd sa raison d'être.
 */
const test = require("node:test");
const assert = require("node:assert");

const { estAdresseReservee } = require("../src/services/discoveryService");

test("les adresses de diffusion et de réseau sont écartées", () => {
  for (const ip of ["192.168.0.255", "192.168.1.255", "192.168.0.0", "10.0.5.0"]) {
    assert.strictEqual(estAdresseReservee(ip), true, ip);
  }
});

test("les adresses d'hôtes ordinaires passent", () => {
  for (const ip of ["192.168.0.1", "192.168.0.63", "192.168.0.254", "10.0.5.128"]) {
    assert.strictEqual(estAdresseReservee(ip), false, ip);
  }
});

test("le dernier octet seul décide, pas les autres", () => {
  // 192.168.255.10 contient « 255 » mais dans le TROISIÈME octet : c'est
  // une adresse d'hôte parfaitement valide. Un filtre écrit sur la chaîne
  // entière l'aurait écartée à tort.
  assert.strictEqual(estAdresseReservee("192.168.255.10"), false);
  assert.strictEqual(estAdresseReservee("255.255.255.1"), false);
  assert.strictEqual(estAdresseReservee("0.0.0.42"), false);
});

test("une valeur absente ou malformée ne fait pas tomber le scan", () => {
  assert.doesNotThrow(() => {
    estAdresseReservee(null);
    estAdresseReservee(undefined);
    estAdresseReservee("");
    estAdresseReservee("pas-une-adresse");
  });
});
