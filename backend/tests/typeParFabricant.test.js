/**
 * tests/typeParFabricant.test.js
 *
 * La déduction du type par le fabricant ne s'est JAMAIS déclenchée.
 *
 * Elle faisait une correspondance exacte entre le nom du fabricant et
 * une table de marques. Or le fabricant vient du registre IEEE, qui
 * écrit les raisons sociales complètes :
 *
 *   table      : « Hikvision »
 *   registre   : « Hangzhou Hikvision Digital Technology Co.,Ltd. »
 *
 * Aucune clé ne correspondait, jamais. Sur un parc réel de 44
 * équipements, tous ressortaient « inconnu » — caméras et imprimantes
 * comprises, alors que leur adresse MAC les identifiait parfaitement.
 *
 * Le plus trompeur : le reclassement annonçait « 0 type corrigé sur
 * 44 », ce qui se lit « tout est déjà juste » et non « la règle ne
 * s'applique jamais ».
 *
 * Ces tests fixent les deux exigences opposées : reconnaître les vraies
 * marques dans un nom long, et ne PAS inventer de correspondance.
 */

const test = require("node:test");
const assert = require("node:assert");
const { typeDepuisFabricant } = require("../src/services/typeService");

// ─────────────────────────────────────────────────────────────────────
test("les noms tels que le registre IEEE les écrit sont reconnus", () => {
  // Chaînes copiées de vrais enregistrements OUI : ce sont elles qui
  // arrivent réellement dans la base, pas les noms de marque courts.
  const cas = [
    ["Hangzhou Hikvision Digital Technology Co.,Ltd.", "camera"],
    ["Axis Communications AB", "camera"],
    ["Kyocera Document Solutions Inc.", "imprimante"],
    ["Brother Industries, LTD.", "imprimante"],
    ["Lexmark International Inc.", "imprimante"],
    ["Zebra Technologies Inc.", "imprimante"],
    ["Yealink(Xiamen) Network Technology", "telephonie"],
    ["Grandstream Networks, Inc.", "telephonie"],
    ["Ubiquiti Networks Inc.", "routeur/switch"],
    ["VMware, Inc.", "serveur"],
    ["Fortinet, Inc.", "pare-feu"],
  ];

  for (const [nom, attendu] of cas) {
    assert.strictEqual(typeDepuisFabricant(nom), attendu, `fabricant : ${nom}`);
  }
});

test("la correspondance exacte continue de fonctionner", () => {
  // Certains fabricants arrivent déjà sous leur forme courte, par
  // exemple quand ils viennent de SNMP plutôt que du registre.
  assert.strictEqual(typeDepuisFabricant("Hikvision"), "camera");
  assert.strictEqual(typeDepuisFabricant("MikroTik"), "routeur");
});

test("la ponctuation et la casse n'empêchent pas la reconnaissance", () => {
  for (const nom of ["KYOCERA DOCUMENT SOLUTIONS", "kyocera", "Kyocera Corp."]) {
    assert.strictEqual(typeDepuisFabricant(nom), "imprimante", nom);
  }
});

// ─────────────────────────────────────────────────────────────────────
// L'AUTRE MOITIÉ DU PROBLÈME : NE PAS INVENTER
// ─────────────────────────────────────────────────────────────────────
test("un fabricant sans rapport ne reçoit aucun type", () => {
  // Ces noms viennent tous d'un parc réel. Les classer serait pire que
  // de les laisser en « inconnu » : mieux vaut l'absence de réponse
  // qu'une réponse fausse — c'est la règle du produit.
  for (const nom of [
    "Lierda Science & Technology Group Co.,Ltd",
    "Intel Corporate",
    "Dell Inc.",
    "Hewlett Packard Enterprise",
    "Cisco Systems, Inc",
    "Realtek Semiconductor Corp.",
    "TP-LINK TECHNOLOGIES CO.,LTD.",
  ]) {
    assert.strictEqual(typeDepuisFabricant(nom), null, `ne doit rien conclure : ${nom}`);
  }
});

test("un mot générique ne suffit jamais à décider", () => {
  // « Technology », « Systems », « Networks » figurent dans la moitié
  // des raisons sociales du registre. S'ils comptaient, presque tout
  // deviendrait une caméra ou une imprimante au hasard de l'ordre de la
  // table.
  for (const nom of [
    "Technology Solutions Ltd",
    "Network Systems Corporation",
    "Digital Communications Group",
    "Electronic Devices Company",
  ]) {
    assert.strictEqual(typeDepuisFabricant(nom), null, nom);
  }
});

test("une marque ne doit pas correspondre à un fragment de mot", () => {
  // « Axis » est une marque de caméras. « Praxis » contient ces quatre
  // lettres et n'a aucun rapport. La comparaison porte sur des mots
  // entiers, pas sur des sous-chaînes.
  assert.strictEqual(typeDepuisFabricant("Praxis Systems Ltd"), null);
  assert.strictEqual(typeDepuisFabricant("Maxis Communications"), null);
});

test("une marque en deux mots exige les deux", () => {
  // « Konica Minolta » ne doit pas être déduit d'un fabricant qui ne
  // porte que l'un des deux noms — ils ont désigné des sociétés
  // distinctes pendant des décennies.
  assert.strictEqual(typeDepuisFabricant("Axis Communications AB"), "camera");
  assert.strictEqual(typeDepuisFabricant("Communications AB"), null);
});

test("une saisie vide ou absurde ne fait pas échouer la règle", () => {
  for (const nom of [null, undefined, "", "   ", "???", 42]) {
    assert.doesNotThrow(() => typeDepuisFabricant(nom));
    assert.strictEqual(typeDepuisFabricant(nom), null);
  }
});
