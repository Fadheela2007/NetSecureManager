/**
 * tests/permissionsEcrans.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE CES TESTS PROTÈGENT
 *
 * Les droits viennent de sortir du code pour entrer dans une table. La
 * bascule ne vaut que si elle ne change RIEN le premier jour : sinon
 * personne ne saura dire, le lendemain, si un refus vient d'un réglage
 * ou d'une régression.
 *
 * Le test central est donc celui-ci : avec le remplissage de la
 * migration, chacun des trois rôles obtient EXACTEMENT les mêmes refus
 * et les mêmes autorisations qu'avec l'ancien code.
 *
 * Les autres vérifient les deux pièges d'un système de permissions :
 *   • s'enfermer dehors — table absente, plus personne n'entre ;
 *   • une permission que l'interface applique et pas le serveur.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SERVICE = require.resolve("../src/services/permissionsService");
const CHEMIN_MIDDLEWARE = require.resolve("../src/middleware/requireRole");

/** Le remplissage exact de la migration du 30/09. */
const ECRANS = [
  "equipements", "alertes", "incidents", "topologie", "plages",
  "bande_passante", "acces_web", "sites", "rapports", "scan",
  "journal", "configuration", "utilisateurs",
];
const SEMIS = { admin: "administrer", operateur: "modifier", lecteur: "voir" };

/**
 * @param {object|null} lignes  null simule la table absente.
 */
function charger(lignes) {
  const faux = {
    query: async (sql) => {
      if (/FROM PERMISSION/i.test(sql)) {
        if (lignes === null) {
          const err = new Error("Table 'netsecure.PERMISSION' doesn't exist");
          throw err;
        }
        return [lignes];
      }
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  delete require.cache[CHEMIN_SERVICE];
  delete require.cache[CHEMIN_MIDDLEWARE];
  return {
    service: require(CHEMIN_SERVICE),
    middleware: require(CHEMIN_MIDDLEWARE),
  };
}

/** Le semis de la migration, sous la forme que rend la base. */
function semis() {
  const lignes = [];
  for (const [role, niveau] of Object.entries(SEMIS)) {
    for (const ecran of ECRANS) lignes.push({ role, ecran, niveau });
  }
  return lignes;
}

/** Appelle un middleware et dit s'il a laissé passer. */
function appeler(middleware, { role, chemin }) {
  return new Promise((resolve) => {
    const req = {
      user: { id: 1, role },
      baseUrl: "/api",
      path: chemin,
      originalUrl: `/api${chemin}`,
    };
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(corps) {
        resolve({ passe: false, statut: this.statusCode, corps });
        return this;
      },
    };
    middleware(req, res, () => resolve({ passe: true }));
  });
}

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[CHEMIN_SERVICE];
  delete require.cache[CHEMIN_MIDDLEWARE];
});

/* ═══════════════════════════════════════════════════════════════════════
   LA CARTE DES ÉCRANS
   ═══════════════════════════════════════════════════════════════════════ */

test("chaque route de la plateforme tombe dans un écran", () => {
  const { service } = charger([]);

  const attendus = {
    "/equipements": "equipements",
    "/equipements/12/releves": "equipements",
    "/recherche": "equipements",
    "/supervision/historique": "equipements",
    "/alertes/resume": "alertes",
    "/regles-alerte/4": "alertes",
    "/incidents": "incidents",
    "/topologie": "topologie",
    "/plan-adressage": "plages",
    "/reservations": "plages",
    "/bande-passante/classement": "bande_passante",
    "/reseau/qualite": "bande_passante",
    "/acces-web/politique": "acces_web",
    "/sites/3/agent": "sites",
    "/rapport/pdf": "rapports",
    "/scan/site": "scan",
    "/reseaux-detectes": "scan",
    "/logs": "journal",
    "/configuration/intervalle_scan_minutes": "configuration",
    "/reinitialisation": "configuration",
    "/utilisateurs/demandes": "utilisateurs",
  };

  for (const [chemin, ecran] of Object.entries(attendus)) {
    assert.equal(service.ecranDuChemin(chemin), ecran, chemin);
  }

  // Avec ou sans le préfixe /api : la même réponse.
  assert.equal(service.ecranDuChemin("/api/equipements/12"), "equipements");
  // Un chemin inconnu ne doit pas être rattaché au hasard.
  assert.equal(service.ecranDuChemin("/quelque-chose"), null);
});

test("le niveau exigé se déduit des rôles déjà écrits dans les routes", () => {
  const { service } = charger([]);
  assert.equal(service.niveauRequis([]), "voir");
  assert.equal(service.niveauRequis(["admin", "operateur"]), "modifier");
  assert.equal(service.niveauRequis(["admin"]), "administrer");
});

test("les quatre niveaux sont ordonnés", () => {
  const { service } = charger([]);
  const r = service.rang;
  assert.ok(r("rien") < r("voir"));
  assert.ok(r("voir") < r("modifier"));
  assert.ok(r("modifier") < r("administrer"));
  // Une valeur inconnue vaut le niveau le plus bas, jamais le plus haut.
  assert.equal(r("n'importe quoi"), 0);
});

/* ═══════════════════════════════════════════════════════════════════════
   LE TEST CENTRAL : LA MIGRATION NE CHANGE RIEN
   ═══════════════════════════════════════════════════════════════════════ */

test("avec le semis de la migration, les droits sont ceux d'avant", async () => {
  const { middleware } = charger(semis());

  /* Les trois barrières de l'ancien code, une route de chacune. */
  const cas = [
    // [chemin, rôles de l'ancien requireRole, qui passait AVANT]
    ["/equipements", [], ["admin", "operateur", "lecteur"]],
    ["/alertes/resume", [], ["admin", "operateur", "lecteur"]],
    ["/equipements/1/nom", ["admin", "operateur"], ["admin", "operateur"]],
    ["/scan/site", ["admin", "operateur"], ["admin", "operateur"]],
    ["/utilisateurs/1", ["admin"], ["admin"]],
    ["/sites/3/regenerer-token", ["admin"], ["admin"]],
    ["/configuration/cle", ["admin"], ["admin"]],
    ["/logs", ["admin"], ["admin"]],
  ];

  for (const [chemin, roles, attendus] of cas) {
    const garde = middleware.requireRole(...roles);
    for (const role of ["admin", "operateur", "lecteur"]) {
      const r = await appeler(garde, { role, chemin });
      assert.equal(
        r.passe,
        attendus.includes(role),
        `${role} sur ${chemin} : ${r.passe ? "passe" : "refusé"}, attendu l'inverse`
      );
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   NE PAS S'ENFERMER DEHORS
   ═══════════════════════════════════════════════════════════════════════ */

test("table absente : on retombe exactement sur l'ancien comportement", async () => {
  const { middleware } = charger(null);

  const garde = middleware.requireRole("admin", "operateur");

  const admin = await appeler(garde, { role: "admin", chemin: "/scan/site" });
  assert.equal(admin.passe, true);

  const operateur = await appeler(garde, { role: "operateur", chemin: "/scan/site" });
  assert.equal(operateur.passe, true);

  const lecteur = await appeler(garde, { role: "lecteur", chemin: "/scan/site" });
  assert.equal(lecteur.passe, false);
  assert.equal(lecteur.statut, 403);
});

test("table absente : le plancher laisse tout passer", async () => {
  /* Une migration oubliée ne doit pas fermer la plateforme à tout le
     monde, administrateur compris — il n'aurait plus aucun moyen de la
     rouvrir depuis l'interface. */
  const { middleware } = charger(null);

  for (const role of ["admin", "operateur", "lecteur"]) {
    const r = await appeler(middleware.plancherEcran, { role, chemin: "/equipements" });
    assert.equal(r.passe, true, `${role} doit passer quand la table manque`);
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   LE SERVEUR APPLIQUE, PAS SEULEMENT L'INTERFACE
   ═══════════════════════════════════════════════════════════════════════ */

test("un écran retiré est refusé même en appelant la route à la main", async () => {
  const lignes = semis().map((l) =>
    l.role === "lecteur" && l.ecran === "equipements" ? { ...l, niveau: "rien" } : l
  );
  const { middleware } = charger(lignes);

  const r = await appeler(middleware.plancherEcran, {
    role: "lecteur",
    chemin: "/equipements",
  });
  assert.equal(r.passe, false);
  assert.equal(r.statut, 403);

  // Les autres écrans du même rôle ne sont pas touchés.
  const autre = await appeler(middleware.plancherEcran, {
    role: "lecteur",
    chemin: "/alertes",
  });
  assert.equal(autre.passe, true);
});

test("le refus nomme l'écran, le niveau manquant, et où l'obtenir", async () => {
  const { middleware } = charger(semis());

  const r = await appeler(middleware.requireRole("admin"), {
    role: "operateur",
    chemin: "/utilisateurs/1",
  });

  assert.equal(r.passe, false);
  assert.equal(r.statut, 403);
  assert.equal(r.corps.ecran, "utilisateurs");
  assert.equal(r.corps.niveau_requis, "administrer");
  /* Un refus qu'on comprend se résout tout seul ; un refus opaque finit
     en message à l'équipe. */
  assert.match(r.corps.aide, /Utilisateurs/);
  assert.match(r.corps.aide, /administrateur/i);
});

/* ═══════════════════════════════════════════════════════════════════════
   UN DROIT DONNÉ PREND EFFET
   ═══════════════════════════════════════════════════════════════════════ */

test("monter un rôle lui ouvre ce qui lui était refusé", async () => {
  const lignes = semis().map((l) =>
    l.role === "operateur" && l.ecran === "sites" ? { ...l, niveau: "administrer" } : l
  );
  const { middleware } = charger(lignes);

  const garde = middleware.requireRole("admin");

  const r = await appeler(garde, { role: "operateur", chemin: "/sites/3/regenerer-token" });
  assert.equal(r.passe, true, "l'opérateur promu doit passer");

  /* Et seulement là : le droit porte sur un écran, pas sur la personne
     en général. */
  const ailleurs = await appeler(garde, { role: "operateur", chemin: "/utilisateurs/1" });
  assert.equal(ailleurs.passe, false);
});

test("descendre un rôle lui ferme ce qu'il pouvait faire", async () => {
  const lignes = semis().map((l) =>
    l.role === "operateur" && l.ecran === "scan" ? { ...l, niveau: "voir" } : l
  );
  const { middleware } = charger(lignes);

  const r = await appeler(middleware.requireRole("admin", "operateur"), {
    role: "operateur",
    chemin: "/scan/site",
  });
  assert.equal(r.passe, false);
  assert.equal(r.statut, 403);
});

test("la matrice rend les treize écrans et les trois rôles", async () => {
  const { service } = charger(semis());
  const m = await service.matrice();

  assert.equal(m.ecrans.length, 13);
  assert.deepEqual(m.niveaux, ["rien", "voir", "modifier", "administrer"]);
  assert.equal(m.permissions.admin.utilisateurs, "administrer");
  assert.equal(m.permissions.operateur.utilisateurs, "modifier");
  assert.equal(m.permissions.lecteur.utilisateurs, "voir");

  /* Chaque écran porte un libellé lisible : la matrice est faite pour
     être lue par quelqu'un, pas pour afficher des codes. */
  assert.ok(m.ecrans.every((e) => e.libelle && e.libelle !== e.code));
});
