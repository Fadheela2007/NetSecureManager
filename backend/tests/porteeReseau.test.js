/**
 * tests/porteeReseau.test.js
 *
 * Une plage sans équipement est-elle vide, ou hors de portée ? Les deux
 * rendent zéro machine. Les confondre fait croire à un inventaire complet
 * alors qu'un réseau entier n'a pas été regardé — le défaut le plus
 * coûteux pour un produit dont la valeur tient à l'exactitude de son
 * inventaire.
 *
 * Seule la logique pure est testée ici : la partie qui envoie des pings
 * dépend du réseau et n'a pas sa place dans une suite automatique.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  sousReseauxLocaux,
  estDirectementAttache,
} = require("../src/services/discoveryService");

/* ── sousReseauxLocaux ────────────────────────────────────────────── */

test("ne retient que les adresses IPv4 externes", () => {
  const adresses = sousReseauxLocaux({
    Ethernet: [
      { family: "IPv4", address: "192.168.0.71", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
    ],
    "Loopback Pseudo-Interface 1": [
      { family: "IPv4", address: "127.0.0.1", internal: true },
    ],
  });

  assert.deepStrictEqual(adresses, ["192.168.0.71"]);
});

test("accepte family sous forme de nombre", () => {
  // Node renvoie "IPv4" selon les versions et 4 selon d'autres. Ne gérer
  // qu'une seule forme rendrait la détection muette sur la moitié des
  // installations, sans erreur visible.
  const adresses = sousReseauxLocaux({
    eth0: [{ family: 4, address: "10.0.0.5", internal: false }],
  });

  assert.deepStrictEqual(adresses, ["10.0.0.5"]);
});

test("les interfaces virtuelles sont conservées", () => {
  // VMware, WSL et Hyper-V désignent de vrais réseaux joignables depuis
  // ce serveur. Les écarter ici ferait conclure « hors de portée » sur
  // une plage parfaitement atteignable.
  const adresses = sousReseauxLocaux({
    "vEthernet (WSL)": [{ family: "IPv4", address: "172.24.144.1", internal: false }],
    "VMware VMnet1": [{ family: "IPv4", address: "192.168.3.1", internal: false }],
  });

  assert.deepStrictEqual(adresses, ["172.24.144.1", "192.168.3.1"]);
});

test("une table d'interfaces vide ou absente ne fait pas échouer", () => {
  assert.deepStrictEqual(sousReseauxLocaux({}), []);
  assert.deepStrictEqual(sousReseauxLocaux({ eth0: null }), []);
});

/* ── estDirectementAttache ────────────────────────────────────────── */

test("reconnaît la plage à laquelle le serveur appartient", () => {
  assert.strictEqual(estDirectementAttache("192.168.0.0/24", ["192.168.0.71"]), true);
});

test("un /23 contient les deux moitiés", () => {
  // Cas réel : la carte du serveur porte un masque 255.255.254.0. Une
  // machine en 192.168.1.x appartient au même réseau que 192.168.0.x —
  // c'est précisément ce qu'un /24 mal déclaré faisait manquer.
  assert.strictEqual(estDirectementAttache("192.168.0.0/23", ["192.168.1.7"]), true);
  assert.strictEqual(estDirectementAttache("192.168.0.0/24", ["192.168.1.7"]), false);
});

test("une plage étrangère n'est pas attachée", () => {
  assert.strictEqual(estDirectementAttache("10.20.30.0/24", ["192.168.0.71"]), false);
});

test("plusieurs interfaces : une seule suffit", () => {
  const locales = ["192.168.0.71", "192.168.3.1", "172.24.144.1"];
  assert.strictEqual(estDirectementAttache("192.168.3.0/24", locales), true);
});

test("un CIDR illisible renvoie faux au lieu de lever", () => {
  // Un CIDR saisi de travers dans la page Plages ne doit pas faire
  // échouer le scan de site : il doit seulement empêcher de conclure.
  assert.strictEqual(estDirectementAttache("pas-un-cidr", ["192.168.0.71"]), false);
  assert.strictEqual(estDirectementAttache("", ["192.168.0.71"]), false);
});

test("aucune adresse locale : rien n'est attaché", () => {
  assert.strictEqual(estDirectementAttache("192.168.0.0/24", []), false);
});
