/**
 * tests/routesPermissions.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA PANNE DONT ON NE SE RELÈVE PAS PAR L'INTERFACE
 *
 * Un écran qui distribue les droits peut retirer le sien. Si « admin »
 * perd « administrer » sur l'écran Utilisateurs, plus personne ne peut
 * rendre ce droit à personne : il faut ouvrir la base à la main. Sur
 * l'installation d'un client, c'est un appel au support un dimanche.
 *
 * Le test central de ce fichier est donc celui du garde-fou, et il porte
 * sur le SERVEUR. L'écran grise aussi la case, mais une case grisée n'a
 * jamais empêché personne d'appeler la route.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test-sans-valeur";

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SERVICE = require.resolve("../src/services/permissionsService");
const CHEMIN_MIDDLEWARE = require.resolve("../src/middleware/requireRole");
const CHEMIN_ROUTES = require.resolve("../src/routes/permissions");

const ECRANS = [
  "equipements", "alertes", "incidents", "topologie", "plages",
  "bande_passante", "acces_web", "sites", "rapports", "scan",
  "journal", "configuration", "utilisateurs",
];
const SEMIS = { admin: "administrer", operateur: "modifier", lecteur: "voir" };

function charger() {
  const ecritures = [];
  const lignes = [];
  for (const [role, niveau] of Object.entries(SEMIS)) {
    for (const ecran of ECRANS) lignes.push({ role, ecran, niveau });
  }

  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      if (/FROM PERMISSION/i.test(propre)) return [lignes];
      if (/INSERT INTO PERMISSION/i.test(propre)) {
        ecritures.push(params);
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  for (const c of [CHEMIN_SERVICE, CHEMIN_MIDDLEWARE, CHEMIN_ROUTES]) {
    delete require.cache[c];
  }
  return { routeur: require(CHEMIN_ROUTES), ecritures };
}

/** Appelle une route en sautant sa garde : les droits sont testés ailleurs. */
function appeler(routeur, methode, chemin, corps) {
  const couche = routeur.stack.find(
    (c) => c.route && c.route.path === chemin && c.route.methods[methode]
  );
  assert.ok(couche, `${methode.toUpperCase()} ${chemin} doit exister`);
  const gestionnaire = couche.route.stack[couche.route.stack.length - 1].handle;

  return new Promise((resolve, reject) => {
    const req = {
      body: corps,
      user: { id: 1, role: "admin" },
      headers: {},
      query: {},
      params: {},
      ip: "10.0.0.1",
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
      json(charge) {
        resolve({ statut: this.statusCode, corps: charge });
        return this;
      },
    };
    Promise.resolve(gestionnaire(req, res, reject)).catch(reject);
  });
}

test.afterEach(() => {
  for (const c of [CHEMIN_DB, CHEMIN_SERVICE, CHEMIN_MIDDLEWARE, CHEMIN_ROUTES]) {
    delete require.cache[c];
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   LE GARDE-FOU
   ═══════════════════════════════════════════════════════════════════════ */

test("on ne peut pas retirer à l'admin le droit de modifier les permissions", async () => {
  const { routeur, ecritures } = charger();

  for (const niveau of ["rien", "voir", "modifier"]) {
    const r = await appeler(routeur, "put", "/permissions", {
      role: "admin",
      ecran: "utilisateurs",
      niveau,
    });
    assert.equal(r.statut, 409, `« ${niveau} » doit être refusé`);
    assert.match(r.corps.aide, /plus personne/i);
  }

  assert.equal(ecritures.length, 0, "aucune écriture ne doit avoir eu lieu");
});

test("le garde-fou ne bloque QUE cette case", async () => {
  const { routeur, ecritures } = charger();

  // Le même rôle, un autre écran.
  const autreEcran = await appeler(routeur, "put", "/permissions", {
    role: "admin",
    ecran: "scan",
    niveau: "voir",
  });
  assert.equal(autreEcran.statut, 200);

  // Le même écran, un autre rôle.
  const autreRole = await appeler(routeur, "put", "/permissions", {
    role: "operateur",
    ecran: "utilisateurs",
    niveau: "rien",
  });
  assert.equal(autreRole.statut, 200);

  assert.equal(ecritures.length, 2);
});

/* ═══════════════════════════════════════════════════════════════════════
   CE QUI EST ÉCRIT, ET CE QUI NE L'EST PAS
   ═══════════════════════════════════════════════════════════════════════ */

test("un rôle, un écran ou un niveau inconnu est refusé", async () => {
  const { routeur, ecritures } = charger();

  const cas = [
    { role: "patron", ecran: "scan", niveau: "voir" },
    { role: "admin", ecran: "comptabilite", niveau: "voir" },
    { role: "admin", ecran: "scan", niveau: "presque-tout" },
    {},
  ];

  for (const corps of cas) {
    const r = await appeler(routeur, "put", "/permissions", corps);
    assert.equal(r.statut, 400, JSON.stringify(corps));
  }
  assert.equal(ecritures.length, 0);
});

test("reposer le niveau déjà en place n'écrit rien", async () => {
  /* Un clic qui ne change rien n'est pas un événement : l'écrire
     remplirait le journal de lignes qui ne racontent aucun changement,
     et on finirait par ne plus le lire. */
  const { routeur, ecritures } = charger();

  const r = await appeler(routeur, "put", "/permissions", {
    role: "operateur",
    ecran: "scan",
    niveau: "modifier", // c'est déjà sa valeur
  });

  assert.equal(r.statut, 200);
  assert.equal(r.corps.modifie, false);
  assert.equal(ecritures.length, 0);
});

test("un changement réel est écrit, et dit ce qu'il remplace", async () => {
  const { routeur, ecritures } = charger();

  const r = await appeler(routeur, "put", "/permissions", {
    role: "lecteur",
    ecran: "journal",
    niveau: "rien",
  });

  assert.equal(r.statut, 200);
  assert.equal(r.corps.modifie, true);
  assert.equal(r.corps.avant, "voir");
  assert.deepEqual(ecritures[0], ["lecteur", "journal", "rien"]);
});

/* ═══════════════════════════════════════════════════════════════════════
   LA LECTURE
   ═══════════════════════════════════════════════════════════════════════ */

test("la matrice servie contient tout ce que l'écran doit afficher", async () => {
  const { routeur } = charger();

  const r = await appeler(routeur, "get", "/permissions", undefined);

  assert.equal(r.statut, 200);
  assert.equal(r.corps.ecrans.length, 13);
  assert.deepEqual(r.corps.niveaux, ["rien", "voir", "modifier", "administrer"]);
  assert.equal(r.corps.permissions.admin.utilisateurs, "administrer");
  assert.equal(r.corps.permissions.lecteur.scan, "voir");
});
