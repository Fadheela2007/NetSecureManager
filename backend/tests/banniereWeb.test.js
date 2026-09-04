/**
 * tests/banniereWeb.test.js
 *
 * La bannière web sert à REMPLIR des cases restées vides — imprimantes,
 * caméras et NAS muets en SNMP servent presque tous une page
 * d'administration dont le titre porte le modèle exact.
 *
 * Le risque est symétrique : une page web dit n'importe quoi. Un titre
 * « Router Login » ne fait pas de la machine un routeur, et « Bienvenue »
 * n'apprend rien. Ces tests fixent les deux limites : ce qu'on accepte, et
 * surtout ce qu'on refuse.
 */

const test = require("node:test");
const assert = require("node:assert");
const { extraireBanniere } = require("../src/services/banniereWebService");
const { determinerType } = require("../src/services/typeService");

/* ── Extraction ───────────────────────────────────────────────────── */

test("retient un titre de page qui nomme un modèle", () => {
  const b = extraireBanniere("<html><head><title>HP LaserJet MFP M428fdw</title></head>", null);
  assert.strictEqual(b.titre, "HP LaserJet MFP M428fdw");
});

test("normalise les espaces et les entités HTML", () => {
  const b = extraireBanniere("<title>Synology&nbsp;&amp;   DiskStation\n  DS216j</title>", null);
  assert.strictEqual(b.titre, "Synology & DiskStation DS216j");
});

test("un titre sans intérêt est rejeté plutôt que rangé dans la fiche", () => {
  // Une case remplie par « Login » est pire qu'une case vide : elle donne
  // l'illusion d'une information et personne ne la corrigera jamais.
  for (const inutile of ["Login", "Sign in", "Connexion", "index", "Index of /", "Welcome", "404"]) {
    const b = extraireBanniere(`<title>${inutile}</title>`, null);
    assert.strictEqual(b.titre, null, `« ${inutile} » ne doit rien apprendre`);
  }
});

test("un titre trop long est une phrase, pas un nom d'appareil", () => {
  const phrase = "Bienvenue sur le portail interne de l'entreprise, merci de vous identifier avant de poursuivre votre navigation";
  const b = extraireBanniere(`<title>${phrase}</title>`, null);
  assert.strictEqual(b.titre, null);
});

test("une page sans titre ne fabrique rien", () => {
  assert.strictEqual(extraireBanniere("<html><body>bonjour</body></html>", null).titre, null);
  assert.strictEqual(extraireBanniere("", null).titre, null);
  assert.strictEqual(extraireBanniere(null, null).titre, null);
});

test("l'en-tête Server est retenu s'il désigne l'appareil", () => {
  assert.strictEqual(extraireBanniere("", "HP HTTP Server").serveur, "HP HTTP Server");
  assert.strictEqual(extraireBanniere("", "Hikvision-Webs").serveur, "Hikvision-Webs");
});

test("un serveur web générique n'apprend rien sur le matériel", () => {
  // « nginx » ne dit pas quel appareil c'est : des dizaines de milliers de
  // machines très différentes répondent la même chose.
  for (const generique of ["nginx", "Apache/2.4.52", "lighttpd/1.4.59", "Microsoft-IIS/10.0", "Express"]) {
    assert.strictEqual(
      extraireBanniere("", generique).serveur,
      null,
      `« ${generique} » ne doit pas être retenu`
    );
  }
});

/* ── Classification : la bannière ne doit pas usurper la confiance SNMP ── */

test("la bannière classe une imprimante muette en SNMP", () => {
  const r = determinerType({ banniereWeb: "HP LaserJet MFP M428fdw" });
  assert.strictEqual(r.source, "banniere_web");
  assert.notStrictEqual(r.type, "inconnu");
});

test("« Router » dans un titre de page ne fait PAS un routeur", () => {
  // C'EST LE TEST CENTRAL DE CE FICHIER.
  //
  // Les règles d'équipement réseau sont réservées au texte SNMP, que
  // l'appareil déclare lui-même. Un titre de page contenant « router »
  // peut venir d'un portail de connexion, d'une documentation servie par
  // un poste, ou d'une page d'aide. Leur donner la confiance du SNMP
  // reproduirait le défaut des treize téléphones classés « routeur » à
  // partir d'une estimation nmap.
  const r = determinerType({ banniereWeb: "Router Login Page" });
  assert.notStrictEqual(
    r.type,
    "routeur",
    "un titre de page ne doit pas déclencher les règles réservées au SNMP"
  );
});

test("le texte SNMP garde la priorité sur la bannière", () => {
  // `sysDescr` porte un mot que typeService reconnaît (« LaserJet ») ; la
  // bannière en porte un autre, contradictoire. C'est SNMP qui doit
  // trancher, puisque c'est l'équipement lui-même qui le déclare.
  const r = determinerType({
    sysDescr: "HP LaserJet Pro MFP, JetDirect",
    banniereWeb: "Synology DiskStation",
  });
  assert.strictEqual(r.source, "snmp", "SNMP est déclaré par l'équipement, il passe devant");
});

test("les ports ouverts gardent la priorité sur la bannière", () => {
  // Un port 9100 ouvert est un fait ; un titre de page est un libellé.
  const r = determinerType({
    ports: [{ port: 9100, nom_service: "JetDirect" }],
    banniereWeb: "Synology DiskStation",
  });
  assert.strictEqual(r.source, "port");
});

test("la bannière passe avant nmap", () => {
  // nmap donne un système d'exploitation, la bannière un modèle.
  const r = determinerType({
    banniereWeb: "HP LaserJet MFP M428fdw",
    osDetecte: "Linux 2.6.32 - 3.10",
  });
  assert.strictEqual(r.source, "banniere_web");
});

test("sans aucun signal, on ne devine toujours pas", () => {
  const r = determinerType({ banniereWeb: null });
  assert.strictEqual(r.type, "inconnu");
  assert.strictEqual(r.source, "aucune");
});
