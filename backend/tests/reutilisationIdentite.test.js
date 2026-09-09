/**
 * tests/reutilisationIdentite.test.js
 *
 * Réutiliser l'identification d'un scan précédent fait gagner l'essentiel
 * du temps — nmap représente 93 % de la durée d'un scan et répond toujours
 * la même chose. Mais la règle qui décide de cette réutilisation est
 * dangereuse : mal écrite, elle attribue le système d'exploitation du
 * poste d'hier à la caméra d'aujourd'hui.
 *
 * En DHCP, une adresse IP change de machine. L'adresse MATÉRIELLE, elle,
 * suit la carte réseau. C'est donc elle, et elle seule, qui autorise à
 * réutiliser une identification.
 *
 * Ces tests portent sur la normalisation des adresses MAC, qui décide de
 * tout : « A4-BB-6D-01-02-03 » et « a4:bb:6d:01:02:03 » désignent la même
 * carte, et les croire différentes relancerait une identification complète
 * à chaque scan — le gain disparaîtrait sans que rien ne le signale.
 */

const test = require("node:test");
const assert = require("node:assert");
const { normaliserMacSimple } = require("../src/services/discoveryService");

test("les écritures différentes de la même MAC se rejoignent", () => {
  // Windows écrit avec des tirets et en majuscules (« arp -a »), Linux
  // avec des deux-points et en minuscules. Les deux doivent se comparer.
  const attendu = "a4bb6d010203";
  assert.strictEqual(normaliserMacSimple("A4-BB-6D-01-02-03"), attendu);
  assert.strictEqual(normaliserMacSimple("a4:bb:6d:01:02:03"), attendu);
  assert.strictEqual(normaliserMacSimple("A4BB6D010203"), attendu);
  assert.strictEqual(normaliserMacSimple(" a4:BB:6d:01:02:03 "), attendu);
});

test("deux cartes différentes ne se confondent pas", () => {
  assert.notStrictEqual(
    normaliserMacSimple("a4:bb:6d:01:02:03"),
    normaliserMacSimple("a4:bb:6d:01:02:04")
  );
});

test("une MAC absente ou incomplète ne vaut pas identité", () => {
  // Le point critique : si cette fonction renvoyait une valeur pour une
  // MAC absente, deux équipements sans MAC connue se ressembleraient — et
  // l'un hériterait de l'identification de l'autre.
  assert.strictEqual(normaliserMacSimple(null), null);
  assert.strictEqual(normaliserMacSimple(undefined), null);
  assert.strictEqual(normaliserMacSimple(""), null);
  assert.strictEqual(normaliserMacSimple("a4:bb:6d"), null, "MAC tronquée");
  assert.strictEqual(normaliserMacSimple("pas une adresse"), null);
});

test("deux MAC absentes ne se comparent pas comme égales", () => {
  // Conséquence directe du test précédent, écrite explicitement parce que
  // c'est le scénario qui produirait le défaut : `null === null` est vrai
  // en JavaScript. La règle de réutilisation exige donc une MAC PRÉSENTE
  // des deux côtés, jamais seulement égale.
  const a = normaliserMacSimple(null);
  const b = normaliserMacSimple("");
  assert.strictEqual(a, null);
  assert.strictEqual(b, null);
  // Le contrat que doit respecter l'appelant : exiger une valeur non nulle
  // AVANT de comparer.
  assert.ok(!(a && b && a === b), "deux MAC inconnues ne doivent pas autoriser la réutilisation");
});

test("la casse de la MAC stockée en base n'empêche pas la réutilisation", () => {
  // Cas réel : la base contient la MAC telle que « arp -a » l'a rendue
  // sous Windows, en majuscules avec tirets. Le scan suivant la relit
  // depuis la même source, mais un import ou une saisie manuelle peut
  // l'avoir écrite autrement. Sans normalisation, chaque scan
  // recommencerait tout — lentement, et sans qu'on comprenne pourquoi.
  const enBase = "A4-BB-6D-01-02-03";
  const vueMaintenant = "a4:bb:6d:01:02:03";
  assert.strictEqual(
    normaliserMacSimple(enBase),
    normaliserMacSimple(vueMaintenant)
  );
});
