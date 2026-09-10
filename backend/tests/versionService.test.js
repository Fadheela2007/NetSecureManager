/**
 * tests/versionService.test.js
 *
 * L'extraction d'une version est une affaire d'expressions régulières, et
 * une expression régulière trop gourmande produit une valeur PLAUSIBLE et
 * FAUSSE — le pire résultat possible ici, puisque c'est sur cette valeur
 * qu'un rapprochement avec une faille connue se fera un jour.
 *
 * Ces tests fixent donc autant ce qu'on doit lire que ce qu'on doit
 * REFUSER de lire.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  separerProduitVersion,
  lireSsh,
  lireLigneAccueil,
  lireMysql,
  lireEnteteServeur,
  nettoyer,
} = require("../src/services/versionService");

test("SSH — la bannière donne le produit et sa version", () => {
  const r = lireSsh("SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5\r\n");
  assert.strictEqual(r.produit, "OpenSSH");
  assert.strictEqual(r.version, "8.2p1");
});

test("SSH — une implémentation autre qu'OpenSSH est reconnue aussi", () => {
  const r = lireSsh("SSH-2.0-dropbear_2019.78\r\n");
  assert.strictEqual(r.produit, "dropbear");
  assert.strictEqual(r.version, "2019.78");
});

test("SSH — un texte qui n'est pas une bannière SSH ne rend rien", () => {
  assert.strictEqual(lireSsh("HTTP/1.1 200 OK"), null);
  assert.strictEqual(lireSsh(""), null);
});

test("FTP et SMTP — le code de réponse et le nom d'hôte sont écartés", () => {
  const ftp = lireLigneAccueil("220 ProFTPD 1.3.5 Server (Debian) [::ffff:10.0.0.4]\r\n");
  assert.strictEqual(ftp.produit, "ProFTPD");
  assert.strictEqual(ftp.version, "1.3.5");

  const smtp = lireLigneAccueil("220 mail.exemple.fr ESMTP Exim 4.94 Ubuntu\r\n");
  assert.strictEqual(smtp.produit, "Exim");
  assert.strictEqual(smtp.version, "4.94");
});

test("POP3 — un produit sans numéro reste une information utile", () => {
  const r = lireLigneAccueil("+OK Dovecot ready.\r\n");
  assert.strictEqual(r.produit, "Dovecot");
  assert.strictEqual(r.version, null);
});

test("MySQL — la version se lit dans la poignée de main binaire", () => {
  // Poignée de main réelle : des octets de protocole illisibles, puis la
  // version en clair. Ils sont construits ici plutôt qu'écrits en dur —
  // un fichier source ne doit pas contenir d'octets invisibles.
  const poignee =
    String.fromCharCode(74, 0, 0, 0, 10) + "8.0.32-0ubuntu0.20.04.2" + String.fromCharCode(0);
  const r = lireMysql(poignee);
  assert.strictEqual(r.produit, "MySQL");
  assert.strictEqual(r.version, "8.0.32-0ubuntu0.20.04.2");
});

test("MariaDB est distingué de MySQL", () => {
  const poignee =
    String.fromCharCode(90, 0, 0, 0, 10) + "5.5.5-10.6.12-MariaDB-1" + String.fromCharCode(0);
  assert.strictEqual(lireMysql(poignee).produit, "MariaDB");
});

test("en-tête HTTP Server — le nom entre parenthèses n'est pas la version", () => {
  const r = lireEnteteServeur("Apache/2.4.41 (Ubuntu)");
  assert.strictEqual(r.produit, "Apache");
  assert.strictEqual(r.version, "2.4.41");

  const iis = lireEnteteServeur("Microsoft-IIS/10.0");
  assert.strictEqual(iis.produit, "Microsoft-IIS");
  assert.strictEqual(iis.version, "10.0");
});

test("aucune version n'est inventée là où il n'y en a pas", () => {
  // « Server ready » ne doit jamais devenir un numéro de version.
  assert.strictEqual(separerProduitVersion("Welcome to the server"), null);
  assert.strictEqual(separerProduitVersion(""), null);
  assert.strictEqual(separerProduitVersion("   "), null);
});

test("un numéro isolé sans produit n'est pas retenu", () => {
  // « 220 » seul est un code de réponse, pas une version.
  assert.strictEqual(lireLigneAccueil("220 \r\n"), null);
});

test("la bannière brute est nettoyée des octets illisibles", () => {
  assert.strictEqual(nettoyer("abc" + String.fromCharCode(0, 1) + " def\r\n"), "abc def");
});

test("une version à une seule décimale est acceptée, pas un entier seul", () => {
  assert.strictEqual(separerProduitVersion("nginx/1.18")?.version, "1.18");
  // « Postfix 2 » : un entier seul n'est pas une version identifiable.
  const r = separerProduitVersion("Postfix 2");
  assert.strictEqual(r.version, null, "un entier isolé ne fait pas une version");
  assert.strictEqual(r.produit, "Postfix");
});

test("un séparateur en trois caractères est accepté — le cas des imprimantes", () => {
  // « HP LaserJet MFP M428fdw - 2.4.1 » : « espace tiret espace ». Un
  // séparateur d'un seul caractère laissait passer à côté du
  // micrologiciel de toutes les imprimantes du parc.
  const r = lireEnteteServeur("HP HTTP Server; HP LaserJet MFP M428fdw - 2.4.1");
  assert.strictEqual(r.version, "2.4.1");
});

test("un mot de liaison n'est jamais pris pour un nom de logiciel", () => {
  // Sans ce filtre, « ... ready - 2.4 » donnait le produit « ready » :
  // une valeur plausible et fausse, le pire résultat possible ici.
  assert.strictEqual(separerProduitVersion("Server ready - 2.4"), null);
  assert.strictEqual(separerProduitVersion("welcome 1.0"), null);
});
