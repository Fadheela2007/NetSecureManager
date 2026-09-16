/**
 * tests/observationDns.test.js
 *
 * Ce module dira un jour d'une machine qu'elle mine de la cryptomonnaie
 * ou qu'elle exfiltre des données. Ce sont des accusations. Les tests
 * portent donc autant sur ce qu'il doit détecter que sur ce qu'il doit
 * REFUSER de signaler — un outil qui crie au loup n'est pas prudent,
 * il est inutile, parce qu'on cesse de le lire.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  analyserNom,
  chercherCategorie,
  domaineEnregistrable,
  entropie,
  partVoyelles,
  estInfrastructure,
  nomImprobable,
  transportDeDonnees,
} = require("../src/services/observationDnsService");

/* ══ LE DOMAINE ENREGISTRABLE ══════════════════════════════════════ */

test("le domaine enregistrable retient les deux derniers niveaux", () => {
  assert.strictEqual(domaineEnregistrable("files.eu.dropbox.com"), "dropbox.com");
  assert.strictEqual(domaineEnregistrable("dropbox.com"), "dropbox.com");
  assert.strictEqual(domaineEnregistrable("WWW.Dropbox.COM."), "dropbox.com");
});

test("un suffixe composé compte pour un seul niveau", () => {
  // Sans cette règle, « monentreprise.com.cm » serait réduit à
  // « com.cm » — c'est-à-dire que toutes les entreprises camerounaises
  // seraient rangées sous un même domaine.
  assert.strictEqual(domaineEnregistrable("www.monentreprise.com.cm"), "monentreprise.com.cm");
  assert.strictEqual(domaineEnregistrable("boutique.co.uk"), "boutique.co.uk");
  assert.strictEqual(domaineEnregistrable("a.b.societe.com.cm"), "societe.com.cm");
});

test("un nom vide ou sans point ne casse rien", () => {
  assert.strictEqual(domaineEnregistrable(""), null);
  assert.strictEqual(domaineEnregistrable(null), null);
  assert.strictEqual(domaineEnregistrable("localhost"), "localhost");
});

/* ══ LA RECHERCHE, DU PLUS PRÉCIS AU PLUS GÉNÉRAL ══════════════════ */

test("UNE ENTRÉE À TROIS NIVEAUX EST BIEN TROUVÉE", () => {
  // Défaut trouvé à l'essai avant mise en service : la recherche portait
  // sur le seul domaine enregistrable, donc « teams.microsoft.com » était
  // réduit à « microsoft.com » AVANT d'être cherché. Toute entrée de plus
  // de deux niveaux était morte, sans que rien ne le signale.
  assert.strictEqual(chercherCategorie("teams.microsoft.com").categorie, "collaboration");
  assert.strictEqual(chercherCategorie("emea.teams.microsoft.com").categorie, "collaboration");
});

test("une entrée précise n'entraîne pas tout le domaine avec elle", () => {
  // « teams.microsoft.com » est rangé ; « www.microsoft.com » ne doit
  // pas l'être pour autant. Sinon ranger un service revient à ranger
  // tout le web de son éditeur.
  assert.strictEqual(chercherCategorie("www.microsoft.com"), null);
  assert.strictEqual(chercherCategorie("meet.google.com").categorie, "collaboration");
  assert.strictEqual(chercherCategorie("www.google.com"), null);
});

test("un sous-domaine hérite d'une entrée à deux niveaux", () => {
  assert.strictEqual(chercherCategorie("files.eu.dropbox.com").categorie, "partage_fichiers");
});

/* ══ CE QUI EST RECONNU ════════════════════════════════════════════ */

test("le minage est critique, le partage de fichiers seulement un avertissement", () => {
  // La nuance est le cœur du classement : Dropbox est un outil de
  // travail, un pool de minage n'a aucun usage professionnel.
  const minage = analyserNom("pool.minexmr.com");
  assert.strictEqual(minage.gravite, "critique");

  const partage = analyserNom("wetransfer.com");
  assert.strictEqual(partage.gravite, "avertissement");
});

test("la prise de contrôle à distance est signalée", () => {
  const r = analyserNom("relay.anydesk.com");
  assert.strictEqual(r.categorie, "acces_distant");
  assert.ok(r.signaux.some((s) => s.code === "acces_distant"));
});

test("un service de travail ordinaire ne déclenche aucun signal", () => {
  const r = analyserNom("teams.microsoft.com");
  assert.strictEqual(r.gravite, "information");
  assert.strictEqual(r.signaux.length, 0);
});

test("un domaine inconnu est inconnu, pas suspect", () => {
  const r = analyserNom("boutique-du-coin.cm");
  assert.strictEqual(r.categorie, null);
  assert.strictEqual(r.gravite, "information");
  assert.strictEqual(r.signaux.length, 0);
});

/* ══ CE QUI EST DÉDUIT DE LA FORME DU NOM ══════════════════════════ */

test("entropie et voyelles séparent un mot d'une chaîne au hasard", () => {
  assert.ok(entropie("x7f3q9zk2mw4p") > entropie("boutique"));
  assert.ok(partVoyelles("boutique") > 0.4);
  assert.ok(partVoyelles("x7f3q9zk2mw4p") < 0.1);
  assert.strictEqual(entropie(""), 0);
  assert.strictEqual(partVoyelles("12345"), 0);
});

test("un nom fabriqué au hasard est signalé, avec sa raison", () => {
  const s = nomImprobable("x7f3q9zk2mw4p.domaine-inconnu.xyz");
  assert.ok(s);
  assert.strictEqual(s.code, "nom_improbable");
  // La formulation compte autant que la détection : ce signal se trompe.
  assert.match(s.texte, /vérifier/);
  assert.match(s.texte, /pas une preuve/);
});

test("UN RÉSEAU DE DIFFUSION N'EST JAMAIS SIGNALÉ", () => {
  // LE test qui décide si cet écran sera lu ou ignoré. Amazon, Microsoft
  // et Google fabriquent des noms aléatoires : c'est leur fonctionnement
  // normal. Les signaler ferait de la détection une liste de faux
  // positifs dès la première minute.
  assert.strictEqual(nomImprobable("d1a2b3c4e5f6g7h8.cloudfront.net"), null);
  assert.strictEqual(nomImprobable("x7f3q9zk2mw4p8.amazonaws.com"), null);
  assert.strictEqual(analyserNom("k9x2m4p7q1.akamaiedge.net").signaux.length, 0);
  assert.ok(estInfrastructure("quoi.que.ce.soit.cloudfront.net"));
});

test("un nom court ou prononçable n'est pas signalé", () => {
  assert.strictEqual(nomImprobable("mail.exemple.cm"), null, "trop court");
  assert.strictEqual(nomImprobable("intranet-comptabilite.exemple.cm"), null, "prononçable");
  assert.strictEqual(nomImprobable("serveur-de-fichiers.societe.com"), null);
});

test("le transport de données par DNS est reconnu à sa forme", () => {
  const nom =
    "MFRGG2LOOMQWE3TY7ZQKJH4XC5.QWE3TY7ZQKJH4XC5MF.7ZQKJH4XC5MFRGG2.tunnel.exfil.com";
  const s = transportDeDonnees(nom);
  assert.ok(s, "détecté");
  assert.strictEqual(s.gravite, "critique");
  assert.match(s.texte, /DNS/);
});

test("un nom long mais légitime n'est pas pris pour une exfiltration", () => {
  // Beaucoup de niveaux ne suffit pas : il faut AUSSI que le premier
  // niveau soit long et aléatoire. Un nom interne bien rangé en a
  // souvent quatre ou cinq.
  assert.strictEqual(
    transportDeDonnees("srv.compta.interne.groupe.societe.com.cm"),
    null
  );
});

test("les deux signaux de forme ne s'affichent jamais ensemble", () => {
  // Ils décriraient le même fait deux fois, avec deux gravités
  // différentes — et l'écran donnerait l'impression de deux problèmes.
  const nom =
    "MFRGG2LOOMQWE3TY7ZQKJH4XC5.QWE3TY7ZQKJH4XC5MF.7ZQKJH4XC5MFRGG2.tunnel.exfil.com";
  const r = analyserNom(nom);
  const codes = r.signaux.map((s) => s.code);
  assert.ok(codes.includes("transport_dns"));
  assert.ok(!codes.includes("nom_improbable"), "le plus précis l'emporte");
});

test("la gravité rendue est la plus élevée des signaux", () => {
  const r = analyserNom("pool.minexmr.com");
  assert.strictEqual(r.gravite, "critique");
});

/* ══ L'AGRÉGATION — L'ÉTAPE QUI PROTÈGE ════════════════════════════ */

test("une ligne de journal dnsmasq est lue correctement", () => {
  const { lireLigneJournal } = require("../src/services/observationDnsService");
  const r = lireLigneJournal(
    "Sep 14 10:15:32 agent dnsmasq[1234]: query[A] teams.microsoft.com from 192.168.0.42"
  );
  assert.deepStrictEqual(r, { ip: "192.168.0.42", nom: "teams.microsoft.com" });
});

test("les lignes qui ne sont pas des requêtes sont ignorées", () => {
  const { lireLigneJournal } = require("../src/services/observationDnsService");
  assert.strictEqual(
    lireLigneJournal("Sep 14 10:16:02 agent dnsmasq[1234]: forwarded a.com to 8.8.8.8"),
    null
  );
  assert.strictEqual(lireLigneJournal(""), null);
  assert.strictEqual(lireLigneJournal(null), null);
});

test("les recherches inverses sont écartées", () => {
  // Elles interrogent le DNS sur une ADRESSE, pas sur un service :
  // elles n'apprennent rien et noieraient le relevé.
  const { lireLigneJournal } = require("../src/services/observationDnsService");
  assert.strictEqual(
    lireLigneJournal("Sep 14 10:15:35 a dnsmasq[1]: query[PTR] 42.0.168.192.in-addr.arpa from 192.168.0.42"),
    null
  );
});

test("L'AGRÉGATION NE LAISSE PASSER NI HEURE NI NOM COMPLET", () => {
  // LE test qui garantit la promesse faite au client. Ce qui sort d'ici
  // part vers la plateforme : s'il en sortait un horodatage ou un nom
  // complet, le relevé d'usage redeviendrait un journal de navigation.
  const { agregerRequetes } = require("../src/services/observationDnsService");
  const journal = [
    "Sep 14 10:15:32 a dnsmasq[1]: query[A] dossiers-medicaux.clinique.cm from 192.168.0.42",
    "Sep 14 10:15:33 a dnsmasq[1]: query[A] files.eu.dropbox.com from 192.168.0.42",
    "Sep 14 10:15:34 a dnsmasq[1]: query[A] www.dropbox.com from 192.168.0.42",
    "Sep 14 10:16:01 a dnsmasq[1]: query[A] pool.minexmr.com from 192.168.0.77",
  ].join("\n");

  const releves = agregerRequetes(journal);
  const texte = JSON.stringify(releves);

  assert.ok(!texte.includes("dossiers-medicaux"), "le nom complet ne sort pas");
  assert.ok(!texte.includes("10:15"), "aucune heure ne sort");
  assert.ok(texte.includes("clinique.cm"), "le domaine, lui, est bien conservé");
});

test("les requêtes identiques deviennent un compteur, par poste", () => {
  const { agregerRequetes } = require("../src/services/observationDnsService");
  const journal = [
    "Sep 14 10:15:33 a dnsmasq[1]: query[A] files.eu.dropbox.com from 192.168.0.42",
    "Sep 14 10:15:34 a dnsmasq[1]: query[A] www.dropbox.com from 192.168.0.42",
    "Sep 14 10:16:01 a dnsmasq[1]: query[A] pool.minexmr.com from 192.168.0.77",
  ].join("\n");

  const releves = agregerRequetes(journal);
  assert.strictEqual(releves.length, 2, "deux postes");

  const poste = releves.find((r) => r.ip === "192.168.0.42");
  assert.strictEqual(poste.domaines[0].domaine, "dropbox.com");
  assert.strictEqual(poste.domaines[0].n, 2, "deux noms différents, un seul domaine");
});

test("les domaines les plus demandés viennent en tête", () => {
  // Si un envoi doit être tronqué, ce sont les domaines marginaux qu'on
  // perd, jamais l'essentiel.
  const { agregerRequetes } = require("../src/services/observationDnsService");
  const lignes = [];
  for (let i = 0; i < 5; i++) {
    lignes.push("Sep 14 10:00:00 a dnsmasq[1]: query[A] beaucoup.com from 10.0.0.1");
  }
  lignes.push("Sep 14 10:00:00 a dnsmasq[1]: query[A] rare.com from 10.0.0.1");

  const [poste] = agregerRequetes(lignes.join("\n"));
  assert.strictEqual(poste.domaines[0].domaine, "beaucoup.com");
  assert.strictEqual(poste.domaines[0].n, 5);
});

test("un journal vide ne produit rien plutôt qu'une machine fantôme", () => {
  const { agregerRequetes } = require("../src/services/observationDnsService");
  assert.deepStrictEqual(agregerRequetes(""), []);
  assert.deepStrictEqual(agregerRequetes(null), []);
});
