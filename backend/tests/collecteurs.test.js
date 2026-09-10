/**
 * tests/collecteurs.test.js
 *
 * L'analyse d'un `tasklist` ou d'un `dpkg -l` est exactement le genre de
 * code qui marche sur l'exemple du développeur et casse sur le poste du
 * client : un nom avec une virgule, un séparateur de milliers selon la
 * langue, une colonne vide, un seul résultat au lieu de plusieurs.
 *
 * Ces tests tournent sans Windows, sans PowerShell et sans machine
 * réelle : c'est la seule façon de fixer ce comportement.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  decouperCsv,
  memoireEnKo,
  analyserTasklist,
  analyserPs,
  analyserLogicielsWindows,
  analyserDpkg,
  dateInstallationWindows,
  identite,
} = require("../src/agent-poste/collecteurs");

test("le découpage CSV respecte les guillemets", () => {
  const champs = decouperCsv('"chrome.exe","1234","Console","1","250 000 Ko"');
  assert.deepStrictEqual(champs, ["chrome.exe", "1234", "Console", "1", "250 000 Ko"]);
});

test("UNE VIRGULE DANS UN NOM NE DÉCALE PAS LES COLONNES", () => {
  // Un `split(",")` naïf mettrait « Machin » dans le nom et « Truc.exe »
  // dans le PID : toutes les colonnes suivantes glissent, et la mémoire
  // d'un processus finit par être lue comme son nom.
  const champs = decouperCsv('"Machin, Truc.exe","99","Console","1","12 Ko"');
  assert.strictEqual(champs[0], "Machin, Truc.exe");
  assert.strictEqual(champs[1], "99");
  assert.strictEqual(champs[4], "12 Ko");
});

test("la mémoire se lit quelle que soit la langue du système", () => {
  // Windows sépare les milliers selon sa langue : espace insécable en
  // français, virgule en anglais. L'ignorer donnait 250 au lieu de 250000.
  assert.strictEqual(memoireEnKo("250 000 Ko"), 250000);
  assert.strictEqual(memoireEnKo("250,000 K"), 250000);
  assert.strictEqual(memoireEnKo("1" + String.fromCharCode(160) + "234 Ko"), 1234);
  assert.strictEqual(memoireEnKo(""), null);
  assert.strictEqual(memoireEnKo("N/A"), null);
});

test("tasklist — les processus sont regroupés par nom", () => {
  // Un navigateur ouvre vingt processus. Les lister vingt fois n'apprend
  // rien de plus que « il tourne, en vingt exemplaires ».
  const sortie = [
    '"Nom de l\'image","PID","Nom de la session","Numéro de session","Utilisation mémoire"',
    '"chrome.exe","100","Console","1","200 000 Ko"',
    '"chrome.exe","101","Console","1","150 000 Ko"',
    '"explorer.exe","200","Console","1","40 000 Ko"',
  ].join("\r\n");

  const p = analyserTasklist(sortie);
  const chrome = p.find((x) => x.nom === "chrome.exe");
  assert.strictEqual(p.length, 2);
  assert.strictEqual(chrome.occurrences, 2);
  assert.strictEqual(chrome.memoire_ko, 350000, "les mémoires s'additionnent");
});

test("tasklist — l'en-tête est écarté quelle que soit la langue", () => {
  // On teste la VALEUR et non la position : un agent déployé sur un
  // Windows anglais ne doit pas inventorier un processus « Image Name ».
  const fr = analyserTasklist('"Nom de l\'image","PID"\r\n"a.exe","1","x","1","1 Ko"');
  const en = analyserTasklist('"Image Name","PID"\r\n"a.exe","1","x","1","1 Ko"');
  assert.deepStrictEqual(fr.map((p) => p.nom), ["a.exe"]);
  assert.deepStrictEqual(en.map((p) => p.nom), ["a.exe"]);
});

test("le nom d'utilisateur reste vide tant qu'il n'est pas demandé", () => {
  // LA vie privée n'est pas un réglage qu'on découvre. Sans /v et sans
  // l'option, aucune colonne utilisateur ne doit remonter.
  const ligne = '"a.exe","1","Console","1","1 Ko","0:00:01","BUREAU\\alice"';
  assert.strictEqual(analyserTasklist(ligne)[0].utilisateur, null);
  assert.strictEqual(analyserTasklist(ligne, true)[0].utilisateur, "BUREAU\\alice");
});

test("ps — même regroupement sous Linux, chemin retiré", () => {
  const p = analyserPs("/usr/bin/node 50000\nnode 30000\nsshd 2000\n");
  const node = p.find((x) => x.nom === "node");
  assert.strictEqual(node.occurrences, 2);
  assert.strictEqual(node.memoire_ko, 80000);
});

test("registre Windows — UN SEUL logiciel n'est pas perdu", () => {
  // PowerShell rend un OBJET quand il n'y a qu'un résultat, un TABLEAU
  // au-delà. Supposer toujours un tableau perd silencieusement ce cas.
  const seul = analyserLogicielsWindows(
    '{"DisplayName":"7-Zip","DisplayVersion":"23.01","Publisher":"Igor Pavlov","InstallDate":"20240115"}'
  );
  assert.strictEqual(seul.length, 1);
  assert.strictEqual(seul[0].nom, "7-Zip");
  assert.strictEqual(seul[0].date_installation, "2024-01-15");

  const plusieurs = analyserLogicielsWindows(
    '[{"DisplayName":"A","DisplayVersion":"1"},{"DisplayName":"B"}]'
  );
  assert.strictEqual(plusieurs.length, 2);
  assert.strictEqual(plusieurs[1].version, null);
});

test("une entrée de registre sans nom est écartée", () => {
  // Le registre contient des clés de désinstallation vides : les garder
  // remplirait l'inventaire de lignes anonymes.
  const r = analyserLogicielsWindows('[{"DisplayVersion":"1.0"},{"DisplayName":"Vrai"}]');
  assert.deepStrictEqual(r.map((l) => l.nom), ["Vrai"]);
});

test("une sortie PowerShell illisible ne fait pas tomber l'agent", () => {
  assert.deepStrictEqual(analyserLogicielsWindows("Accès refusé."), []);
  assert.deepStrictEqual(analyserLogicielsWindows(""), []);
  assert.deepStrictEqual(analyserLogicielsWindows(null), []);
});

test("la date du registre n'accepte que des dates plausibles", () => {
  assert.strictEqual(dateInstallationWindows("20240115"), "2024-01-15");
  // « 20241332 » : mois 13, jour 32. Une date fausse en base est pire
  // qu'une case vide — elle passerait tous les filtres par période.
  assert.strictEqual(dateInstallationWindows("20241332"), null);
  assert.strictEqual(dateInstallationWindows(""), null);
  assert.strictEqual(dateInstallationWindows("15/01/2024"), null);
});

test("dpkg — les trois colonnes sont lues", () => {
  const r = analyserDpkg("nginx\t1.18.0-0ubuntu1\tUbuntu Devs\nopenssh-server\t8.2p1\t\n");
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].nom, "nginx");
  assert.strictEqual(r[0].version, "1.18.0-0ubuntu1");
  assert.strictEqual(r[1].editeur, null);
});

test("l'identité écarte les cartes virtuelles et le bouclage", () => {
  // Une machine qui s'annoncerait en 127.0.0.1 ne pourrait être
  // rapprochée d'aucun équipement : l'agent semblerait ne rien remonter.
  const faux = {
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true, mac: "00:00:00:00:00:00" }],
    "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.0.1", internal: false, mac: "aa:bb:cc:00:00:01" }],
    "Ethernet": [{ family: "IPv4", address: "192.168.0.42", internal: false, mac: "aa:bb:cc:dd:ee:ff" }],
  };
  const moi = identite(faux);
  assert.strictEqual(moi.adresse_ip, "192.168.0.42");
  assert.strictEqual(moi.adresse_mac, "aa:bb:cc:dd:ee:ff");
});

test("une machine sans carte utilisable ne prétend pas en avoir une", () => {
  const moi = identite({ lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] });
  assert.strictEqual(moi.adresse_ip, null);
});
