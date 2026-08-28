/**
 * tests/politiqueWeb.test.js
 *
 * Le blocage web est la fonction la plus visible du produit et la plus
 * facile à rater silencieusement. Deux erreurs coûtent cher :
 *
 *   • bloquer trop — « notfacebook.com » pris pour « facebook.com »
 *     empêche quelqu'un de travailler, et personne ne comprend pourquoi ;
 *   • bloquer trop peu — une règle qui ne correspond à rien laisse
 *     l'interface annoncer « bloqué » alors que le site s'ouvre.
 *
 * Les deux se voient en démonstration, devant l'acheteur.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  normaliserDomaine,
  estSousDomaine,
  verdictManuel,
  compilerPolitique,
  genererDnsmasq,
  genererReglesPareFeu,
} = require("../src/services/politiqueWebService");

// ─────────────────────────────────────────────────────────────────────
// NORMALISATION
// ─────────────────────────────────────────────────────────────────────
test("les saisies réelles d'un administrateur sont acceptées", () => {
  // Personne ne tape un domaine nu. On colle une URL, une ligne de
  // fichier hosts, ce qu'on a sous la main.
  const cas = [
    ["exemple.com", "exemple.com"],
    ["  Exemple.COM  ", "exemple.com"],
    ["https://www.exemple.com/page?a=1", "www.exemple.com"],
    ["http://exemple.com", "exemple.com"],
    ["exemple.com.", "exemple.com"],
    ["exemple.com:8080", "exemple.com"],
    ["*.exemple.com", "exemple.com"],
    ["0.0.0.0 pub.exemple.com", "pub.exemple.com"],
    ["127.0.0.1 traceur.exemple.com # régie", "traceur.exemple.com"],
    ["exemple.com # commentaire", "exemple.com"],
  ];

  for (const [saisie, attendu] of cas) {
    assert.strictEqual(normaliserDomaine(saisie), attendu, `saisie : ${JSON.stringify(saisie)}`);
  }
});

test("les saisies inexploitables sont rejetées, pas transformées en règle fantôme", () => {
  // Accepter « localhost » produirait une ligne de configuration valide
  // qui ne bloque rien. L'interface afficherait une règle active et le
  // site resterait accessible — le pire des deux mondes.
  for (const mauvais of ["", "   ", "localhost", "192.168.1.1", "pas un domaine", "exemple", "..", null, undefined, 42]) {
    assert.strictEqual(normaliserDomaine(mauvais), null, `devrait être rejeté : ${JSON.stringify(mauvais)}`);
  }
});

test("www. n'est pas retiré : c'est une règle légitime en soi", () => {
  // Bloquer www.exemple.com sans bloquer exemple.com doit rester
  // exprimable. Le « nettoyage intelligent » retirerait ce choix.
  assert.strictEqual(normaliserDomaine("www.exemple.com"), "www.exemple.com");
});

// ─────────────────────────────────────────────────────────────────────
// CORRESPONDANCE — le piège principal
// ─────────────────────────────────────────────────────────────────────
test("le blocage couvre les sous-domaines", () => {
  assert.strictEqual(estSousDomaine("www.facebook.com", "facebook.com"), true);
  assert.strictEqual(estSousDomaine("m.facebook.com", "facebook.com"), true);
  assert.strictEqual(estSousDomaine("cdn.static.facebook.com", "facebook.com"), true);
  assert.strictEqual(estSousDomaine("facebook.com", "facebook.com"), true);
});

test("le blocage ne déborde PAS sur un domaine voisin", () => {
  // Le piège : une comparaison par « se termine par » fait correspondre
  // notfacebook.com à facebook.com. La frontière doit être un point.
  assert.strictEqual(estSousDomaine("notfacebook.com", "facebook.com"), false);
  assert.strictEqual(estSousDomaine("myfacebook.com", "facebook.com"), false);
  assert.strictEqual(estSousDomaine("facebook.com.exemple.net", "facebook.com"), false);
  assert.strictEqual(estSousDomaine("facebook.company", "facebook.com"), false);
});

// ─────────────────────────────────────────────────────────────────────
// PRÉCÉDENCE DES RÈGLES
// ─────────────────────────────────────────────────────────────────────
test("la règle la plus spécifique l'emporte, quel que soit l'ordre de saisie", () => {
  // Cas courant : « bloquer exemple.com, sauf la boutique ». Si le
  // résultat dépendait de l'ordre des clics, la même politique donnerait
  // deux comportements différents.
  const regles = [
    { domaine: "exemple.com", action: "bloquer" },
    { domaine: "boutique.exemple.com", action: "autoriser" },
  ];

  assert.strictEqual(verdictManuel("exemple.com", regles), "bloquer");
  assert.strictEqual(verdictManuel("boutique.exemple.com", regles), "autoriser");
  assert.strictEqual(verdictManuel("panier.boutique.exemple.com", regles), "autoriser");
  assert.strictEqual(verdictManuel("blog.exemple.com", regles), "bloquer");

  // Ordre inversé : même résultat.
  const inverse = [...regles].reverse();
  assert.strictEqual(verdictManuel("boutique.exemple.com", inverse), "autoriser");
});

test("à spécificité égale, on laisse passer", () => {
  // Principe de prudence : un site bloqué à tort empêche quelqu'un de
  // travailler, un site autorisé à tort ne casse rien.
  const regles = [
    { domaine: "exemple.com", action: "bloquer" },
    { domaine: "exemple.com", action: "autoriser" },
  ];
  assert.strictEqual(verdictManuel("exemple.com", regles), "autoriser");
});

test("un domaine sans règle manuelle ne reçoit aucun verdict", () => {
  assert.strictEqual(verdictManuel("autre.com", [{ domaine: "exemple.com", action: "bloquer" }]), null);
});

// ─────────────────────────────────────────────────────────────────────
// COMPILATION
// ─────────────────────────────────────────────────────────────────────
test("une exception manuelle retire un domaine de la liste des catégories", () => {
  // Le cas qui fait abandonner un filtrage : la liste publique bloque le
  // fournisseur dont l'entreprise a besoin. Sans exception praticable,
  // l'administrateur désactive toute la catégorie.
  const r = compilerPolitique({
    domainesCategories: ["pub.exemple.com", "traceur.net", "outil-metier.com"],
    reglesManuelles: [{ domaine: "outil-metier.com", action: "autoriser" }],
  });

  assert.ok(!r.bloquer.includes("outil-metier.com"), "le domaine autorisé ne doit pas être bloqué");
  assert.ok(r.bloquer.includes("traceur.net"));
  assert.strictEqual(r.stats.exclus_par_exception, 1);
  assert.deepStrictEqual(r.autoriser, ["outil-metier.com"]);
});

test("l'exception couvre aussi les sous-domaines du domaine autorisé", () => {
  const r = compilerPolitique({
    domainesCategories: ["cdn.outil-metier.com", "api.outil-metier.com"],
    reglesManuelles: [{ domaine: "outil-metier.com", action: "autoriser" }],
  });

  assert.deepStrictEqual(r.bloquer, [], "aucun sous-domaine ne doit rester bloqué");
});

test("un ajout manuel s'ajoute aux catégories", () => {
  const r = compilerPolitique({
    domainesCategories: ["pub.exemple.com"],
    reglesManuelles: [{ domaine: "distraction.com", action: "bloquer" }],
  });

  assert.ok(r.bloquer.includes("distraction.com"));
  assert.ok(r.bloquer.includes("pub.exemple.com"));
});

test("les saisies invalides sont comptées, pas silencieusement ignorées", () => {
  // Une règle rejetée sans le dire laisse l'administrateur croire qu'un
  // site est bloqué. L'interface doit pouvoir le lui signaler.
  const r = compilerPolitique({
    domainesCategories: [],
    reglesManuelles: [
      { domaine: "valide.com", action: "bloquer" },
      { domaine: "localhost", action: "bloquer" },
      { domaine: "192.168.1.1", action: "bloquer" },
    ],
  });

  assert.strictEqual(r.stats.rejetees, 2);
  assert.deepStrictEqual(r.stats.exemples_rejetes, ["localhost", "192.168.1.1"]);
  assert.deepStrictEqual(r.bloquer, ["valide.com"]);
});

test("la compaction retire les sous-domaines déjà couverts", () => {
  // Sur 300 000 entrées, garder les redondances alourdit la
  // configuration du résolveur pour rien.
  const r = compilerPolitique({
    domainesCategories: ["exemple.com", "pub.exemple.com", "cdn.pub.exemple.com", "autre.net"],
    reglesManuelles: [],
  });

  assert.deepStrictEqual(r.bloquer, ["autre.net", "exemple.com"]);
  assert.strictEqual(r.stats.compactes, 2);
});

test("la compaction ne détruit PAS une exception vivant sous le domaine parent", () => {
  // Le bug qu'il fallait éviter : compacter « boutique.exemple.com » dans
  // « exemple.com » ferait perdre l'exception, car dnsmasq n'aurait plus
  // aucun moyen de la rétablir. La boutique deviendrait inaccessible sans
  // que rien ne l'indique dans l'interface.
  const r = compilerPolitique({
    domainesCategories: ["exemple.com", "blog.exemple.com"],
    reglesManuelles: [{ domaine: "boutique.exemple.com", action: "autoriser" }],
  });

  assert.ok(r.bloquer.includes("exemple.com"));
  assert.ok(
    r.bloquer.includes("blog.exemple.com"),
    "blog reste listé explicitement car exemple.com porte une exception"
  );
  assert.deepStrictEqual(r.autoriser, ["boutique.exemple.com"]);
});

test("les doublons entre catégories sont fusionnés", () => {
  // Un domaine figure souvent dans « publicité » ET « pistage ».
  const r = compilerPolitique({
    domainesCategories: ["traceur.net", "traceur.net", "TRACEUR.NET", "https://traceur.net/"],
    reglesManuelles: [],
  });

  assert.deepStrictEqual(r.bloquer, ["traceur.net"]);
});

test("une liste réelle de 100 000 domaines se compile en moins de 5 secondes", () => {
  // ─────────────────────────────────────────────────────────────────
  // TEST DE PERFORMANCE, et il a une histoire.
  //
  // La première version comparait chaque domaine à tous ceux déjà
  // retenus. Coût quadratique : mesuré à 11 s pour 30 000 domaines, soit
  // près de deux minutes pour une liste publicité réelle.
  //
  // Le symptôme chez l'utilisateur était muet et trompeur :
  //   [Agent site 1] Politique web indisponible : timeout of 60000ms exceeded
  // L'agent semblait fautif, alors que le serveur calculait encore. Pire,
  // Node.js travaillant sur un seul fil, la plateforme entière ne
  // répondait plus pendant ce temps.
  //
  // Aucun test ne l'avait vu : les jeux d'essai comptaient quelques
  // dizaines de domaines, où même un algorithme quadratique est instantané.
  // C'est la leçon que ce test fige — sur cette fonction, la taille des
  // données EST le cas limite.
  //
  // Le seuil de 5 s est large exprès : il ne doit pas échouer sur une
  // machine lente, seulement si le coût redevient quadratique. Dans ce
  // cas, il dépasserait la minute.
  // ─────────────────────────────────────────────────────────────────
  const domaines = [];
  for (let b = 0; b < 12000; b++) {
    domaines.push(`exemple-${b}.com`);
    for (let s = 0; s < 7; s++) domaines.push(`sous${s}.exemple-${b}.com`);
  }
  for (let b = 0; b < 12000; b++) domaines.push(`cdn.orphelin-${b}.net`);

  const debut = Date.now();
  const r = compilerPolitique({ domainesCategories: domaines, reglesManuelles: [] });
  const duree = Date.now() - debut;

  assert.ok(duree < 5000, `compilation en ${duree} ms — attendu moins de 5 000 ms`);

  // La compaction doit VRAIMENT avoir eu lieu : un algorithme rapide qui
  // ne compacte plus rien passerait le test de durée tout en produisant
  // un fichier quatre fois trop gros.
  assert.ok(
    r.stats.compactes > 80000,
    `seulement ${r.stats.compactes} domaines compactés — la compaction ne fonctionne plus`
  );
  assert.ok(r.bloquer.includes("exemple-5.com"));
  assert.ok(!r.bloquer.includes("sous0.exemple-5.com"), "le sous-domaine doit être absorbé");
});

test("sur une grande liste, une exception empêche la compaction de son parent", () => {
  // Le risque du nouvel algorithme : aller vite en perdant l'exception.
  // Si « sous0.exemple-5.com » était absorbé dans « exemple-5.com »,
  // dnsmasq n'aurait plus aucun moyen de rétablir « boutique... ».
  const domaines = [];
  for (let b = 0; b < 5000; b++) {
    domaines.push(`exemple-${b}.com`, `sous0.exemple-${b}.com`);
  }

  const r = compilerPolitique({
    domainesCategories: domaines,
    reglesManuelles: [{ domaine: "boutique.exemple-5.com", action: "autoriser" }],
  });

  assert.ok(
    r.bloquer.includes("sous0.exemple-5.com"),
    "le parent porte une exception : ses enfants restent listés explicitement"
  );
  assert.ok(
    !r.bloquer.includes("sous0.exemple-6.com"),
    "un parent sans exception absorbe bien ses enfants"
  );
  assert.deepStrictEqual(r.autoriser, ["boutique.exemple-5.com"]);
});

test("une politique vide ne bloque rien et ne plante pas", () => {
  const r = compilerPolitique({});
  assert.deepStrictEqual(r.bloquer, []);
  assert.deepStrictEqual(r.autoriser, []);
  assert.strictEqual(r.stats.total_bloques, 0);
});

// ─────────────────────────────────────────────────────────────────────
// GÉNÉRATION DE CONFIGURATION
// ─────────────────────────────────────────────────────────────────────
test("la configuration dnsmasq contient les bonnes directives", () => {
  const compilee = compilerPolitique({
    domainesCategories: ["pub.net"],
    reglesManuelles: [{ domaine: "metier.com", action: "autoriser" }],
  });
  const conf = genererDnsmasq(compilee, { version: 7, nomSite: "Douala", ipBlocage: "192.168.10.5" });

  assert.ok(conf.includes("address=/pub.net/192.168.10.5"), "le blocage doit pointer vers l'IP fournie");
  assert.ok(conf.includes("server=/metier.com/#"), "l'exception doit repartir vers le résolveur amont");
  assert.ok(conf.includes("Version de politique : 7"));
  assert.ok(conf.includes("Douala"));

  // Fuites d'information vers les résolveurs publics : deux directives
  // qui doivent toujours être là.
  assert.ok(conf.includes("domain-needed"));
  assert.ok(conf.includes("bogus-priv"));
});

test("chaque domaine est bloqué en IPv4 ET en IPv6", () => {
  // ─────────────────────────────────────────────────────────────────
  // LE TROU QUI RENDAIT LE BLOCAGE DÉCORATIF.
  //
  // `address=/domaine/0.0.0.0` ne couvre que les questions IPv4. Les
  // questions IPv6 (AAAA) étaient transmises aux résolveurs publics, qui
  // répondaient la vraie adresse. Tous les navigateurs actuels préférant
  // l'IPv6 quand elle existe, le site s'ouvrait normalement.
  //
  // Le plus dangereux : la vérification habituelle (`nslookup` en IPv4)
  // montrait un blocage parfait. Constaté en conditions réelles :
  //   A     172.24.145.179            -> BLOQUÉ
  //   AAAA  2a00:1450:4006:809::200e  -> NON BLOQUÉ
  // ─────────────────────────────────────────────────────────────────
  const compilee = compilerPolitique({
    domainesCategories: ["pub.net", "traceur.com"],
    reglesManuelles: [],
  });
  const conf = genererDnsmasq(compilee, { ipBlocage: "0.0.0.0" });

  for (const domaine of ["pub.net", "traceur.com"]) {
    assert.ok(
      conf.includes(`address=/${domaine}/0.0.0.0`),
      `${domaine} doit être bloqué en IPv4`
    );
    assert.ok(
      conf.includes(`address=/${domaine}/::`),
      `${domaine} doit être bloqué en IPv6 — sans cette ligne, le blocage est contournable sans rien faire`
    );
  }
});

test("le blocage IPv6 est présent même quand l'IPv4 pointe vers l'agent", () => {
  // La plateforme fait pointer l'IPv4 vers l'agent lui-même, pour y
  // servir un jour une page d'explication. L'IPv6 doit rester bloquée
  // pour autant : oublier ce cas rétablirait le trou dès qu'une adresse
  // d'agent est connue, c'est-à-dire en fonctionnement normal.
  const compilee = compilerPolitique({ domainesCategories: ["pub.net"], reglesManuelles: [] });
  const conf = genererDnsmasq(compilee, { ipBlocage: "192.168.10.5" });

  assert.ok(conf.includes("address=/pub.net/192.168.10.5"));
  assert.ok(conf.includes("address=/pub.net/::"));
});

test("la configuration avertit qu'elle est générée", () => {
  // Sans cet avertissement, un administrateur modifie le fichier à la
  // main, sa correction disparaît à la mise à jour suivante, et il
  // conclut que le produit est capricieux.
  const conf = genererDnsmasq(compilerPolitique({}), {});
  assert.ok(/ne pas modifier à la main/i.test(conf));
});

test("les règles de pare-feu ferment les trois voies de contournement", () => {
  const regles = genererReglesPareFeu("192.168.10.5", "iptables");

  // 1. DNS classique vers l'extérieur
  assert.ok(regles.includes("--dport 53 -j REJECT"), "le DNS externe doit être refusé");
  assert.ok(regles.includes("-d 192.168.10.5 -j ACCEPT"), "le résolveur local doit rester joignable");

  // 2. DNS-over-TLS
  assert.ok(regles.includes("--dport 853"), "le port DoT doit être traité");

  // 3. DNS-over-HTTPS, par adresse (le nom est chiffré)
  assert.ok(regles.includes("1.1.1.1"), "Cloudflare DoH");
  assert.ok(regles.includes("8.8.8.8"), "Google DoH");
  assert.ok(regles.includes("9.9.9.9"), "Quad9 DoH");
});

test("l'autorisation du résolveur local précède le refus général", () => {
  // Ordre inversé = plus aucune résolution DNS sur le site. C'est la
  // panne la plus brutale que ce produit puisse provoquer chez un client.
  const regles = genererReglesPareFeu("192.168.10.5", "iptables");
  const posAccept = regles.indexOf("-d 192.168.10.5 -j ACCEPT");
  const posReject = regles.indexOf("--dport 53 -j REJECT");

  assert.ok(posAccept < posReject, "ACCEPT doit venir avant REJECT");
});

test("un format non généré donne des consignes, pas un script faux", () => {
  // Une règle de pare-feu inventée coupe le réseau du client. Mieux vaut
  // dire « faites ceci à la main » que produire une syntaxe plausible.
  const regles = genererReglesPareFeu("192.168.10.5", "pfsense");

  assert.ok(!regles.includes("iptables"), "pas de syntaxe d'un autre système");
  assert.ok(/à la main/i.test(regles));
  assert.ok(regles.includes("L'ordre compte"));
});
