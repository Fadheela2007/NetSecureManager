/**
 * tests/faillesService.test.js
 *
 * Ce module rattache des numéros de CVE à des machines d'un client. Une
 * erreur ici ne produit pas un écran cassé : elle produit une
 * AFFIRMATION FAUSSE sur la sécurité d'un parc — soit une alarme sans
 * fondement, soit, bien pire, un silence rassurant.
 *
 * Les tests portent donc sur les deux directions de l'erreur, et sur la
 * partie qui n'a pas besoin du réseau : la correspondance CPE et la
 * lecture d'une réponse du NVD.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  cpeDepuisProduit,
  versionNumerique,
  extraireFailles,
} = require("../src/services/faillesService");

test("la version numérique est isolée du niveau de correctif", () => {
  // Le NVD indexe la version amont ; « p1 » et « -0ubuntu… » sont des
  // habillages de distribution.
  assert.strictEqual(versionNumerique("8.2p1"), "8.2");
  assert.strictEqual(versionNumerique("8.0.32-0ubuntu0.20.04.2"), "8.0.32");
  assert.strictEqual(versionNumerique("2.4.41"), "2.4.41");
  assert.strictEqual(versionNumerique("1.18"), "1.18");
});

test("un texte sans numéro ne produit aucune version", () => {
  assert.strictEqual(versionNumerique("ready"), null);
  assert.strictEqual(versionNumerique(""), null);
  assert.strictEqual(versionNumerique(null), null);
});

test("les logiciels connus donnent leur identifiant officiel", () => {
  assert.strictEqual(cpeDepuisProduit("OpenSSH", "8.2p1"), "cpe:2.3:a:openbsd:openssh:8.2");
  assert.strictEqual(cpeDepuisProduit("Apache", "2.4.41"), "cpe:2.3:a:apache:http_server:2.4.41");
  // La casse de la bannière ne doit rien changer : « nginx », « Nginx »
  // et « NGINX » désignent le même logiciel.
  assert.strictEqual(cpeDepuisProduit("NGINX", "1.18.0"), "cpe:2.3:a:f5:nginx:1.18.0");
});

test("UN LOGICIEL INCONNU NE REÇOIT PAS D'IDENTIFIANT INVENTÉ", () => {
  // LE test le plus important du fichier. Fabriquer
  // « cpe:2.3:a:m428fdw:m428fdw » n'échouerait pas : le NVD répondrait
  // « 0 faille », et ce zéro serait affiché comme une bonne nouvelle.
  // Un silence rassurant produit par une supposition est le pire mode de
  // panne d'un outil de sécurité.
  assert.strictEqual(cpeDepuisProduit("M428fdw", "2.4.1"), null);
  assert.strictEqual(cpeDepuisProduit("", "1.0"), null);
  assert.strictEqual(cpeDepuisProduit("Apache", "sans numéro"), null);
});

test("une réponse du NVD est lue sans rien recalculer", () => {
  const reponse = {
    totalResults: 1,
    vulnerabilities: [
      {
        cve: {
          id: "CVE-2017-15906",
          published: "2017-10-26T01:29:00.417",
          descriptions: [
            { lang: "es", value: "descripción en espagnol" },
            { lang: "en", value: "The process_open function in sftp-server.c…" },
          ],
          metrics: {
            cvssMetricV31: [{ cvssData: { baseScore: 5.3, baseSeverity: "MEDIUM" } }],
          },
        },
      },
    ],
  };

  const [f] = extraireFailles(reponse);
  assert.strictEqual(f.cve_id, "CVE-2017-15906");
  assert.strictEqual(f.severite, "MEDIUM");
  assert.strictEqual(f.score, 5.3);
  assert.strictEqual(f.publie, "2017-10-26");
  assert.match(f.description, /process_open/);
});

test("la description anglaise est préférée, pas la première venue", () => {
  const [f] = extraireFailles({
    vulnerabilities: [
      {
        cve: {
          id: "CVE-0000-0001",
          descriptions: [
            { lang: "es", value: "espagnol" },
            { lang: "en", value: "anglais" },
          ],
        },
      },
    ],
  });
  assert.strictEqual(f.description, "anglais");
});

test("une entrée sans score reste exploitable, sans score inventé", () => {
  // Certaines CVE récentes n'ont pas encore de score publié. Leur en
  // attribuer un serait une invention ; les écarter ferait disparaître
  // une faille réelle. On garde la ligne, score à null.
  const [f] = extraireFailles({
    vulnerabilities: [{ cve: { id: "CVE-2026-0001", descriptions: [] } }],
  });
  assert.strictEqual(f.cve_id, "CVE-2026-0001");
  assert.strictEqual(f.score, null);
  assert.strictEqual(f.severite, null);
});

test("une réponse vide ou malformée ne produit aucune faille", () => {
  assert.deepStrictEqual(extraireFailles({}), []);
  assert.deepStrictEqual(extraireFailles({ vulnerabilities: [] }), []);
  assert.deepStrictEqual(extraireFailles(null), []);
  // Une entrée sans identifiant est écartée : une faille sans numéro CVE
  // ne se vérifie pas, donc ne s'affiche pas.
  assert.deepStrictEqual(extraireFailles({ vulnerabilities: [{ cve: {} }] }), []);
});

test("le barème le plus récent est retenu quand plusieurs coexistent", () => {
  const [f] = extraireFailles({
    vulnerabilities: [
      {
        cve: {
          id: "CVE-0000-0002",
          descriptions: [],
          metrics: {
            cvssMetricV2: [{ cvssData: { baseScore: 4.0, baseSeverity: "MEDIUM" } }],
            cvssMetricV31: [{ cvssData: { baseScore: 9.8, baseSeverity: "CRITICAL" } }],
          },
        },
      },
    ],
  });
  assert.strictEqual(f.score, 9.8);
  assert.strictEqual(f.severite, "CRITICAL");
});
