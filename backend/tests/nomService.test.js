/**
 * tests/nomService.test.js
 * L'encodage NetBIOS est du binaire : il ne se relit pas à l'œil. Ces
 * tests fabriquent une réponse conforme à la RFC 1002 et vérifient
 * qu'on en extrait le bon nom — sans réseau.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  encoderNomNetbios,
  construireRequeteNetbios,
  extraireNomNetbios,
} = require("../src/services/nomService");

test("l'encodage NetBIOS de « * » donne la valeur de référence", () => {
  // Valeur documentée dans la RFC 1001 : '*' suivi de 15 octets nuls.
  // 0x2A → quartets 2 et A → 'C' et 'K'. Puis 15 × 0x00 → 30 × 'A'.
  const encode = encoderNomNetbios("*").toString("ascii");
  assert.strictEqual(encode, "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.strictEqual(encode.length, 32);
});

test("l'encodage NetBIOS respecte le découpage en quartets", () => {
  // 'A' = 0x41 → quartets 4 et 1 → 'E' et 'B'.
  const encode = encoderNomNetbios("A").toString("ascii");
  assert.strictEqual(encode.slice(0, 2), "EB");
});

test("la requête NBSTAT a la forme attendue", () => {
  const requete = construireRequeteNetbios();

  assert.strictEqual(requete.length, 50, "12 d'en-tête + 38 de question");
  assert.strictEqual(requete.readUInt16BE(4), 1, "une seule question");
  assert.strictEqual(requete[12], 32, "longueur de l'étiquette de nom");
  // Le nom encodé occupe les octets 13 à 44, l'octet 45 le termine :
  // le type commence donc à 46, pas à 45.
  assert.strictEqual(requete[45], 0x00, "fin du nom");
  assert.strictEqual(requete.readUInt16BE(46), 0x0021, "type NBSTAT");
  assert.strictEqual(requete.readUInt16BE(48), 0x0001, "classe IN");
});

/**
 * Fabrique une réponse NBSTAT conforme à la RFC 1002.
 *
 * `options.echoQuestion` — toutes les piles NetBIOS ne répètent pas la
 * question dans leur réponse. `options.compresse` — certaines
 * remplacent le nom par un pointeur de deux octets.
 *
 * Ces deux variantes ne sont pas théoriques : c'est en les ignorant que
 * la première version renvoyait « SKTOP-A89OVC3 » pour une machine
 * nommée « DESKTOP-A89OVC3 ». Un nom tronqué de deux lettres reste
 * d'apparence plausible — d'où la nécessité de tester chaque forme.
 */
function fabriquerReponse(entrees, options = {}) {
  const { echoQuestion = true, compresse = false } = options;

  const nomEncode = () =>
    compresse
      ? Buffer.from([0xc0, 0x0c]) // pointeur vers l'octet 12
      : Buffer.concat([Buffer.from([32]), Buffer.alloc(32, 0x41), Buffer.from([0x00])]);

  const entete = Buffer.alloc(12);
  entete.writeUInt16BE(echoQuestion ? 1 : 0, 4);
  entete.writeUInt16BE(1, 6); // une réponse

  const morceaux = [entete];

  if (echoQuestion) {
    morceaux.push(nomEncode(), Buffer.alloc(4)); // type + classe
  }

  // Enregistrement de réponse.
  morceaux.push(nomEncode(), Buffer.alloc(8)); // type, classe, durée de vie
  morceaux.push(Buffer.alloc(2)); // longueur des données
  morceaux.push(Buffer.from([entrees.length]));

  for (const { nom, suffixe, groupe } of entrees) {
    const bloc = Buffer.alloc(18, 0x20); // le nom est complété par des espaces
    Buffer.from(nom, "ascii").copy(bloc, 0);
    bloc[15] = suffixe;
    bloc.writeUInt16BE(groupe ? 0x8000 : 0x0400, 16);
    morceaux.push(bloc);
  }

  return Buffer.concat(morceaux);
}

test("un nom de 15 caractères n'est pas tronqué", () => {
  // Le défaut constaté sur le réseau : « DESKTOP-A89OVC3 » revenait
  // amputé de ses deux premières lettres. 15 caractères est la longueur
  // MAXIMALE d'un nom NetBIOS — donc le cas le plus exposé.
  const reponse = fabriquerReponse([
    { nom: "DESKTOP-A89OVC3", suffixe: 0x00, groupe: false },
  ]);
  assert.strictEqual(extraireNomNetbios(reponse), "DESKTOP-A89OVC3");
});

test("une réponse SANS question répétée est lue correctement", () => {
  // Toutes les piles ne renvoient pas la question. Un décalage fixe
  // calculé en la supposant présente lit alors 38 octets trop loin.
  const reponse = fabriquerReponse(
    [{ nom: "DESKTOP-A89OVC3", suffixe: 0x00, groupe: false }],
    { echoQuestion: false }
  );
  assert.strictEqual(extraireNomNetbios(reponse), "DESKTOP-A89OVC3");
});

test("une réponse à nom compressé est lue correctement", () => {
  // Le pointeur de compression tient sur 2 octets au lieu de 34.
  const reponse = fabriquerReponse(
    [{ nom: "SRV-FICHIERS", suffixe: 0x00, groupe: false }],
    { compresse: true }
  );
  assert.strictEqual(extraireNomNetbios(reponse), "SRV-FICHIERS");
});

test("une réponse n'annonçant aucun enregistrement est refusée", () => {
  const reponse = fabriquerReponse([{ nom: "PC-X", suffixe: 0x00, groupe: false }]);
  reponse.writeUInt16BE(0, 6); // zéro réponse annoncée
  assert.strictEqual(extraireNomNetbios(reponse), null);
});

test("le nom de station de travail est extrait", () => {
  const reponse = fabriquerReponse([
    { nom: "PC-COMPTA", suffixe: 0x00, groupe: false },
  ]);
  assert.strictEqual(extraireNomNetbios(reponse), "PC-COMPTA");
});

test("le nom de groupe de travail n'est jamais confondu avec la machine", () => {
  // Piège réel : le nom de domaine porte le MÊME suffixe 0x00 que la
  // machine, et n'en diffère que par le drapeau de groupe. Sans cette
  // distinction, toutes les machines s'appelleraient « SOCIETE ».
  const reponse = fabriquerReponse([
    { nom: "SOCIETE", suffixe: 0x00, groupe: true },
    { nom: "PC-ACCUEIL", suffixe: 0x00, groupe: false },
  ]);
  assert.strictEqual(extraireNomNetbios(reponse), "PC-ACCUEIL");
});

test("les services autres que la station de travail sont ignorés", () => {
  // Suffixe 0x20 = service de partage de fichiers, pas un nom de machine.
  const reponse = fabriquerReponse([
    { nom: "PC-BUREAU", suffixe: 0x20, groupe: false },
    { nom: "PC-BUREAU", suffixe: 0x00, groupe: false },
  ]);
  assert.strictEqual(extraireNomNetbios(reponse), "PC-BUREAU");
});

test("une réponse tronquée ne fait pas tomber le scan", () => {
  assert.strictEqual(extraireNomNetbios(Buffer.alloc(5)), null);
  assert.strictEqual(extraireNomNetbios(Buffer.alloc(0)), null);
});

test("une réponse annonçant plus de noms qu'elle n'en contient est tolérée", () => {
  // Un équipement mal implémenté peut annoncer 8 entrées et n'en envoyer
  // qu'une. Lire au-delà du tampon lèverait, et une exception ici
  // annulerait l'analyse de l'hôte entier.
  const reponse = fabriquerReponse([{ nom: "PC-X", suffixe: 0x00, groupe: false }]);
  // L'octet du nombre d'entrées se trouve juste avant la première :
  // 18 octets par entrée, donc à 19 octets de la fin pour une seule.
  reponse[reponse.length - 19] = 8; // annonce 8 entrées, n'en contient qu'une
  assert.strictEqual(extraireNomNetbios(reponse), "PC-X");
});

test("aucun nom exploitable renvoie null plutôt qu'une valeur inventée", () => {
  const reponse = fabriquerReponse([
    { nom: "SOCIETE", suffixe: 0x00, groupe: true },
  ]);
  assert.strictEqual(extraireNomNetbios(reponse), null);
});
