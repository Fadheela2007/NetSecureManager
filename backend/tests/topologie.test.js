/**
 * tests/topologie.test.js
 *
 * La règle qui décide si une carte réseau mène quelque part est le cœur
 * de topologieService. Ces cas sont construits sur un relevé RÉEL : un
 * poste Windows 11 qui déclare NEUF adresses IPv4, dont deux seulement
 * mènent quelque part. Les sept autres viennent de VirtualBox, VMware,
 * Hyper-V, du sous-système Linux et de la boucle locale.
 *
 * Sans cette règle, la carte de ce seul poste inventerait sept segments.
 */
const test = require("node:test");
const assert = require("node:assert");
const { construireGraphe, adresseUtile } = require("../src/services/topologieService");

/* Le relevé du 1er octobre 2026, transcrit tel quel. */
const POSTE = 1;
const INTERFACES_REELLES = [
  { id_equipement: POSTE, index_carte: 11, nom: "Ethernet", adresse_ip: "192.168.0.71",
    masque: 23, passerelle: "192.168.0.254", media: "802.3", materielle: 1, etat: "Up" },
  { id_equipement: POSTE, index_carte: 14, nom: "Wi-Fi", adresse_ip: "192.168.0.191",
    masque: 23, passerelle: "192.168.0.254", media: "Native 802.11", materielle: 1, etat: "Up" },
];
const INTERFACES_VIRTUELLES = [
  { id_equipement: POSTE, index_carte: 20, nom: "vEthernet (Default Switch)", adresse_ip: "172.23.16.1",
    masque: 20, passerelle: null, media: "Unspecified", materielle: 0, etat: "Up" },
  { id_equipement: POSTE, index_carte: 21, nom: "Ethernet 3", adresse_ip: "192.168.56.1",
    masque: 24, passerelle: null, media: "802.3", materielle: 0, etat: "Up" },
  { id_equipement: POSTE, index_carte: 22, nom: "VMnet8", adresse_ip: "192.168.5.1",
    masque: 24, passerelle: null, media: "802.3", materielle: 0, etat: "Up" },
  { id_equipement: POSTE, index_carte: 23, nom: "VMnet1", adresse_ip: "192.168.3.1",
    masque: 24, passerelle: null, media: "802.3", materielle: 0, etat: "Up" },
  { id_equipement: POSTE, index_carte: 30, nom: null, adresse_ip: "169.254.157.109",
    masque: 16, passerelle: null, media: null, materielle: null, etat: null },
  { id_equipement: POSTE, index_carte: 31, nom: null, adresse_ip: "169.254.212.95",
    masque: 16, passerelle: null, media: null, materielle: null, etat: null },
  { id_equipement: POSTE, index_carte: 1, nom: null, adresse_ip: "127.0.0.1",
    masque: 8, passerelle: null, media: null, materielle: null, etat: null },
];
const EQUIPEMENTS = [
  { id_equipement: POSTE, nom: "FADHEELA", adresse_ip: "192.168.0.71" },
];

function graphePoste(extra = {}) {
  return construireGraphe({
    interfaces: [...INTERFACES_REELLES, ...INTERFACES_VIRTUELLES],
    equipements: EQUIPEMENTS,
    ...extra,
  });
}

test("sur neuf interfaces déclarées, deux seulement sont retenues", () => {
  const g = graphePoste();
  assert.strictEqual(g.couverture.interfaces_retenues, 2);
  assert.strictEqual(g.couverture.interfaces_ecartees, 7);
});

test("les deux cartes du même poste donnent UN segment et UN nœud machine", () => {
  // Ethernet et Wi-Fi sont sur le même /23, derrière la même passerelle.
  // Les compter deux fois ferait apparaître la machine en double sur sa
  // propre carte — le défaut le plus visible qu'une carte puisse avoir.
  const g = graphePoste();
  assert.strictEqual(g.couverture.segments, 1);
  const machines = g.noeuds.filter((n) => n.type === "equipement");
  assert.strictEqual(machines.length, 1);
  assert.strictEqual(machines[0].libelle, "FADHEELA");
});

test("le segment porte l'adresse réseau, pas celle du poste", () => {
  const g = graphePoste();
  const segment = g.noeuds.find((n) => n.type === "segment");
  // 192.168.0.71/23 appartient au réseau 192.168.0.0/23, pas 192.168.71.0.
  assert.strictEqual(segment.libelle, "192.168.0.0/23");
});

test("« materielle: null » ne vaut pas « oui »", () => {
  // Number(null) vaut 0 et Boolean(null) vaut false : le piège serait de
  // tester la valeur au lieu de la comparer. « Je n'ai pas pu savoir »
  // ne doit pas faire entrer une carte dans la carte du réseau.
  const g = construireGraphe({
    interfaces: [{ id_equipement: 9, index_carte: 1, adresse_ip: "10.0.0.5",
                   masque: 24, passerelle: "10.0.0.1", materielle: null }],
    equipements: [{ id_equipement: 9, nom: "inconnue", adresse_ip: "10.0.0.5" }],
  });
  assert.strictEqual(g.couverture.interfaces_retenues, 0);
});

test("une carte matérielle sans passerelle est retenue si elle a vu quelqu'un", () => {
  // Le cas d'un VLAN d'administration : pas de passerelle, mais un vrai
  // segment. L'écarter perdrait précisément le réseau le plus sensible.
  const g = construireGraphe({
    interfaces: [{ id_equipement: 9, index_carte: 4, adresse_ip: "10.9.0.5",
                   masque: 24, passerelle: null, materielle: 1 }],
    voisins: [{ id_equipement: 9, index_carte: 4, adresse_ip: "10.9.0.8", etat: "Reachable" }],
    equipements: [{ id_equipement: 9, nom: "poste", adresse_ip: "10.9.0.5" }],
  });
  assert.strictEqual(g.couverture.interfaces_retenues, 1);
  assert.strictEqual(g.couverture.segments, 1);
});

test("une carte matérielle sans passerelle ni voisin est écartée", () => {
  const g = construireGraphe({
    interfaces: [{ id_equipement: 9, index_carte: 4, adresse_ip: "10.9.0.5",
                   masque: 24, passerelle: null, materielle: 1 }],
    equipements: [{ id_equipement: 9, nom: "poste", adresse_ip: "10.9.0.5" }],
  });
  assert.strictEqual(g.couverture.interfaces_retenues, 0);
});

test("« Reachable » donne un lien certain, « Stale » un lien déduit", () => {
  const g = graphePoste({
    voisins: [
      { id_equipement: POSTE, index_carte: 11, adresse_ip: "192.168.0.50", etat: "Reachable" },
      { id_equipement: POSTE, index_carte: 11, adresse_ip: "192.168.1.60", etat: "Stale" },
    ],
  });
  const vu = (ip) => g.liens.find((l) => l.de === `adresse:${ip}` && l.preuve === "voisinage");
  assert.strictEqual(vu("192.168.0.50").niveau, "certain");
  assert.strictEqual(vu("192.168.1.60").niveau, "deduit");
});

test("un voisin hors du segment de la carte n'est rattaché à rien", () => {
  // Une entrée de voisinage venue d'une autre carte ne prouve rien ici.
  const g = graphePoste({
    voisins: [{ id_equipement: POSTE, index_carte: 11, adresse_ip: "10.1.2.3", etat: "Reachable" }],
  });
  assert.strictEqual(g.liens.filter((l) => l.preuve === "voisinage").length, 0);
  assert.strictEqual(g.couverture.adresses_inconnues, 1); // la passerelle, et elle seule
});

test("une adresse vue sur le fil mais absente de l'inventaire est comptée", () => {
  const g = graphePoste({
    voisins: [{ id_equipement: POSTE, index_carte: 11, adresse_ip: "192.168.0.50", etat: "Reachable" }],
  });
  // La passerelle et le voisin : deux adresses qu'aucun scan n'a inventoriées.
  assert.strictEqual(g.couverture.adresses_inconnues, 2);
});

test("une passerelle déjà inventoriée est le MÊME nœud que son équipement", () => {
  const g = construireGraphe({
    interfaces: INTERFACES_REELLES,
    equipements: [...EQUIPEMENTS, { id_equipement: 7, nom: "Livebox", adresse_ip: "192.168.0.254" }],
  });
  assert.strictEqual(g.couverture.adresses_inconnues, 0);
  assert.ok(g.noeuds.some((n) => n.id === "equipement:7" && n.libelle === "Livebox"));
});

test("« certain » l'emporte sur « deduit » quand deux postes voient le même voisin", () => {
  const g = construireGraphe({
    interfaces: [
      { id_equipement: 1, index_carte: 1, adresse_ip: "10.0.0.5", masque: 24,
        passerelle: "10.0.0.1", materielle: 1 },
      { id_equipement: 2, index_carte: 1, adresse_ip: "10.0.0.6", masque: 24,
        passerelle: "10.0.0.1", materielle: 1 },
    ],
    voisins: [
      { id_equipement: 1, index_carte: 1, adresse_ip: "10.0.0.9", etat: "Stale" },
      { id_equipement: 2, index_carte: 1, adresse_ip: "10.0.0.9", etat: "Reachable" },
    ],
    equipements: [
      { id_equipement: 1, nom: "a", adresse_ip: "10.0.0.5" },
      { id_equipement: 2, nom: "b", adresse_ip: "10.0.0.6" },
    ],
  });
  const l = g.liens.find((x) => x.de === "adresse:10.0.0.9" && x.preuve === "voisinage");
  assert.strictEqual(l.niveau, "certain");
});

test("l'association sans fil donne un lien certain vers la borne", () => {
  const g = graphePoste({
    sansFil: [{ id_equipement: POSTE, bssid: "aa-bb-cc-dd-ee-ff", ssid: "Bureau" }],
  });
  const lien = g.liens.find((l) => l.preuve === "sans_fil");
  assert.strictEqual(lien.niveau, "certain");
  assert.strictEqual(lien.de, `equipement:${POSTE}`);
  const borne = g.noeuds.find((n) => n.type === "borne");
  assert.strictEqual(borne.libelle, "Bureau");
  assert.strictEqual(g.couverture.bornes, 1);
});

test("boucle locale et adresses auto-attribuées ne mènent nulle part", () => {
  assert.strictEqual(adresseUtile("127.0.0.1"), false);
  assert.strictEqual(adresseUtile("169.254.157.109"), false);
  assert.strictEqual(adresseUtile("192.168.0.71"), true);
  assert.strictEqual(adresseUtile(null), false);
});

test("un relevé vide rend un graphe vide, sans lever", () => {
  const g = construireGraphe();
  assert.deepStrictEqual(g.noeuds, []);
  assert.deepStrictEqual(g.liens, []);
  assert.strictEqual(g.couverture.postes_ayant_repondu, 0);
});
