/**
 * tests/traficService.test.js
 *
 * Lancement :  node --test tests/
 *
 * Le calcul du débit est le seul endroit de la plateforme où une erreur
 * produit un chiffre PLAUSIBLE mais faux — le pire cas pour un outil de
 * diagnostic. Une alerte manquante se voit ; un débit de 340 Mbit/s sur un
 * lien qui en fait 12 ne se voit pas, il s'explique.
 *
 * D'où ces tests : ils portent sur les cas où le calcul naïf se trompe
 * silencieusement (débordement de compteur, redémarrage d'équipement,
 * boucle locale comptée deux fois, ports qui s'écrasent mutuellement).
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  calculerDebit,
  calculerDebitsEquipement,
  tauxUtilisation,
  estIgnoree,
  oublier,
  _vider,
  _taille,
} = require("../src/services/traficService");

/** Deux relevés espacés de `secondes`, sur une interface donnée. */
function deuxRelevés(cle, av, ap, secondes = 60) {
  const t0 = 1_700_000_000_000;
  calculerDebit(cle, av, t0);
  return calculerDebit(cle, ap, t0 + secondes * 1000);
}

test.beforeEach(() => _vider());

// ─────────────────────────────────────────────────────────────────────
test("le premier relevé ne produit pas de débit (NULL, pas zéro)", () => {
  const d = calculerDebit("eq:1", { inOctets: 1000, outOctets: 2000 }, 0);

  // NULL et 0 ne veulent pas dire la même chose : « pas encore mesurable »
  // contre « mesuré, aucun trafic ». Renvoyer 0 ici afficherait un port
  // inactif là où on ne sait simplement pas encore.
  assert.strictEqual(d.entrant, null);
  assert.strictEqual(d.sortant, null);
});

test("calcul de base : 1 Mo en 60 s ≈ 136,5 kbit/s", () => {
  // 1 048 576 octets × 8 bits ÷ 1024 ÷ 60 s = 136,53 kbit/s
  const d = deuxRelevés("eq:1", { inOctets: 0, outOctets: 0 }, { inOctets: 1_048_576, outOctets: 0 }, 60);

  assert.ok(Math.abs(d.entrant - 136.53) < 0.1, `attendu ≈136,53, obtenu ${d.entrant}`);
  assert.strictEqual(d.sortant, 0);
});

test("débordement du compteur 32 bits : rien plutôt qu'un pic inventé", () => {
  // Un compteur ifInOctets 32 bits déborde à ~4,29 milliards. Sur un lien
  // gigabit chargé, cela arrive toutes les 34 secondes. Le calcul naïf
  // produit un delta négatif ; le prendre en valeur absolue afficherait un
  // pic de plusieurs Gbit/s qui n'a jamais eu lieu.
  const d = deuxRelevés("eq:1", { inOctets: 4_294_000_000, outOctets: 0 }, { inOctets: 12_000, outOctets: 0 }, 30);

  assert.strictEqual(d.entrant, null, "un delta négatif doit rester non mesuré");
});

test("redémarrage de l'équipement : compteurs remis à zéro, aucun débit négatif", () => {
  const d = deuxRelevés("eq:1", { inOctets: 900_000, outOctets: 800_000 }, { inOctets: 0, outOctets: 0 }, 300);

  assert.strictEqual(d.entrant, null);
  assert.strictEqual(d.sortant, null);
});

test("deux relevés au même instant ne divisent pas par zéro", () => {
  const t = 1_700_000_000_000;
  calculerDebit("eq:1", { inOctets: 0, outOctets: 0 }, t);
  const d = calculerDebit("eq:1", { inOctets: 5000, outOctets: 5000 }, t);

  assert.strictEqual(d.entrant, null);
  assert.strictEqual(d.sortant, null);
});

// ─────────────────────────────────────────────────────────────────────
test("deux ports du même switch ne s'écrasent pas mutuellement", () => {
  // C'était le défaut du cache indexé par équipement : le compteur du
  // port 2 remplaçait celui du port 1, et la différence se faisait entre
  // deux interfaces différentes — un chiffre sans aucun sens.
  const t0 = 1_700_000_000_000;
  const interfaces0 = [
    { index: 1, nom: "Gi0/1", inOctets: 0, outOctets: 0 },
    { index: 2, nom: "Gi0/2", inOctets: 5_000_000, outOctets: 0 },
  ];
  const interfaces1 = [
    { index: 1, nom: "Gi0/1", inOctets: 1_048_576, outOctets: 0 },
    { index: 2, nom: "Gi0/2", inOctets: 5_000_000, outOctets: 0 },
  ];

  calculerDebitsEquipement("switch", interfaces0, t0);
  const r = calculerDebitsEquipement("switch", interfaces1, t0 + 60_000);

  const p1 = r.parInterface.find((i) => i.index_snmp === 1);
  const p2 = r.parInterface.find((i) => i.index_snmp === 2);

  assert.ok(Math.abs(p1.trafic_entrant_kbps - 136.53) < 0.1, "le port 1 a bien son propre compteur");
  assert.strictEqual(p2.trafic_entrant_kbps, 0, "le port 2 n'a pas bougé : 0, et non le trafic du port 1");
});

test("le total porte sur toutes les interfaces, pas seulement la première", () => {
  // Le défaut d'origine : le débit d'un switch 24 ports était celui du
  // port 1. Un switch saturé sur le port 12 apparaissait au repos.
  const t0 = 1_700_000_000_000;
  const av = [
    { index: 1, nom: "Gi0/1", inOctets: 0, outOctets: 0 },
    { index: 2, nom: "Gi0/2", inOctets: 0, outOctets: 0 },
    { index: 3, nom: "Gi0/3", inOctets: 0, outOctets: 0 },
  ];
  const ap = [
    { index: 1, nom: "Gi0/1", inOctets: 1_048_576, outOctets: 0 },
    { index: 2, nom: "Gi0/2", inOctets: 1_048_576, outOctets: 0 },
    { index: 3, nom: "Gi0/3", inOctets: 1_048_576, outOctets: 0 },
  ];

  calculerDebitsEquipement("sw", av, t0);
  const r = calculerDebitsEquipement("sw", ap, t0 + 60_000);

  assert.ok(Math.abs(r.total.entrant - 3 * 136.53) < 0.5, `attendu ≈409,6, obtenu ${r.total.entrant}`);
  assert.strictEqual(r.total.interfaces_comptees, 3);
});

test("la boucle locale est mesurée mais exclue du total", () => {
  // La loopback voit passer tout le trafic interne de la machine : la
  // compter doublerait la consommation apparente d'un serveur.
  const t0 = 1_700_000_000_000;
  const av = [
    { index: 1, nom: "lo", inOctets: 0, outOctets: 0 },
    { index: 2, nom: "eth0", inOctets: 0, outOctets: 0 },
  ];
  const ap = [
    { index: 1, nom: "lo", inOctets: 100_000_000, outOctets: 0 },
    { index: 2, nom: "eth0", inOctets: 1_048_576, outOctets: 0 },
  ];

  calculerDebitsEquipement("srv", av, t0);
  const r = calculerDebitsEquipement("srv", ap, t0 + 60_000);

  const lo = r.parInterface.find((i) => i.nom === "lo");
  assert.strictEqual(lo.ignoree_du_total, true);
  assert.ok(lo.trafic_entrant_kbps > 0, "la valeur reste calculée, elle est simplement écartée du total");
  assert.ok(Math.abs(r.total.entrant - 136.53) < 0.1, "seul eth0 compte dans le total");
  assert.strictEqual(r.total.interfaces_comptees, 1);
});

test("les noms de boucle locale reconnus, et ceux qu'il ne faut pas confondre", () => {
  assert.strictEqual(estIgnoree("lo"), true);
  assert.strictEqual(estIgnoree("lo0"), true);
  assert.strictEqual(estIgnoree("Software Loopback Interface 1"), true);
  assert.strictEqual(estIgnoree("Null0"), true);

  // Faux positifs à éviter : ces interfaces sont de vrais liens.
  assert.strictEqual(estIgnoree("eth0"), false);
  assert.strictEqual(estIgnoree("Gi0/1"), false);
  assert.strictEqual(estIgnoree("wlan0"), false);
});

test("une interface sans index SNMP est ignorée sans faire échouer le calcul", () => {
  const r = calculerDebitsEquipement("eq", [
    { nom: "sans index", inOctets: 1, outOctets: 1 },
    { index: 4, nom: "eth0", inOctets: 1, outOctets: 1 },
  ]);

  assert.strictEqual(r.parInterface.length, 1);
  assert.strictEqual(r.parInterface[0].index_snmp, 4);
});

test("un équipement sans aucune interface renvoie un total NULL, pas zéro", () => {
  const r = calculerDebitsEquipement("eq", []);

  assert.strictEqual(r.total.entrant, null);
  assert.strictEqual(r.total.sortant, null);
  assert.strictEqual(r.total.interfaces_comptees, 0);
});

// ─────────────────────────────────────────────────────────────────────
test("taux d'utilisation : le maximum des deux sens, pas leur somme", () => {
  // Un lien full-duplex fait 100 Mbit/s dans CHAQUE sens. 60 entrant +
  // 60 sortant ne saturent pas le lien à 120 % : chaque sens est à 60 %.
  const t = tauxUtilisation(60_000, 60_000, 100);
  assert.ok(Math.abs(t - 60) < 0.01, `attendu 60 %, obtenu ${t}`);
});

test("taux d'utilisation : NULL quand la vitesse du lien est inconnue", () => {
  // Sans ifSpeed, aucun pourcentage n'est calculable. Supposer 100 Mbit/s
  // par défaut afficherait « 5 % » sur un lien 10 Mbit/s réellement à 50 %.
  assert.strictEqual(tauxUtilisation(50_000, 0, null), null);
  assert.strictEqual(tauxUtilisation(50_000, 0, 0), null);
  assert.strictEqual(tauxUtilisation(50_000, 0, undefined), null);
});

test("taux d'utilisation : plafonné à 100 %", () => {
  // Un compteur légèrement décalé ou une vitesse mal déclarée peut donner
  // 104 %. Afficher un taux supérieur à 100 % détruit la crédibilité de
  // l'écran auprès d'un acheteur qui connaît son réseau.
  assert.strictEqual(tauxUtilisation(500_000, 0, 100), 100);
});

test("taux d'utilisation : 0 kbit/s donne bien 0 %", () => {
  assert.strictEqual(tauxUtilisation(0, 0, 1000), 0);
});

// ─────────────────────────────────────────────────────────────────────
test("oublier() purge tout l'équipement sans toucher aux autres", () => {
  // Quand un équipement tombe, garder ses compteurs produirait au retour
  // un débit calculé sur des heures d'écart — un faux pic à chaque
  // rétablissement.
  calculerDebit("eq1:1", { inOctets: 1, outOctets: 1 }, 0);
  calculerDebit("eq1:2", { inOctets: 1, outOctets: 1 }, 0);
  calculerDebit("eq2:1", { inOctets: 1, outOctets: 1 }, 0);
  assert.strictEqual(_taille(), 3);

  oublier("eq1");

  assert.strictEqual(_taille(), 1, "les deux interfaces de eq1 sont parties, eq2 est intact");
});

test("oublier() ne purge pas un équipement dont l'identifiant est un préfixe", () => {
  // Piège classique : oublier("eq1") ne doit pas emporter "eq12".
  // Le séparateur « : » dans la clé est ce qui l'évite.
  calculerDebit("eq1:1", { inOctets: 1, outOctets: 1 }, 0);
  calculerDebit("eq12:1", { inOctets: 1, outOctets: 1 }, 0);

  oublier("eq1");

  assert.strictEqual(_taille(), 1);
});

test("après oublier(), le relevé suivant repart d'un premier relevé", () => {
  calculerDebit("eq:1", { inOctets: 0, outOctets: 0 }, 0);
  oublier("eq");
  const d = calculerDebit("eq:1", { inOctets: 1_000_000, outOctets: 0 }, 60_000);

  assert.strictEqual(d.entrant, null, "aucun pic sur le premier relevé après purge");
});
