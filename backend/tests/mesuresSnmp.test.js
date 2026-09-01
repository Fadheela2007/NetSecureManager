/**
 * tests/mesuresSnmp.test.js
 * Lecture des mesures SNMP : charge processeur et occupation mémoire.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CES TESTS EXISTENT
 *
 * Ces deux calculs ont vécu longtemps à l'intérieur de snmpMetrics(),
 * inatteignables sans un vrai équipement au bout du câble. Ils n'ont donc
 * jamais été vérifiés — et pendant tout ce temps, ils ne recevaient rien
 * du tout : la fonction qui les alimentait lisait une COLONNE en croyant
 * lire une TABLE, et rendait un objet vide sans jamais signaler d'erreur.
 *
 * Le défaut était invisible depuis l'interface, parce qu'un résultat vide
 * ressemble en tout point à un équipement qui ne répond pas. Il aurait
 * suivi le produit chez chaque client.
 *
 * Les deux fonctions sont désormais séparées et pures : elles reçoivent
 * des valeurs, elles rendent un nombre. C'est ce qui les rend vérifiables
 * ici, sans réseau, en quelques millisecondes.
 * ─────────────────────────────────────────────────────────────────────
 */
const test = require("node:test");
const assert = require("node:assert");
const { moyenneCharges, tauxMemoire } = require("../src/services/discoveryService");

/* ═════════════════════════════════════════════════════════════════════
   CHARGE PROCESSEUR
   ═════════════════════════════════════════════════════════════════════ */

test("un seul cœur : la charge est rendue telle quelle", () => {
  assert.strictEqual(moyenneCharges({ 1: 42 }), 42);
});

test("plusieurs cœurs : moyenne, et non maximum", () => {
  // Un quatre-cœurs dont un seul travaille fonctionne NORMALEMENT.
  // Retenir le maximum déclencherait une alerte à chaque compilation.
  assert.strictEqual(moyenneCharges({ 1: 100, 2: 0, 3: 0, 4: 0 }), 25);
});

test("valeurs en chaîne : converties, car SNMP n'est pas typé uniformément", () => {
  assert.strictEqual(moyenneCharges({ 1: "50", 2: "70" }), 60);
});

test("valeurs hors bornes : écartées plutôt que moyennées", () => {
  // Certains agents publient -1 pour « je ne sais pas ». Le moyenner
  // ferait mentir la mesure des cœurs voisins.
  assert.strictEqual(moyenneCharges({ 1: -1, 2: 60, 3: 40 }), 50);
  assert.strictEqual(moyenneCharges({ 1: 250, 2: 30 }), 30);
});

test("aucune donnée : null, jamais zéro", () => {
  // « 0 % » se lit « la machine ne fait rien », ce qui est une
  // affirmation. Une case vide dit « je ne sais pas », ce qui est vrai.
  assert.strictEqual(moyenneCharges({}), null);
  assert.strictEqual(moyenneCharges(null), null);
  assert.strictEqual(moyenneCharges(undefined), null);
});

test("que des valeurs inexploitables : null et non NaN", () => {
  // NaN traverse les additions sans bruit et finit affiché à l'écran.
  assert.strictEqual(moyenneCharges({ 1: "abc", 2: null }), null);
});

test("une charge nulle réelle reste zéro", () => {
  // Le contraire du test précédent : un zéro MESURÉ est une information
  // valable et ne doit pas être confondu avec l'absence de mesure.
  assert.strictEqual(moyenneCharges({ 1: 0, 2: 0 }), 0);
});

/* ═════════════════════════════════════════════════════════════════════
   OCCUPATION MÉMOIRE
   ═════════════════════════════════════════════════════════════════════ */

test("mémoire physique repérée parmi les autres stockages", () => {
  // La table mélange RAM, disques, partitions et caches. Prendre la
  // première ligne venue donnerait le taux de remplissage d'un disque.
  const descr = { 1: "C:\\ Label:OS", 2: "Physical Memory", 3: "Virtual Memory" };
  const taille = { 1: 500000, 2: 1000, 3: 4000 };
  const utilise = { 1: 450000, 2: 250, 3: 100 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), 25);
});

test("libellés Unix : « Real Memory » reconnu", () => {
  const r = tauxMemoire({ 5: "Real Memory Metrics" }, { 5: 800 }, { 5: 200 });
  assert.strictEqual(r, 25);
});

test("« RAM » seul reconnu, « ramdisk » ignoré", () => {
  assert.strictEqual(tauxMemoire({ 1: "RAM" }, { 1: 200 }, { 1: 50 }), 25);
  // Un disque en mémoire est un DISQUE : son remplissage n'est pas la
  // consommation mémoire de la machine.
  assert.strictEqual(tauxMemoire({ 1: "ramdisk0" }, { 1: 200 }, { 1: 199 }), null);
});

/* ─────────────────────────────────────────────────────────────────────
   CAS RÉELS RELEVÉS SUR LE PARC

   Ces trois tests ne sont pas inventés : ce sont les tables de stockage
   exactes lues sur les équipements, avec leurs valeurs. Ils existent
   parce que la première version de la règle s'est trompée sur DEUX de
   ces trois appareils — et dans des sens opposés.
   ───────────────────────────────────────────────────────────────────── */

test("réel — HP : « Random Access Memory » doit être reconnu", () => {
  // ERREUR N°1 : cette formulation, qui est celle de tous les agents HP,
  // n'était dans aucun motif. Deux imprimantes annonçaient 42 % et 95 %
  // d'occupation ; les deux mesures étaient jetées. Or 95 % est
  // exactement ce qu'un outil de supervision doit faire remonter.
  const a = tauxMemoire({ 1: "Random Access Memory" }, { 1: 268435456 }, { 1: 113434152 });
  const b = tauxMemoire({ 1: "Random Access Memory" }, { 1: 356794368 }, { 1: 339501056 });
  assert.ok(a !== null && Math.abs(a - 42.3) < 0.1, `attendu ≈42,3 %, obtenu ${a}`);
  assert.ok(b !== null && Math.abs(b - 95.2) < 0.1, `attendu ≈95,2 %, obtenu ${b}`);
});

test("réel — Canon : des compteurs à zéro ne sont pas une mesure", () => {
  // ERREUR N°2 : l'agent de cette imprimante DÉCLARE quatre lignes de
  // stockage et n'en remplit aucune. Un disque de 78 Go « occupé à 0
  // octet » n'existe pas. On affichait pourtant « RAM : 0 % » comme un
  // relevé, sur un graphique, avec une courbe plate à zéro.
  const descr = { 1: "RAM(main)", 2: "RAM(sub)", 3: "Flash Memory", 4: "HDD" };
  const taille = { 1: 2097152, 2: 1048576, 3: 483210, 4: 78142806 };
  const utilise = { 1: 0, 2: 0, 3: 0, 4: 0 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), null);
});

test("réel — Canon : la mémoire principale primerait si elle était remplie", () => {
  // Même appareil, compteurs supposés renseignés : c'est RAM(main) qui
  // doit être retenue, et non RAM(sub) ni la mémoire flash.
  const descr = { 1: "RAM(main)", 2: "RAM(sub)", 3: "Flash Memory", 4: "HDD" };
  const taille = { 1: 1000, 2: 1000, 3: 1000, 4: 1000 };
  const utilise = { 1: 300, 2: 900, 3: 800, 4: 700 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), 30);
});

test("Linux : parmi six lignes, seule la mémoire physique compte", () => {
  // La table standard d'un agent net-snmp. Cinq des six libellés
  // contiennent le mot « memory » sans être de la mémoire vive.
  const descr = {
    1: "Physical memory", 2: "Virtual memory", 3: "Memory buffers",
    4: "Cached memory", 5: "Shared memory", 6: "Swap space",
  };
  const taille = { 1: 1000, 2: 2000, 3: 100, 4: 100, 5: 100, 6: 500 };
  const utilise = { 1: 600, 2: 700, 3: 50, 4: 90, 5: 10, 6: 0 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), 60);
});

test("« Flash Memory » n'est pas de la mémoire vive", () => {
  assert.strictEqual(tauxMemoire({ 1: "Flash Memory" }, { 1: 1000 }, { 1: 500 }), null);
});

test("un libellé explicite prime sur un libellé vague", () => {
  // « Memory » seul pourrait désigner n'importe quoi ; « Physical
  // Memory » ne laisse aucun doute. L'ordre des lignes ne doit pas
  // décider à la place du sens.
  const descr = { 1: "Memory", 2: "Physical Memory" };
  const taille = { 1: 1000, 2: 1000 };
  const utilise = { 1: 100, 2: 800 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), 80);
});

test("l'unité d'allocation se simplifie dans le rapport", () => {
  // Les tailles sont exprimées en unités propres à chaque ligne, jamais
  // en octets. Le rapport reste juste sans connaître cette unité.
  const petit = tauxMemoire({ 1: "Physical memory" }, { 1: 4 }, { 1: 3 });
  const grand = tauxMemoire({ 1: "Physical memory" }, { 1: 4194304 }, { 1: 3145728 });
  assert.strictEqual(petit, 75);
  assert.strictEqual(grand, 75);
});

test("taille nulle : null, et surtout pas une division par zéro", () => {
  assert.strictEqual(tauxMemoire({ 1: "Physical memory" }, { 1: 0 }, { 1: 0 }), null);
  // Taille nulle mais occupation renseignée : incohérent, donc refusé.
  assert.strictEqual(tauxMemoire({ 1: "Physical memory" }, { 1: 0 }, { 1: 50 }), null);
});

test("occupation supérieure à la taille : plafonnée à 100", () => {
  // Vu sur des agents dont les deux compteurs ne sont pas lus au même
  // instant. Afficher « 137 % » ferait douter de tout l'outil.
  const r = tauxMemoire({ 1: "Physical memory" }, { 1: 100 }, { 1: 137 });
  assert.strictEqual(r, 100);
});

test("aucune ligne de mémoire : null", () => {
  const r = tauxMemoire({ 1: "C:\\ Label:OS", 2: "D:\\ Data" }, { 1: 10, 2: 10 }, { 1: 5, 2: 5 });
  assert.strictEqual(r, null);
});

test("colonnes absentes : null sans lever d'exception", () => {
  assert.strictEqual(tauxMemoire(null, null, null), null);
  assert.strictEqual(tauxMemoire({}, {}, {}), null);
  // Le libellé est là mais les chiffres manquent : cas réel d'un agent
  // qui déclare la ligne sans la remplir.
  assert.strictEqual(tauxMemoire({ 2: "Physical Memory" }, {}, {}), null);
});

test("les trois colonnes sont recollées par le MÊME index", () => {
  // C'est tout l'enjeu de la lecture colonne par colonne : si les index
  // ne correspondent plus, on rend la taille d'un disque et l'occupation
  // de la mémoire. Ici, la mémoire est à l'index 2 : le résultat doit
  // être 60 %, et non une valeur empruntée à la ligne 1 ou 3.
  const descr = { 1: "cache", 2: "Physical Memory", 3: "swap" };
  const taille = { 1: 999, 2: 1000, 3: 111 };
  const utilise = { 1: 111, 2: 600, 3: 999 };
  assert.strictEqual(tauxMemoire(descr, taille, utilise), 60);
});

/* ═════════════════════════════════════════════════════════════════════
   CONVERSION DES VALEURS SNMP

   Ces cas paraissent triviaux. Ils ne le sont pas : c'est exactement ici
   qu'une absence de mesure se transformait en « 0 % », c'est-à-dire en
   une affirmation fausse affichée avec l'assurance d'un relevé.
   ═════════════════════════════════════════════════════════════════════ */

const { nombreOuNull } = require("../src/services/discoveryService");

test("le vide ne devient pas zéro", () => {
  // Toutes ces valeurs donnent 0 avec Number(). Aucune ne signifie zéro.
  for (const vide of [null, undefined, "", "   ", true, false, [], {}, "abc", NaN]) {
    assert.strictEqual(nombreOuNull(vide), null, `${JSON.stringify(vide)} devrait rendre null`);
  }
});

test("les vrais nombres passent, y compris zéro", () => {
  assert.strictEqual(nombreOuNull(0), 0);
  assert.strictEqual(nombreOuNull(42), 42);
  assert.strictEqual(nombreOuNull("42"), 42);
  assert.strictEqual(nombreOuNull(" 42 "), 42);
  assert.strictEqual(nombreOuNull(-1), -1);
});

test("un compteur absent n'est pas une charge nulle", () => {
  // Le cas concret : deux cœurs mesurés, un troisième muet. La moyenne
  // doit porter sur les deux mesures réelles, pas sur trois valeurs dont
  // une inventée — qui donnerait 40 % au lieu de 60 %.
  assert.strictEqual(moyenneCharges({ 1: 60, 2: 60, 3: null }), 60);
});

test("une occupation mémoire absente ne vaut pas 0 %", () => {
  const r = tauxMemoire({ 1: "Physical Memory" }, { 1: 1000 }, { 1: null });
  assert.strictEqual(r, null);
});
