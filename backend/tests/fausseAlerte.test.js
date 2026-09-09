/**
 * tests/fausseAlerte.test.js
 *
 * UN OUTIL DE SUPERVISION NE DOIT PAS INVENTER DE PANNES.
 *
 * Le défaut corrigé : quand le ping échouait, `diagnosePanne` testait les
 * ports TCP, trouvait le port 80 ouvert, écrivait « probablement un
 * pare-feu qui bloque le ping » — et l'alerte critique partait quand même.
 * La preuve que la machine fonctionnait était recueillie, puis ignorée.
 *
 * Conséquence sur le terrain : un technicien se déplace pour vérifier une
 * machine qui marche. Deux fois, et plus personne ne lit les alertes.
 *
 * Ces tests portent sur la LISTE DES PORTS interrogés, qui décide de tout :
 * une liste qui ne contient pas les ports d'un poste Windows laisse passer
 * le cas le plus fréquent d'un parc bureautique.
 */

const test = require("node:test");
const assert = require("node:assert");
const { PORTS_SIGNE_DE_VIE } = require("../src/services/discoveryService");

test("les ports d'un poste Windows sont interrogés", () => {
  // C'EST LE TEST QUI COMPTE.
  //
  // L'ancienne liste — 80, 443, 22, 3389, 8080 — décrit un serveur ou un
  // équipement réseau. Un poste Windows ordinaire n'expose aucun de ces
  // cinq ports, mais expose 445 (partage de fichiers) et 139 (NetBIOS).
  // Sans eux, tout un parc bureautique qui bloque le ping était déclaré
  // en panne.
  assert.ok(
    PORTS_SIGNE_DE_VIE.includes(445),
    "445 (SMB) est le port le plus discriminant d'un poste Windows vivant"
  );
  assert.ok(PORTS_SIGNE_DE_VIE.includes(139), "139 (NetBIOS) doit être testé");
});

test("445 est interrogé en premier", () => {
  // L'ordre a une valeur documentaire : il dit quel cas on considère comme
  // le plus fréquent. Sur un réseau d'entreprise, c'est le poste Windows.
  assert.strictEqual(PORTS_SIGNE_DE_VIE[0], 445);
});

test("les ports des serveurs et équipements réseau restent testés", () => {
  // La correction ne doit rien retirer : un serveur web muet au ping doit
  // continuer d'être reconnu comme vivant.
  for (const port of [80, 443, 22, 3389, 8080]) {
    assert.ok(
      PORTS_SIGNE_DE_VIE.includes(port),
      `${port} figurait dans la liste d'origine et doit y rester`
    );
  }
});

test("les imprimantes muettes au ping sont couvertes", () => {
  // Une imprimante réseau qui ignore l'ICMP mais accepte les travaux
  // d'impression est en service. La déclarer en panne enverrait quelqu'un
  // vérifier une machine qui imprime.
  assert.ok(PORTS_SIGNE_DE_VIE.includes(9100), "9100 — impression brute");
  assert.ok(PORTS_SIGNE_DE_VIE.includes(631), "631 — IPP");
});

test("aucun doublon dans la liste", () => {
  // Un doublon coûterait une connexion TCP inutile par équipement et par
  // vérification, sur tout le parc.
  assert.strictEqual(
    new Set(PORTS_SIGNE_DE_VIE).size,
    PORTS_SIGNE_DE_VIE.length,
    "chaque port ne doit être interrogé qu'une fois"
  );
});

test("la liste reste courte", () => {
  // Les ports sont testés en parallèle : le coût en temps ne dépend pas de
  // leur nombre. Mais chaque port est une connexion TCP ouverte vers
  // l'équipement — sur un parc en panne générale, une liste trop longue
  // multiplie le trafic au pire moment.
  assert.ok(
    PORTS_SIGNE_DE_VIE.length <= 12,
    `${PORTS_SIGNE_DE_VIE.length} ports : au-delà de douze, on sonde plus qu'on ne diagnostique`
  );
});
