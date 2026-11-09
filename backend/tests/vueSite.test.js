/**
 * tests/vueSite.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * UNE VUE QUI S'ASSEMBLE TOUTE SEULE
 *
 * Ailleurs, un tableau de bord se CONSTRUIT : on ajoute une tuile, on
 * choisit l'élément à surveiller, on règle l'unité, on recommence pour
 * chaque machine. Ici, le contenu découle de ce que le scan a trouvé.
 *
 * ── LES DEUX FAUTES QUE CES TESTS EMPÊCHENT ──
 *
 *   1. COMPTER « SANS ÉTAT CONNU » COMME « HORS LIGNE ». Une machine
 *      dont on n'a aucune nouvelle n'est pas une machine en panne. Les
 *      additionner ferait annoncer des pannes imaginaires, et c'est la
 *      faute qui fait perdre confiance en un outil de supervision.
 *
 *   2. RENDRE ZÉRO LÀ OÙ L'ON NE SAIT PAS. Une migration non passée doit
 *      rendre `null` — « nous ne savons pas » — jamais 0, qui se lit
 *      « il n'y en a pas ».
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test-sans-valeur";

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SITES = require.resolve("../src/routes/sites");

const SITE = { id_site: 3, nom: "Cabinet Ngando", ville: "Douala", dernier_push: null };

/**
 * @param {object} reponses  ce que rend chaque famille de requête.
 * @param {RegExp} absente   les requêtes qui doivent échouer en
 *                           « colonne inconnue » (migration non passée).
 */
function charger({ reponses = {}, absente = null } = {}) {
  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      if (absente && absente.test(propre)) {
        throw new Error("Unknown column 'preuve_existence' in 'field list'");
      }
      if (/FROM SITE WHERE id_site/i.test(propre)) return [[SITE]];
      if (/SUM\(statut = 'up'\)/i.test(propre)) {
        return [[reponses.parc || { total: 10, en_ligne: 6, hors_ligne: 1, inconnu: 3 }]];
      }
      if (/TYPE_EQUIPEMENT/i.test(propre)) {
        return [reponses.types || [{ libelle: "imprimante", nombre: 4 }]];
      }
      /* Le motif le plus SPÉCIFIQUE d'abord : les deux requêtes lisent
         ALERTE, et « FROM ALERTE » attrapait aussi celle des problèmes. */
      if (/FIELD\(a\.niveau/i.test(propre)) return [reponses.problemes || []];
      if (/FROM ALERTE/i.test(propre)) {
        return [[reponses.alertes || { actives: 2, critiques: 1 }]];
      }
      if (/preuve_existence/i.test(propre)) {
        return [reponses.preuves || [{ preuve: "ping", nombre: 6, plus_ancienne: null }]];
      }
      if (/ORDER BY kbps DESC/i.test(propre)) return [reponses.consommateurs || []];
      if (/FROM PLAGE_SCAN/i.test(propre)) {
        return [reponses.plages || [{ cidr: "192.168.0.0/24", actif: 1 }]];
      }
      if (/MAX\(date_preuve\)/i.test(propre)) return [[{ quand: null }]];
      if (/DATE_FORMAT/i.test(propre)) return [reponses.historique || []];
      if (/AVG\(r\.cpu_pourcent\) AS cpu/i.test(propre)) {
        return [[reponses.charge || { cpu: 41.4, ram: 68.8, machines: 3 }]];
      }
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  delete require.cache[CHEMIN_SITES];
  return require(CHEMIN_SITES);
}

function appeler(routeur) {
  const couche = routeur.stack.find(
    (c) => c.route && c.route.path === "/sites/:id/vue" && c.route.methods.get
  );
  assert.ok(couche, "GET /sites/:id/vue doit exister");
  const gestionnaire = couche.route.stack[couche.route.stack.length - 1].handle;

  return new Promise((resolve, reject) => {
    const req = {
      params: { id: "3" },
      query: {},
      headers: {},
      user: { id: 1, role: "admin", id_site: null },
      baseUrl: "/api",
      path: "/sites/3/vue",
      originalUrl: "/api/sites/3/vue",
    };
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(corps) {
        resolve({ statut: this.statusCode, corps });
        return this;
      },
    };
    Promise.resolve(gestionnaire(req, res, reject)).catch(reject);
  });
}

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[CHEMIN_SITES];
});

/* ═══════════════════════════════════════════════════════════════════════
   LE PARC
   ═══════════════════════════════════════════════════════════════════════ */

test("« sans état connu » est compté à part, jamais avec les hors ligne", async () => {
  const r = await appeler(charger());

  assert.equal(r.statut, 200);
  assert.equal(r.corps.parc.hors_ligne, 1);
  assert.equal(r.corps.parc.inconnu, 3, "les trois muettes ne sont pas des pannes");
  assert.equal(r.corps.parc.total, 10);
});

test("tout est assemblé en UN seul appel", async () => {
  /* Sept allers-retours depuis l'écran auraient affiché un bloc à la
     fois, dans le désordre, chacun avec son propre moment d'erreur. */
  const r = await appeler(charger());

  for (const clef of [
    "site", "parc", "types", "alertes", "consommateurs", "plages",
    "historique", "charge", "problemes",
  ]) {
    assert.ok(clef in r.corps, `la réponse doit porter « ${clef} »`);
  }
});

test("le site est nommé, avec sa ville", async () => {
  const r = await appeler(charger());
  assert.equal(r.corps.site.nom, "Cabinet Ngando");
  assert.equal(r.corps.site.ville, "Douala");
});

/* ═══════════════════════════════════════════════════════════════════════
   CE QUI A ÉTÉ TROUVÉ, ET NON DÉCLARÉ
   ═══════════════════════════════════════════════════════════════════════ */

test("les types viennent du scan, triés par nombre", async () => {
  const routeur = charger({
    reponses: {
      types: [
        { libelle: "poste", nombre: 12 },
        { libelle: "imprimante", nombre: 3 },
      ],
    },
  });
  const r = await appeler(routeur);

  assert.equal(r.corps.types.length, 2);
  assert.equal(r.corps.types[0].libelle, "poste");
  assert.equal(r.corps.types[0].nombre, 12);
});

test("un parc vide ne produit ni erreur ni chiffre inventé", async () => {
  const routeur = charger({
    reponses: {
      parc: { total: 0, en_ligne: 0, hors_ligne: 0, inconnu: 0 },
      types: [],
      consommateurs: [],
    },
  });
  const r = await appeler(routeur);

  assert.equal(r.statut, 200);
  assert.equal(r.corps.parc.total, 0);
  assert.deepEqual(r.corps.types, []);
  assert.deepEqual(r.corps.consommateurs, []);
});

/* ═══════════════════════════════════════════════════════════════════════
   UNE MIGRATION MANQUANTE N'EST PAS UN ZÉRO
   ═══════════════════════════════════════════════════════════════════════ */

test("sans la colonne des preuves, le bloc vaut null — pas zéro", async () => {
  /* `null` se lit « nous ne savons pas » ; 0 se lit « il n'y en a pas ».
     Sur un outil de supervision, confondre les deux coûte la confiance. */
  const routeur = charger({ absente: /preuve_existence/i });
  const r = await appeler(routeur);

  assert.equal(r.statut, 200, "le reste de la vue doit continuer");
  assert.equal(r.corps.preuves, null);
  assert.equal(r.corps.parc.total, 10, "les autres blocs sont intacts");
});

test("les plages déclarées accompagnent le compte des machines", async () => {
  const routeur = charger({
    reponses: { plages: [{ cidr: "10.0.0.0/24", actif: 1 }, { cidr: "10.0.1.0/24", actif: 0 }] },
  });
  const r = await appeler(routeur);

  assert.equal(r.corps.plages.length, 2);
  assert.equal(r.corps.plages[0].cidr, "10.0.0.0/24");
  assert.equal(r.corps.plages[1].actif, false);
});


/* ═══════════════════════════════════════════════════════════════════════
   LES COURBES ET LES JAUGES
   ═══════════════════════════════════════════════════════════════════════ */

test("une heure sans mesure rend null, jamais zéro", async () => {
  /* Une courbe qui retombe à zéro se lit comme une panne. L'absence de
     mesure n'en est pas une. */
  const routeur = charger({
    reponses: {
      historique: [
        { instant: "2026-10-01 09:00:00", repondants: 5, latence: 12.34, debit: 900 },
        { instant: "2026-10-01 10:00:00", repondants: 0, latence: null, debit: null },
      ],
    },
  });
  const r = await appeler(routeur);

  assert.equal(r.corps.historique.length, 2);
  assert.equal(r.corps.historique[0].latence, 12.3, "arrondi au dixième");
  assert.equal(r.corps.historique[1].latence, null);
  assert.equal(r.corps.historique[1].debit, null);
});

test("la charge est moyennée sur les machines qui ont RÉPONDU", async () => {
  /* Moyenner sur tout le parc ferait baisser le chiffre à proportion des
     machines muettes : un parc à 90 % de charge paraîtrait tranquille
     parce que neuf machines sur dix ne disent rien. */
  const routeur = charger({ reponses: { charge: { cpu: 41.4, ram: 68.8, machines: 3 } } });
  const r = await appeler(routeur);

  assert.equal(r.corps.charge.cpu, 41);
  assert.equal(r.corps.charge.ram, 69);
  assert.equal(r.corps.charge.machines, 3, "le nombre de machines mesurées est dit");
});

test("sans aucune machine mesurée, la charge vaut null et non zéro", async () => {
  const routeur = charger({ reponses: { charge: { cpu: null, ram: null, machines: 0 } } });
  const r = await appeler(routeur);

  assert.equal(r.corps.charge.cpu, null, "0 % se lirait « machines au repos »");
  assert.equal(r.corps.charge.ram, null);
});

test("les problèmes sont nommés, pas seulement comptés", async () => {
  /* Un compteur d'alertes ne dit pas quoi faire. La liste, si. */
  const routeur = charger({
    reponses: {
      problemes: [
        {
          id_alerte: 7, type_alerte: "equipement_down", niveau: "critical",
          message: "Ne répond plus", date_creation: "2026-10-01 08:00:00",
          occurrences: 4, machine: "SVR-SAP",
        },
      ],
    },
  });
  const r = await appeler(routeur);

  assert.equal(r.corps.problemes.length, 1);
  assert.equal(r.corps.problemes[0].machine, "SVR-SAP");
  assert.equal(r.corps.problemes[0].niveau, "critical");
  assert.equal(r.corps.problemes[0].occurrences, 4);
});


/* ═══════════════════════════════════════════════════════════════════════
   UNE PREUVE QU'ON PEUT OUVRIR
   ═══════════════════════════════════════════════════════════════════════ */

function appelerMachines(routeur, preuve) {
  const couche = routeur.stack.find(
    (c) => c.route && c.route.path === "/sites/:id/machines-par-preuve" && c.route.methods.get
  );
  assert.ok(couche, "la route doit exister");
  const gestionnaire = couche.route.stack[couche.route.stack.length - 1].handle;

  return new Promise((resolve, reject) => {
    const req = {
      params: { id: "3" },
      query: preuve === undefined ? {} : { preuve },
      headers: {},
      user: { id: 1, role: "admin", id_site: null },
      baseUrl: "/api",
      path: "/sites/3/machines-par-preuve",
      originalUrl: "/api/sites/3/machines-par-preuve",
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(corps) { resolve({ statut: this.statusCode, corps }); return this; },
    };
    Promise.resolve(gestionnaire(req, res, reject)).catch(reject);
  });
}

/** Fausse base qui enregistre la requête des machines. */
function chargerMachines(machines = []) {
  const vues = [];
  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      vues.push({ sql: propre, params });
      if (/SELECT id_site FROM SITE/i.test(propre)) return [[{ id_site: 3 }]];
      if (/preuve_detail/i.test(propre)) return [machines];
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;
  delete require.cache[CHEMIN_SITES];
  return { routeur: require(CHEMIN_SITES), vues };
}

test("une preuve rend les machines, avec ce qui a été constaté", async () => {
  /* « 47 machines vues par ping » est une affirmation. Tant qu'on ne peut
     pas l'ouvrir, c'est une affirmation qu'il faut croire sur parole. */
  const { routeur } = chargerMachines([
    {
      id_equipement: 5, adresse_ip: "192.168.1.10", statut: "up", nom: "PC-COMPTA",
      preuve_detail: "réponse au ping (3 ms)", date_preuve: "2026-10-01 09:00:00",
      type: "poste",
    },
  ]);

  const r = await appelerMachines(routeur, "ping");

  assert.equal(r.statut, 200);
  assert.equal(r.corps.preuve, "ping");
  assert.equal(r.corps.machines.length, 1);
  assert.equal(r.corps.machines[0].detail, "réponse au ping (3 ms)",
    "le détail est ce qui distingue une preuve d'une case cochée");
});

test("la preuve est passée en paramètre lié, jamais concaténée", async () => {
  const { routeur, vues } = chargerMachines([]);
  await appelerMachines(routeur, "voisinage_arp");

  const requete = vues.find((v) => /preuve_detail/i.test(v.sql));
  assert.ok(requete, "la requête doit avoir eu lieu");
  assert.ok(!requete.sql.includes("voisinage_arp"), "la valeur n'est pas dans le SQL");
  assert.ok(requete.params.includes("voisinage_arp"), "elle est dans les paramètres");
});

test("« inconnue » se traduit par une absence, pas par une valeur", async () => {
  const { routeur, vues } = chargerMachines([]);
  await appelerMachines(routeur, "inconnue");

  const requete = vues.find((v) => /preuve_detail/i.test(v.sql));
  assert.match(requete.sql, /preuve_existence IS NULL/i);
  assert.ok(!requete.params.includes("inconnue"), "rien n'est comparé à « inconnue »");
});

test("sans preuve demandée, la route refuse au lieu de tout rendre", async () => {
  const { routeur, vues } = chargerMachines([]);
  const r = await appelerMachines(routeur, undefined);

  assert.equal(r.statut, 400);
  assert.ok(!vues.some((v) => /preuve_detail/i.test(v.sql)), "aucune lecture");
});
