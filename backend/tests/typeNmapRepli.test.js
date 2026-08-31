/**
 * tests/typeNmapRepli.test.js
 * Le repli générique de l'estimation nmap.
 *
 * Ces tests sont nés d'un relevé sur un parc réel, pas d'une hypothèse :
 * treize appareils portaient la même « identification » nmap. Un cas
 * qu'aucune relecture de code n'aurait fait apparaître, et que seule la
 * colonne type_source a permis de remonter jusqu'à sa cause.
 */
const test = require("node:test");
const assert = require("node:assert");
const { determinerType } = require("../src/services/typeService");

/* =====================================================================
   Le repli générique de nmap.

   Relevé sur le parc réel : TREIZE appareils — un téléphone Honor,
   plusieurs Android, des objets connectés sur deux sous-réseaux — tous
   classés « routeur », tous porteurs de la MÊME estimation nmap :

       « 3Com OfficeConnect 3CRWER100-75 wireless broadband router (96%) »

   Ce n'est pas une identification mais la réponse par défaut de nmap
   devant une petite pile réseau embarquée.
   ===================================================================== */

const REPLI_NMAP = "3Com OfficeConnect 3CRWER100-75 wireless broadband router (96%)";

test("l'estimation générique de nmap ne produit plus de type", () => {
  const r = determinerType({ osDetecte: REPLI_NMAP });
  assert.strictEqual(r.type, "inconnu", "un modèle de produit n'est pas une catégorie");
});

test("un téléphone n'est pas classé routeur par le repli nmap", () => {
  // Le cas exact de 192.168.0.51 : fabricant Honor (fiable, issu de
  // l'adresse matérielle) contre une estimation nmap annonçant du 3Com.
  const r = determinerType({ osDetecte: REPLI_NMAP, fabricant: "Honor Device" });
  assert.notStrictEqual(r.type, "routeur");
});

test("le texte SNMP reste, lui, digne de confiance", () => {
  // Un équipement qui se DÉCLARE routeur en SNMP l'est. La distinction
  // porte sur la source, pas sur les mots.
  const r = determinerType({ sysDescr: "MikroTik RouterOS 7.11 sur RB750" });
  assert.strictEqual(r.type, "routeur");
  assert.strictEqual(r.source, "snmp");
});

test("un vrai commutateur en SNMP est toujours reconnu", () => {
  const r = determinerType({ sysDescr: "Cisco IOS Software, C2960 Catalyst" });
  assert.strictEqual(r.type, "routeur/switch");
});

test("la catégorie annoncée par nmap reste exploitée", () => {
  // C'est ce qui rattrape les vrais routeurs sans SNMP : nmapDeviceType
  // annonce une CATÉGORIE, pas un modèle.
  const r = determinerType({ nmapDeviceType: "broadband router", osDetecte: REPLI_NMAP });
  assert.strictEqual(r.type, "routeur");
  assert.strictEqual(r.source, "nmap_device");
});

test("nmap reste utile pour la famille de système", () => {
  // Ce que nmap sait vraiment faire : reconnaître un système, pas
  // deviner une catégorie de matériel à partir d'un nom de modèle.
  assert.strictEqual(determinerType({ osDetecte: "Microsoft Windows 10 1909" }).type, "poste_travail");
  assert.strictEqual(determinerType({ osDetecte: "Apple macOS 12" }).type, "poste_travail");
});

test("un port révélateur prime sur toute estimation nmap", () => {
  const r = determinerType({ osDetecte: REPLI_NMAP, ports: [{ port: 9100 }] });
  assert.strictEqual(r.type, "imprimante");
  assert.strictEqual(r.source, "port");
});
