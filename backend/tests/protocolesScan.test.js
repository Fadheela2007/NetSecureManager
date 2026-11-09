/**
 * tests/protocolesScan.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CHAQUE PORT AJOUTÉ DOIT GAGNER SA PLACE
 *
 * `scanPorts` teste les ports d'une machine en parallèle, mais une
 * machine muette fait expirer chaque tentative : le coût se compte en
 * sockets ouverts simultanément. Un port « au cas où » ralentit tous les
 * scans de tous les clients, pour rien.
 *
 * Trois justifications possibles, et il en faut au moins une :
 *   • NOMMER un service qu'on rencontre réellement dans une PME ;
 *   • CLASSER une machine qui ne se décrit nulle part ailleurs ;
 *   • SIGNALER un risque — un Telnet ou un VNC en clair.
 *
 * ── CE QUE CES TESTS SURVEILLENT ──
 *
 * Qu'un port classant soit VRAIMENT mono-usage. Déduire « imprimante »
 * d'un port qu'un poste de travail ouvre aussi remplirait l'inventaire
 * de types faux — et un inventaire faux est pire qu'un inventaire vide,
 * parce qu'on s'y fie.
 */

const test = require("node:test");
const assert = require("node:assert");

const { PORTS_SIGNE_DE_VIE } = require("../src/services/discoveryService");
const { PORTS_REVELATEURS, determinerType } = require("../src/services/typeService");

/* ═══════════════════════════════════════════════════════════════════════
   LES SERVICES NOMMÉS
   ═══════════════════════════════════════════════════════════════════════ */

test("les protocoles d'un réseau d'entreprise sont reconnus", () => {
  const source = require("node:fs").readFileSync(
    require.resolve("../src/services/discoveryService"),
    "utf8"
  );
  const debut = source.indexOf("const PORTS_COURANTS = {");
  const bloc = source.slice(debut, source.indexOf("\n};", debut));

  /* Les familles qu'une PME possède vraiment : un domaine Windows, des
     bases, du stockage, de la téléphonie, de la virtualisation. */
  for (const [port, service] of [
    [88, "Kerberos"],
    [389, "LDAP"],
    [5985, "WinRM"],
    [1433, "SQL Server"],
    [2049, "NFS"],
    [5060, "SIP"],
    [902, "VMware"],
    [5900, "VNC"],
  ]) {
    assert.match(
      bloc,
      new RegExp(`${port}:\\s*"${service}`),
      `le port ${port} doit être nommé « ${service} »`
    );
  }
});

test("aucun port n'est déclaré deux fois", () => {
  /* Une clé répétée dans un objet JavaScript écrase la première SANS
     erreur : le service afficherait alors un nom pour un autre. */
  const source = require("node:fs").readFileSync(
    require.resolve("../src/services/discoveryService"),
    "utf8"
  );
  const debut = source.indexOf("const PORTS_COURANTS = {");
  const bloc = source.slice(debut, source.indexOf("\n};", debut));

  // Seules les vraies déclarations : « 445: "SMB" », pas « le port 445 ».
  const declares = [...bloc.matchAll(/(\d+):\s*"/g)].map((m) => Number(m[1]));
  const uniques = new Set(declares);

  assert.equal(declares.length, uniques.size, "un port est déclaré deux fois");
  assert.ok(declares.length >= 35, "la liste doit couvrir les familles ajoutées");
});

/* ═══════════════════════════════════════════════════════════════════════
   LES PORTS QUI CLASSENT
   ═══════════════════════════════════════════════════════════════════════ */

test("SIP désigne la téléphonie", () => {
  const r = determinerType({ ports: [{ port: 5060 }] });
  assert.equal(r.type, "telephonie");
  assert.equal(r.source, "port");
});

test("Kerberos et LDAP désignent un serveur, pas un poste", () => {
  /* Un poste de travail CONSOMME ces services, il ne les expose jamais.
     La machine qui les sert est la plus importante du réseau — et elle
     ne se présente nulle part comme telle. */
  assert.equal(determinerType({ ports: [{ port: 88 }] }).type, "serveur");
  assert.equal(determinerType({ ports: [{ port: 389 }] }).type, "serveur");
});

test("un hyperviseur n'est pas classé poste de travail", () => {
  /* Il porte des dizaines de machines : se tromper là est l'erreur la
     plus coûteuse de l'inventaire. */
  assert.equal(determinerType({ ports: [{ port: 902 }] }).type, "serveur");
  assert.equal(determinerType({ ports: [{ port: 8006 }] }).type, "serveur");
});

test("les ports partagés ne classent RIEN", () => {
  /* RDP, SMB, SSH, HTTP sont sur des postes comme sur des serveurs.
     En déduire un type remplirait l'inventaire de valeurs fausses. */
  for (const port of [22, 80, 443, 445, 3389, 8080, 135, 139, 5985]) {
    const r = determinerType({ ports: [{ port }] });
    assert.equal(
      r.type,
      "inconnu",
      `le port ${port} ne doit permettre aucune conclusion`
    );
  }
});

test("chaque port classant est bien dans la liste des ports scannés", () => {
  /* Un port révélateur qui n'est jamais interrogé ne révèle rien : la
     règle existerait sans jamais pouvoir s'appliquer. */
  const source = require("node:fs").readFileSync(
    require.resolve("../src/services/discoveryService"),
    "utf8"
  );
  const debut = source.indexOf("const PORTS_COURANTS = {");
  const bloc = source.slice(debut, source.indexOf("\n};", debut));
  const scannes = new Set([...bloc.matchAll(/(\d+):\s*"/g)].map((m) => Number(m[1])));

  for (const port of PORTS_REVELATEURS.keys()) {
    assert.ok(scannes.has(port), `le port ${port} classe mais n'est pas scanné`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   LES MACHINES MUETTES AU PING
   ═══════════════════════════════════════════════════════════════════════ */

test("WinRM et DNS élargissent la détection des machines pare-feutées", () => {
  /* Sur les Windows récents, le partage de fichiers est souvent fermé
     alors que l'administration distante reste ouverte. Un serveur DNS,
     lui, ne répond presque jamais sur les autres ports de la liste. */
  assert.ok(PORTS_SIGNE_DE_VIE.includes(5985), "WinRM");
  assert.ok(PORTS_SIGNE_DE_VIE.includes(53), "DNS");
});

test("l'ordre des ports de présence va du plus répandu au plus rare", () => {
  /* La première réponse suffit et arrête le reste : commencer par un
     port rare ferait attendre l'expiration de celui-là sur toutes les
     machines qui ne l'exposent pas. */
  assert.equal(PORTS_SIGNE_DE_VIE[0], 445, "le partage Windows d'abord");
  assert.ok(
    PORTS_SIGNE_DE_VIE.indexOf(445) < PORTS_SIGNE_DE_VIE.indexOf(9100),
    "le partage Windows avant l'impression"
  );
});
