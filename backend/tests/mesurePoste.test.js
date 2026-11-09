/**
 * tests/mesurePoste.test.js
 *
 * L'agent de poste mesure désormais le processeur et les compteurs de ses
 * cartes réseau. Ces trois analyses portent toute la logique — et ce sont
 * exactement celles qui marchent sur la machine du développeur et cassent
 * sur le poste du client : une seule carte au lieu de deux, un noyau qui
 * a changé ses colonnes, un compteur remis à zéro.
 *
 * Elles sont donc pures, et testées sans Windows ni PowerShell.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  chargeDepuisEchantillons,
  analyserProcNetDev,
  analyserCartesWindows,
} = require("../src/agent-poste/collecteurs");

/** Un cœur, avec ses compteurs de temps cumulés. */
const coeur = (user, sys, idle) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });

/* ═══════════════════════════════════════════════════════════════════════
   LA CHARGE PROCESSEUR
   ═══════════════════════════════════════════════════════════════════════ */

test("la charge se calcule sur la différence entre deux échantillons", () => {
  /* Un seul échantillon donnerait la moyenne depuis l'allumage de la
     machine : un chiffre qui ne bouge plus au bout de quelques jours. */
  const avant = [coeur(1000, 500, 8500)];
  const apres = [coeur(1300, 600, 8600)]; // 400 actifs, 100 inactifs sur 500

  assert.equal(chargeDepuisEchantillons(avant, apres), 80);
});

test("la charge moyenne plusieurs cœurs", () => {
  const avant = [coeur(0, 0, 100), coeur(0, 0, 100)];
  const apres = [coeur(100, 0, 100), coeur(0, 0, 200)]; // un cœur à fond, l'autre au repos

  assert.equal(chargeDepuisEchantillons(avant, apres), 50);
});

test("des compteurs qui n'ont pas bougé ne donnent pas zéro pour cent", () => {
  /* Zéro se lirait « machine au repos ». La vérité est « rien ne s'est
     écoulé entre les deux mesures », donc on ne sait pas. */
  const echantillon = [coeur(1000, 500, 8500)];
  assert.equal(chargeDepuisEchantillons(echantillon, echantillon), null);
});

test("un redémarrage remet les compteurs à zéro : aucune valeur inventée", () => {
  const avant = [coeur(9000, 1000, 90000)];
  const apres = [coeur(10, 5, 100)];
  assert.equal(chargeDepuisEchantillons(avant, apres), null);
});

test("un nombre de cœurs qui change ne produit pas de chiffre", () => {
  assert.equal(chargeDepuisEchantillons([coeur(0, 0, 100)], []), null);
  assert.equal(chargeDepuisEchantillons(null, [coeur(0, 0, 100)]), null);
  assert.equal(chargeDepuisEchantillons([], []), null);
});

test("la charge reste bornée entre 0 et 100", () => {
  const avant = [coeur(0, 0, 0)];
  const apres = [coeur(1000, 0, 0)]; // 100 % actif
  assert.equal(chargeDepuisEchantillons(avant, apres), 100);
});

/* ═══════════════════════════════════════════════════════════════════════
   LES COMPTEURS RÉSEAU — LINUX
   ═══════════════════════════════════════════════════════════════════════ */

test("les octets sont lus dans les bonnes colonnes de /proc/net/dev", () => {
  const texte = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets",
    "    lo:  123456    1000    0    0    0     0          0         0   123456    1000",
    "  eth0: 9876543   50000    0    0    0     0          0         0  1234567   40000",
  ].join("\n");

  const cartes = analyserProcNetDev(texte);

  assert.equal(cartes.length, 2);
  assert.equal(cartes[1].nom, "eth0");
  assert.equal(cartes[1].in_octets, 9876543, "1re valeur après le « : »");
  assert.equal(cartes[1].out_octets, 1234567, "9e valeur");
});

test("la boucle locale est transmise, pas filtrée ici", () => {
  /* Le serveur l'écarte du total sur son nom, avec le même filtre que
     pour le SNMP. La retirer ici aussi ferait deux règles pour une, et
     empêcherait la fiche de l'équipement de la montrer « hors total ». */
  const texte = "    lo:  100 1 0 0 0 0 0 0   200 2\n  eth0: 300 3 0 0 0 0 0 0  400 4";
  const cartes = analyserProcNetDev(texte);

  assert.ok(cartes.some((c) => c.nom === "lo"));
});

test("un fichier vide ou illisible ne rend rien plutôt qu'une liste vide", () => {
  for (const texte of ["", null, undefined, "n'importe quoi"]) {
    assert.equal(analyserProcNetDev(texte), null, JSON.stringify(texte));
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   LES COMPTEURS RÉSEAU — WINDOWS
   ═══════════════════════════════════════════════════════════════════════ */

test("une machine à une seule carte rend un objet, pas un tableau", () => {
  /* C'est le piège de ConvertTo-Json, et le cas le plus courant : un
     portable. Un code qui suppose un tableau casse là, et seulement là. */
  const json = JSON.stringify({ Name: "Wi-Fi", ReceivedBytes: 5000, SentBytes: 2000 });
  const cartes = analyserCartesWindows(json);

  assert.equal(cartes.length, 1);
  assert.equal(cartes[0].nom, "Wi-Fi");
  assert.equal(cartes[0].in_octets, 5000);
});

test("plusieurs cartes sont lues, avec leur ifIndex quand il est donné", () => {
  const json = JSON.stringify([
    { Name: "Ethernet", ReceivedBytes: 10, SentBytes: 20, ifIndex: 12 },
    { Name: "Wi-Fi", ReceivedBytes: 30, SentBytes: 40 },
  ]);
  const cartes = analyserCartesWindows(json);

  assert.equal(cartes.length, 2);
  assert.equal(cartes[0].index, 12, "ifIndex fait foi quand Windows le donne");
  assert.equal(cartes[1].index, 2, "sinon le rang, qui suffit : seule la stabilité compte");
});

test("une carte sans compteur lisible est écartée, pas comptée à zéro", () => {
  const json = JSON.stringify([
    { Name: "Ethernet", ReceivedBytes: 10, SentBytes: 20 },
    { Name: "Cassée", ReceivedBytes: null, SentBytes: null },
    { Name: "", ReceivedBytes: 1, SentBytes: 1 },
  ]);
  const cartes = analyserCartesWindows(json);

  assert.equal(cartes.length, 1);
  assert.equal(cartes[0].nom, "Ethernet");
});

test("une sortie PowerShell illisible ne rend rien", () => {
  for (const json of ["", "Get-NetAdapterStatistics : terme non reconnu", null, "[]"]) {
    assert.equal(analyserCartesWindows(json), null, JSON.stringify(json));
  }
});
