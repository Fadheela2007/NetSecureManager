/**
 * tests/nomServiceMdns.test.js
 * Le mDNS est du DNS binaire. Ces tests fabriquent des réponses
 * conformes à la RFC 1035 et vérifient qu'on en tire le bon nom, sans
 * réseau.
 *
 * Une leçon retenue du NetBIOS : le constructeur de test suit la
 * structure du PROTOCOLE, pas les décalages supposés par l'analyseur.
 * Sinon le test reproduit l'erreur du code et la valide.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  encoderNomDns,
  nomInverse,
  construireRequeteMdns,
  extraireNomMdns,
  estNomDappareil,
} = require("../src/services/nomService");

test("l'adresse est retournée en notation in-addr.arpa", () => {
  assert.strictEqual(nomInverse("192.168.0.18"), "18.0.168.192.in-addr.arpa");
});

test("l'encodage DNS préfixe chaque étiquette par sa longueur", () => {
  const encode = encoderNomDns("cam.local");
  // 3 'c' 'a' 'm' 5 'l' 'o' 'c' 'a' 'l' 0
  assert.deepStrictEqual([...encode], [3, 99, 97, 109, 5, 108, 111, 99, 97, 108, 0]);
});

test("la requête mDNS demande bien un PTR", () => {
  const requete = construireRequeteMdns("192.168.0.18");
  assert.strictEqual(requete.readUInt16BE(4), 1, "une question");
  assert.strictEqual(requete.readUInt16BE(requete.length - 4), 0x000c, "type PTR");
});

test("la requête mDNS porte le bit QU", () => {
  // Sans ce bit, l'appareil répond sur le groupe de diffusion et non à
  // nous : la réponse existe mais part à une adresse qu'on n'écoute pas.
  const requete = construireRequeteMdns("192.168.0.18");
  const classe = requete.readUInt16BE(requete.length - 2);
  assert.strictEqual(classe & 0x8000, 0x8000, "bit QU — réponse en point à point");
  assert.strictEqual(classe & 0x7fff, 0x0001, "classe IN");
});

/** Fabrique une réponse DNS/mDNS. */
function fabriquerReponse(enregistrements, options = {}) {
  const { echoQuestion = true } = options;

  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(echoQuestion ? 1 : 0, 4);
  entete.writeUInt16BE(enregistrements.length, 6);

  const morceaux = [entete];

  if (echoQuestion) {
    morceaux.push(
      encoderNomDns("18.0.168.192.in-addr.arpa"),
      Buffer.from([0x00, 0x0c, 0x00, 0x01])
    );
  }

  for (const { nom, type, donnees } of enregistrements) {
    const corps =
      type === 0x000c ? encoderNomDns(donnees) : Buffer.from(donnees || [192, 168, 0, 18]);
    const enTete = Buffer.alloc(10);
    enTete.writeUInt16BE(type, 0);
    enTete.writeUInt16BE(0x0001, 2); // classe IN
    enTete.writeUInt32BE(120, 4); // durée de vie
    enTete.writeUInt16BE(corps.length, 8);
    morceaux.push(encoderNomDns(nom), enTete, corps);
  }

  return Buffer.concat(morceaux);
}

test("un enregistrement PTR donne le nom de l'appareil", () => {
  const reponse = fabriquerReponse([
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "CAMERA-ENTREE.local" },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), "CAMERA-ENTREE");
});

test("le suffixe .local est retiré", () => {
  const reponse = fabriquerReponse([
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "imprimante-rh.local" },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), "imprimante-rh");
});

test("un enregistrement A donne le nom porté par l'enregistrement", () => {
  // Certains appareils répondent spontanément par un A plutôt qu'un PTR.
  const reponse = fabriquerReponse([
    { nom: "HP-LaserJet.local", type: 0x0001, donnees: [192, 168, 0, 50] },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), "HP-LaserJet");
});

test("une réponse sans question répétée est lue correctement", () => {
  const reponse = fabriquerReponse(
    [{ nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "NAS-BUREAU.local" }],
    { echoQuestion: false }
  );
  assert.strictEqual(extraireNomMdns(reponse), "NAS-BUREAU");
});

test("un type inconnu est ignoré au profit du suivant", () => {
  // Une réponse mDNS mêle souvent plusieurs types. S'arrêter au premier
  // enregistrement ferait manquer le seul qui porte le nom.
  const reponse = fabriquerReponse([
    { nom: "_services._dns-sd._udp.local", type: 0x0021, donnees: [0, 0, 0, 0] },
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "TV-SALLE-REUNION.local" },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), "TV-SALLE-REUNION");
});

/* ---------------------------------------------------------------------
   Tri entre noms d'appareils et types de service.

   Cas relevé sur le réseau réel : la sonde a fait remonter « _printer »,
   « _http », « _ipps », « _raop », « _ssh ». Ce sont des services
   annoncés, jamais des noms de machine. Sans ce tri, trois imprimantes
   du parc se seraient toutes appelées « _printer ».
   --------------------------------------------------------------------- */

test("un type de service n'est jamais pris pour un nom d'appareil", () => {
  for (const service of ["_printer", "_http", "_ipps", "_raop", "_ssh", "_apple-mobdev2"]) {
    assert.strictEqual(estNomDappareil(service), false, service);
  }
});

test("un nom d'appareil ordinaire est accepté", () => {
  for (const nom of ["CAMERA-ENTREE", "HP-LaserJet", "imprimante-rh", "NAS-BUREAU"]) {
    assert.strictEqual(estNomDappareil(nom), true, nom);
  }
});

test("un nom de résolution inverse n'est pas un nom d'appareil", () => {
  assert.strictEqual(estNomDappareil("18.0.168.192.in-addr.arpa"), false);
});

test("une réponse annonçant un service ne produit aucun nom", () => {
  // C'est la réponse type à une découverte de services : la donnée est
  // « _printer._tcp.local ». La retenir donnerait le même nom à toutes
  // les imprimantes du parc.
  const reponse = fabriquerReponse([
    { nom: "_services._dns-sd._udp.local", type: 0x000c, donnees: "_printer._tcp.local" },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), null);
});

test("le vrai nom est retenu même quand un service le précède", () => {
  const reponse = fabriquerReponse([
    { nom: "_services._dns-sd._udp.local", type: 0x000c, donnees: "_ipps._tcp.local" },
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "IMPRIMANTE-RH.local" },
  ]);
  assert.strictEqual(extraireNomMdns(reponse), "IMPRIMANTE-RH");
});

test("une réponse tronquée ne fait pas tomber le scan", () => {
  assert.strictEqual(extraireNomMdns(Buffer.alloc(0)), null);
  assert.strictEqual(extraireNomMdns(Buffer.alloc(8)), null);
  assert.strictEqual(extraireNomMdns(null), null);
});

test("une réponse n'annonçant aucun enregistrement est refusée", () => {
  const reponse = fabriquerReponse([
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "PC.local" },
  ]);
  reponse.writeUInt16BE(0, 6);
  assert.strictEqual(extraireNomMdns(reponse), null);
});

test("un pointeur de compression qui boucle sur lui-même ne fige pas la lecture", () => {
  // Un appareil défaillant — ou hostile — peut émettre un pointeur qui
  // se désigne lui-même. Sans limite de sauts, la lecture tournerait
  // sans fin et bloquerait le scan entier : Node est mono-thread.
  const reponse = fabriquerReponse([
    { nom: "18.0.168.192.in-addr.arpa", type: 0x000c, donnees: "X.local" },
  ]);
  const pointeurVersLuiMeme = reponse.length - 2;
  reponse[pointeurVersLuiMeme] = 0xc0;
  reponse[pointeurVersLuiMeme + 1] = pointeurVersLuiMeme;

  // Le seul contrat qui compte : la fonction rend la main.
  assert.doesNotThrow(() => extraireNomMdns(reponse));
});
