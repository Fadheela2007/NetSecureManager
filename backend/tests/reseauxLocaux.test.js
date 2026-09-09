/**
 * tests/reseauxLocaux.test.js
 *
 * La détection des plages remplace un calcul que l'humain rate : une
 * plage avait été déclarée en /24 là où le masque disait /23, et la moitié
 * d'un parc est restée invisible.
 *
 * Deux risques symétriques :
 *   • se tromper de plage, et scanner à côté ;
 *   • proposer les six réseaux virtuels d'un poste de développement, ce
 *     qui ferait douter de toute la suggestion.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  detecterReseaux,
  masqueVersPrefixe,
  adresseReseau,
  estVirtuelle,
} = require("../src/services/reseauxLocauxService");

/* ── Masque vers préfixe ──────────────────────────────────────────── */

test("convertit les masques courants", () => {
  assert.strictEqual(masqueVersPrefixe("255.255.255.0"), 24);
  assert.strictEqual(masqueVersPrefixe("255.255.254.0"), 23); // le cas réel
  assert.strictEqual(masqueVersPrefixe("255.255.240.0"), 20);
  assert.strictEqual(masqueVersPrefixe("255.255.0.0"), 16);
  assert.strictEqual(masqueVersPrefixe("255.255.255.252"), 30);
});

test("refuse un masque qui n'en est pas un", () => {
  // Une suite de 1 puis de 0, sans alternance. « 255.0.255.0 » se lit
  // mais ne veut rien dire : mieux vaut ne rien proposer qu'une plage
  // fantaisiste.
  assert.strictEqual(masqueVersPrefixe("255.0.255.0"), null);
  assert.strictEqual(masqueVersPrefixe("255.255.255"), null);
  assert.strictEqual(masqueVersPrefixe("300.255.255.0"), null);
  assert.strictEqual(masqueVersPrefixe(""), null);
  assert.strictEqual(masqueVersPrefixe(null), null);
});

/* ── Adresse réseau ───────────────────────────────────────────────── */

test("calcule l'adresse réseau, y compris sur un /23", () => {
  // LE CAS QUI A COÛTÉ LA MOITIÉ D'UN PARC.
  // 192.168.1.7 en /23 appartient au réseau 192.168.0.0 — pas 192.168.1.0.
  assert.strictEqual(adresseReseau("192.168.0.71", 23), "192.168.0.0");
  assert.strictEqual(adresseReseau("192.168.1.7", 23), "192.168.0.0");
  assert.strictEqual(adresseReseau("192.168.0.71", 24), "192.168.0.0");
  assert.strictEqual(adresseReseau("10.20.30.40", 16), "10.20.0.0");
});

test("le décalage sur 32 bits ne produit pas d'adresse négative", () => {
  // Sans `>>> 0`, JavaScript rend un entier signé et l'adresse devient
  // absurde. Ce test fixe le piège.
  assert.strictEqual(adresseReseau("172.24.144.1", 20), "172.24.144.0");
  assert.strictEqual(adresseReseau("255.255.255.254", 24), "255.255.255.0");
});

test("une adresse invalide ne produit rien", () => {
  assert.strictEqual(adresseReseau("pas.une.adresse.ip", 24), null);
  assert.strictEqual(adresseReseau("192.168.0", 24), null);
  assert.strictEqual(adresseReseau(null, 24), null);
});

/* ── Interfaces virtuelles ────────────────────────────────────────── */

test("reconnaît les adaptateurs d'hyperviseur", () => {
  for (const nom of [
    "vEthernet (Default Switch)",
    "vEthernet (WSL (Hyper-V firewall))",
    "VMware Network Adapter VMnet1",
    "VirtualBox Host-Only Network",
    "docker0",
    "virbr0",
  ]) {
    assert.strictEqual(estVirtuelle(nom), true, `${nom} doit être vu comme virtuel`);
  }
});

test("ne prend PAS une vraie interface pour une virtuelle", () => {
  // Le filtre `^lo` avait avalé « Local Area Connection », l'interface
  // principale de tout poste Windows. Un motif trop large ici écarterait
  // le vrai réseau de l'entreprise — l'inverse exact du but.
  for (const nom of ["Ethernet", "Ethernet 3", "Local Area Connection", "eth0", "Wi-Fi", "enp3s0"]) {
    assert.strictEqual(estVirtuelle(nom), false, `${nom} est une vraie interface`);
  }
});

/* ── Détection complète ───────────────────────────────────────────── */

/** Reproduit la sortie d'ipconfig d'un poste de développement réel. */
const INTERFACES_REELLES = {
  "vEthernet (Default Switch)": [
    { family: "IPv4", address: "172.19.128.1", netmask: "255.255.240.0", internal: false },
  ],
  "vEthernet (WSL (Hyper-V firewall))": [
    { family: "IPv4", address: "172.24.144.1", netmask: "255.255.240.0", internal: false },
  ],
  Ethernet: [
    { family: "IPv4", address: "192.168.0.71", netmask: "255.255.254.0", internal: false },
  ],
  "Ethernet 3": [
    { family: "IPv4", address: "192.168.56.1", netmask: "255.255.255.0", internal: false },
  ],
  "VMware Network Adapter VMnet1": [
    { family: "IPv4", address: "192.168.3.1", netmask: "255.255.255.0", internal: false },
  ],
  "Loopback Pseudo-Interface 1": [
    { family: "IPv4", address: "127.0.0.1", netmask: "255.0.0.0", internal: true },
  ],
};

test("trouve la vraie plage, en /23 et non en /24", () => {
  const reseaux = detecterReseaux(INTERFACES_REELLES);
  const vrai = reseaux.find((r) => r.interface === "Ethernet");

  assert.strictEqual(vrai.cidr, "192.168.0.0/23");
  assert.strictEqual(vrai.virtuelle, false);
  assert.strictEqual(vrai.nb_adresses, 510);
});

test("les réseaux réels sont proposés en premier", () => {
  const reseaux = detecterReseaux(INTERFACES_REELLES);
  assert.strictEqual(
    reseaux[0].virtuelle,
    false,
    "l'exploitant prendra celui du haut : ce doit être un vrai réseau"
  );
});

test("les réseaux virtuels sont présents mais signalés", () => {
  const reseaux = detecterReseaux(INTERFACES_REELLES);
  const wsl = reseaux.find((r) => r.interface.includes("WSL"));

  // On ne les cache pas — ils servent aux essais — mais on les marque.
  assert.strictEqual(wsl.virtuelle, true);
});

test("la boucle locale est écartée", () => {
  const reseaux = detecterReseaux(INTERFACES_REELLES);
  assert.ok(!reseaux.some((r) => r.cidr.startsWith("127.")));
});

test("un préfixe trop large ou trop étroit est écarté", () => {
  const reseaux = detecterReseaux({
    Enorme: [{ family: "IPv4", address: "10.0.0.5", netmask: "255.0.0.0", internal: false }],
    Liaison: [{ family: "IPv4", address: "10.9.9.1", netmask: "255.255.255.252", internal: false }],
    Point: [{ family: "IPv4", address: "10.8.8.1", netmask: "255.255.255.255", internal: false }],
  });

  // /8 = 16 millions d'adresses : ce n'est pas un réseau à scanner.
  assert.ok(!reseaux.some((r) => r.interface === "Enorme"));
  // /30 reste accepté (2 machines), /32 non.
  assert.ok(reseaux.some((r) => r.interface === "Liaison"));
  assert.ok(!reseaux.some((r) => r.interface === "Point"));
});

test("deux interfaces sur le même réseau ne donnent qu'une plage", () => {
  const reseaux = detecterReseaux({
    Ethernet: [{ family: "IPv4", address: "192.168.0.71", netmask: "255.255.255.0", internal: false }],
    "Wi-Fi": [{ family: "IPv4", address: "192.168.0.80", netmask: "255.255.255.0", internal: false }],
  });

  assert.strictEqual(reseaux.length, 1);
});

test("aucune interface exploitable ne fait pas échouer", () => {
  assert.deepStrictEqual(detecterReseaux({}), []);
  assert.deepStrictEqual(detecterReseaux({ eth0: null }), []);
});
