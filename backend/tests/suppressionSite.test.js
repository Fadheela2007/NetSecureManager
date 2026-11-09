/**
 * tests/suppressionSite.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE GESTE LE PLUS DESTRUCTEUR DE LA PLATEFORME
 *
 * Les clés étrangères sont en CASCADE : effacer un site efface ses
 * équipements, et avec eux tout l'historique de relevés. Des mois de
 * mesures, en une requête, sans retour possible.
 *
 * La suppression est DIRECTE : un clic, rien à recopier. Les deux refus
 * qui subsistent ne protègent pas de l'étourderie — ils empêchent la
 * suppression de laisser la plateforme dans un état faux.
 *
 * ── LE PIÈGE QUE CES TESTS SURVEILLENT AVANT TOUT ──
 *
 * `UTILISATEUR.id_site` est en ON DELETE SET NULL, pas en CASCADE. Or
 * dans cette plateforme, `id_site = NULL` veut dire GLOBAL : supprimer
 * un site PROMEUT silencieusement ses utilisateurs, qui se mettent à
 * voir tous les autres sites.
 *
 * Une suppression ne doit jamais élargir les droits de quelqu'un. C'est
 * le test le plus important du fichier.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test-sans-valeur";

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SITES = require.resolve("../src/routes/sites");

const SITE = { id_site: 3, nom: "Agence Bonanjo", ville: "Douala" };

/**
 * @param {number} nbSites    combien de sites au total.
 * @param {Array}  comptes    les utilisateurs rattachés à ce site.
 */
function charger({ nbSites = 2, comptes = [], site = SITE } = {}) {
  const requetes = [];
  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      requetes.push({ sql: propre, params });

      if (/FROM SITE WHERE id_site/i.test(propre)) return [site ? [site] : []];
      if (/COUNT\(\*\) AS total FROM SITE/i.test(propre)) return [[{ total: nbSites }]];
      if (/FROM UTILISATEUR WHERE id_site/i.test(propre)) return [comptes];
      if (/COUNT\(\*\) AS n/i.test(propre)) return [[{ n: 7 }]];
      if (/DELETE FROM SITE/i.test(propre)) return [{ affectedRows: 1 }];
      return [[]];
    },
    getConnection: async () => ({ release() {} }),
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  delete require.cache[CHEMIN_SITES];
  return { routeur: require(CHEMIN_SITES), requetes };
}

function appeler(routeur, methode, chemin, { corps, params = { id: "3" } } = {}) {
  const couche = routeur.stack.find(
    (c) => c.route && c.route.path === chemin && c.route.methods[methode]
  );
  assert.ok(couche, `${methode.toUpperCase()} ${chemin} doit exister`);
  const gestionnaire = couche.route.stack[couche.route.stack.length - 1].handle;

  return new Promise((resolve, reject) => {
    const req = {
      body: corps,
      params,
      query: {},
      headers: {},
      ip: "10.0.0.1",
      baseUrl: "/api",
      path: chemin,
      originalUrl: `/api${chemin}`,
      user: { id: 1, role: "admin", id_site: null },
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

const aEfface = (requetes) => requetes.some((r) => /DELETE FROM SITE/i.test(r.sql));

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[CHEMIN_SITES];
});

/* ═══════════════════════════════════════════════════════════════════════
   LA BARRIÈRE QUI COMPTE LE PLUS
   ═══════════════════════════════════════════════════════════════════════ */

test("un site avec des comptes rattachés n'est PAS supprimé", async () => {
  const { routeur, requetes } = charger({
    comptes: [{ id_utilisateur: 5, nom: "Awa", email: "awa@x.cm", role: "operateur" }],
  });

  const r = await appeler(routeur, "delete", "/sites/:id");

  assert.equal(r.statut, 409);
  assert.equal(aEfface(requetes), false, "rien ne doit être effacé");
  /* La clé étrangère est en SET NULL : ces comptes seraient devenus
     GLOBAUX, donc capables de voir tous les autres sites. */
  assert.match(r.corps.aide, /globaux/i);
});

test("les comptes qui bloquent sont nommés", async () => {
  /* « Rattachez-les ailleurs » sans dire lesquels oblige à les chercher
     un par un dans la page Utilisateurs. */
  const { routeur } = charger({
    comptes: [
      { id_utilisateur: 5, nom: "Awa", email: "awa@x.cm", role: "operateur" },
      { id_utilisateur: 6, nom: "Bilal", email: "bilal@x.cm", role: "lecteur" },
    ],
  });

  const r = await appeler(routeur, "delete", "/sites/:id");

  assert.equal(r.corps.comptes.length, 2);
  assert.equal(r.corps.comptes[0].email, "awa@x.cm");
});

/* ═══════════════════════════════════════════════════════════════════════
   LES DEUX AUTRES BARRIÈRES
   ═══════════════════════════════════════════════════════════════════════ */

test("le dernier site de la plateforme ne peut pas être supprimé", async () => {
  /* Sans aucun site, plus rien ne peut être supervisé ni scanné : ce
     n'est pas une suppression, c'est une mise hors service. */
  const { routeur, requetes } = charger({ nbSites: 1 });

  const r = await appeler(routeur, "delete", "/sites/:id");

  assert.equal(r.statut, 409);
  assert.match(r.corps.error, /dernier site/i);
  assert.equal(aEfface(requetes), false);
});

test("un clic suffit : aucune confirmation n'est demandée", async () => {
  /* La suppression est directe, c'est le choix de l'exploitante. Ce
     test fixe ce choix : si quelqu'un remettait un jour une étape de
     confirmation, l'appel sans corps échouerait ici. */
  const { routeur, requetes } = charger();

  const r = await appeler(routeur, "delete", "/sites/:id", { corps: undefined });

  assert.equal(r.statut, 200);
  assert.equal(r.corps.supprime, true);
  assert.equal(aEfface(requetes), true);
  /* L'inventaire est relevé AVANT : après, il n'y a plus rien à
     compter, et le journal doit pouvoir dire ce qui a disparu. */
  assert.equal(r.corps.perdu.equipements, 7);
});

test("un site introuvable répond 404 sans rien effacer", async () => {
  const { routeur, requetes } = charger({ site: null });

  const r = await appeler(routeur, "delete", "/sites/:id");

  assert.equal(r.statut, 404);
  assert.equal(aEfface(requetes), false);
});
