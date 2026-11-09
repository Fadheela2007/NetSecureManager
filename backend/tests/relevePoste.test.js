/**
 * tests/relevePoste.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE SOURCE EXISTE
 *
 * Le débit se lit dans des compteurs SNMP, et les postes Windows n'ont
 * plus de service SNMP depuis des années. La page Bande passante
 * n'affichait donc que les imprimantes et les commutateurs : les seuls
 * appareils d'un parc qui acceptent de dire ce qu'ils consomment.
 *
 * L'agent est DANS la machine. Il envoie les compteurs de sa carte
 * réseau et la charge de son processeur.
 *
 * ── LES DEUX FAUTES QUE CES TESTS EMPÊCHENT ──
 *
 *   1. Écrire un ZÉRO là où on n'a rien mesuré. « 0 kbit/s » se lit
 *      « cette machine ne consomme rien » ; la vérité est « on ne sait
 *      pas ». C'est la faute que toute la plateforme combat.
 *
 *   2. Perdre l'inventaire à cause du relevé. Ils arrivent dans le même
 *      envoi mais n'ont rien à voir : un compteur illisible ne doit pas
 *      faire jeter la liste des logiciels.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SERVICE = require.resolve("../src/services/inventairePosteService");
const CHEMIN_TRAFIC = require.resolve("../src/services/traficService");

function charger() {
  const inserts = [];
  const faux = {
    query: async (sql, params) => {
      if (/INSERT INTO RELEVE/i.test(String(sql))) {
        inserts.push(params);
        return [{ insertId: 1 }];
      }
      return [[]];
    },
    getConnection: async () => ({ release() {} }),
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  // traficService garde les compteurs en mémoire : on le recharge pour
  // que chaque test parte d'une mémoire vide.
  delete require.cache[CHEMIN_TRAFIC];
  delete require.cache[CHEMIN_SERVICE];
  return { service: require(CHEMIN_SERVICE), inserts };
}

/** Un envoi d'agent, avec les compteurs donnés. */
function envoi({ cpu = 25, totalMo = 8192, libreMo = 4096, reseau } = {}) {
  return {
    processeur_pourcent: cpu,
    sante: { memoire_totale_mo: totalMo, memoire_libre_mo: libreMo },
    reseau,
  };
}

const CARTE = (inO, outO, nom = "Ethernet") => [
  { index: 12, nom, in_octets: inO, out_octets: outO, vitesse_mbps: 1000 },
];

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[CHEMIN_SERVICE];
  delete require.cache[CHEMIN_TRAFIC];
});

/* ═══════════════════════════════════════════════════════════════════════
   LE PREMIER ENVOI NE DONNE PAS DE DÉBIT
   ═══════════════════════════════════════════════════════════════════════ */

test("le premier relevé écrit le processeur mais laisse le débit inconnu", async () => {
  const { service, inserts } = charger();

  const r = await service.enregistrerRelevePoste(7, envoi({ reseau: CARTE(1000, 2000) }));

  assert.equal(r.ecrit, true);
  assert.equal(r.cpu, 25);
  assert.equal(r.entrant, null, "un débit demande deux points de mesure");
  assert.equal(r.sortant, null);

  /* null, et surtout pas 0 : un zéro se lirait « cette machine ne
     consomme rien », ce qui est une affirmation qu'on n'a pas. */
  assert.equal(inserts[0][3], null);
  assert.equal(inserts[0][4], null);
});

test("le deuxième envoi donne le débit, calculé sur la différence", async () => {
  const { service } = charger();

  const t0 = 1_700_000_000_000;
  await service.enregistrerRelevePoste(7, envoi({ reseau: CARTE(0, 0) }), t0);
  // 128 000 octets reçus en 60 secondes.
  const r = await service.enregistrerRelevePoste(
    7,
    envoi({ reseau: CARTE(128000, 0) }),
    t0 + 60000
  );

  assert.ok(r.entrant > 0, "le débit doit être mesuré au deuxième envoi");
  assert.equal(r.sortant, 0, "aucun octet émis : zéro est ici une mesure, pas une absence");
});

/* ═══════════════════════════════════════════════════════════════════════
   DEUX POSTES NE SE MÉLANGENT PAS
   ═══════════════════════════════════════════════════════════════════════ */

test("deux machines ayant la même carte d'index ne partagent pas leurs compteurs", async () => {
  const { service } = charger();

  // Les deux postes ont une carte d'index 12 — c'est le cas courant.
  await service.enregistrerRelevePoste(7, envoi({ reseau: CARTE(0, 0) }));
  const premierDuSecondPoste = await service.enregistrerRelevePoste(
    9,
    envoi({ reseau: CARTE(999999999, 0) })
  );

  /* Si la clé du cache ne portait pas l'équipement, ce relevé aurait été
     comparé au compteur du poste 7 et aurait produit un débit énorme. */
  assert.equal(premierDuSecondPoste.entrant, null, "c'est le PREMIER envoi du poste 9");
});

/* ═══════════════════════════════════════════════════════════════════════
   LA BOUCLE LOCALE NE COMPTE PAS
   ═══════════════════════════════════════════════════════════════════════ */

test("la boucle locale est écartée du total", async () => {
  const { service } = charger();

  const cartes = (n) => [
    { index: 12, nom: "Ethernet", in_octets: n, out_octets: 0, vitesse_mbps: 1000 },
    {
      index: 1,
      nom: "Loopback Pseudo-Interface 1",
      in_octets: n * 100,
      out_octets: 0,
      vitesse_mbps: null,
    },
  ];

  const t0 = 1_700_000_000_000;
  await service.enregistrerRelevePoste(7, { ...envoi(), reseau: cartes(0) }, t0);
  const avecBoucle = await service.enregistrerRelevePoste(
    7,
    { ...envoi(), reseau: cartes(128000) },
    t0 + 60000
  );

  const { service: service2 } = charger();
  await service2.enregistrerRelevePoste(7, envoi({ reseau: CARTE(0, 0) }), t0);
  const sansBoucle = await service2.enregistrerRelevePoste(
    7,
    envoi({ reseau: CARTE(128000, 0) }),
    t0 + 60000
  );

  /* La boucle locale voit passer le trafic interne de la machine et
     bouge bien plus vite que le lien. La compter a déjà produit un
     facteur 96 sur une imprimante. */
  assert.ok(
    Math.abs(avecBoucle.entrant - sansBoucle.entrant) < 0.01,
    "le total doit être le même avec et sans la boucle locale"
  );
});

/* ═══════════════════════════════════════════════════════════════════════
   LA MÉMOIRE
   ═══════════════════════════════════════════════════════════════════════ */

test("la mémoire est convertie en pourcentage utilisé", async () => {
  const { service } = charger();

  const r = await service.enregistrerRelevePoste(
    7,
    envoi({ totalMo: 8192, libreMo: 2048, reseau: undefined })
  );
  assert.equal(r.ram, 75, "6144 utilisés sur 8192");
});

test("une mémoire absente ou incohérente ne produit pas de chiffre", async () => {
  const { service } = charger();

  for (const sante of [
    undefined,
    {},
    { memoire_totale_mo: 0, memoire_libre_mo: 0 },
    { memoire_totale_mo: 8192, memoire_libre_mo: null },
  ]) {
    const r = await service.enregistrerRelevePoste(7, {
      processeur_pourcent: 10,
      sante,
    });
    assert.equal(r.ram, null, JSON.stringify(sante));
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   NE RIEN MESURER N'ÉCRIT RIEN
   ═══════════════════════════════════════════════════════════════════════ */

test("un envoi sans aucune mesure n'écrit pas de ligne", async () => {
  const { service, inserts } = charger();

  /* Un agent installé sur un Windows trop ancien pour Get-NetAdapter, et
     dont la charge processeur n'a pas pu être lue, envoie quand même son
     inventaire. Une ligne de relevé à quatre colonnes nulles n'apprend
     rien et alourdit une table qui compte en millions. */
  const r = await service.enregistrerRelevePoste(7, {
    processeur_pourcent: null,
    sante: null,
    reseau: null,
  });

  assert.equal(r.ecrit, false);
  assert.equal(inserts.length, 0);
});

test("le relevé est écrit même sans compteurs réseau", async () => {
  const { service, inserts } = charger();

  const r = await service.enregistrerRelevePoste(7, envoi({ reseau: null }));

  assert.equal(r.ecrit, true, "le processeur seul mérite une ligne");
  assert.equal(inserts[0][1], 25);
  assert.equal(inserts[0][3], null);
});
