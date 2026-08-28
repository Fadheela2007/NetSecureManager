/**
 * tests/amorcage.test.js
 *
 * POST /api/auth/register était accessible SANS authentification et
 * créait un compte de rôle « admin » par défaut, le rôle étant en plus
 * lisible depuis le corps de la requête.
 *
 * N'importe qui pouvant joindre le serveur obtenait donc un accès
 * administrateur en une requête — sur une plateforme qui contient la
 * cartographie complète du réseau du client.
 *
 * Le défaut ne se voyait pas : l'interface ne propose nulle part de
 * « créer un compte », la route ne servait plus depuis l'arrivée de
 * l'écran Utilisateurs. Elle répondait pourtant toujours.
 *
 * Ces tests fixent le comportement corrigé pour qu'il ne se reperde pas
 * à la prochaine relecture de ce fichier.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// routes/auth.js refuse de se charger sans JWT_SECRET — un garde-fou
// légitime au démarrage du serveur. On le satisfait ici avec une valeur
// de test : ces tests portent sur la création de compte, pas sur la
// signature des jetons, et dépendre du .env de la machine rendrait leur
// résultat variable.
process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test-sans-valeur";

const CHEMIN_DB = require.resolve("../src/db");

/**
 * Charge routes/auth.js avec une fausse base, et renvoie de quoi appeler
 * la route sans démarrer de serveur HTTP.
 *
 * @param {number} nbComptes  ce que renvoie SELECT COUNT(*) FROM UTILISATEUR
 */
function chargerRoute(nbComptes) {
  const requetes = [];

  const faux = {
    query: async (sql, params) => {
      requetes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/COUNT\(\*\)/i.test(sql)) return [[{ n: nbComptes }]];
      if (/INSERT INTO UTILISATEUR/i.test(sql)) return [{ insertId: 1 }];
      return [[]];
    },
    getConnection: async () => ({ release() {} }),
  };

  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  const chemin = require.resolve("../src/routes/auth");
  delete require.cache[chemin];
  const routeur = require(chemin);

  /** Retrouve le gestionnaire de POST /register dans la pile du routeur. */
  const couche = routeur.stack.find(
    (c) => c.route && c.route.path === "/register" && c.route.methods.post
  );
  assert.ok(couche, "la route POST /register doit exister");

  const appeler = (corps) =>
    new Promise((resolve) => {
      const req = { body: corps, ip: "10.0.0.1", headers: {} };
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
      couche.route.stack[0].handle(req, res, () => {});
    });

  return { appeler, requetes };
}

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[require.resolve("../src/routes/auth")];
});

// ─────────────────────────────────────────────────────────────────────
test("base vide : le premier administrateur peut être créé", async () => {
  // Sans cette voie, une installation neuve serait inutilisable : aucun
  // compte n'existe, donc personne ne peut se connecter pour en créer.
  const { appeler, requetes } = chargerRoute(0);

  const r = await appeler({
    nom: "Aissatou",
    email: "a@exemple.com",
    mot_de_passe: "motdepasse-solide",
  });

  assert.strictEqual(r.statut, 201);

  const insertion = requetes.find((q) => q.sql.startsWith("INSERT INTO UTILISATEUR"));
  assert.ok(insertion, "le compte doit être inséré");
  assert.match(insertion.sql, /'admin'/, "le premier compte est administrateur par construction");
});

test("un compte existe déjà : la création est REFUSÉE", async () => {
  // Le cœur du correctif. Avant, cette requête réussissait et donnait un
  // accès administrateur complet à un inconnu.
  const { appeler, requetes } = chargerRoute(1);

  const r = await appeler({
    nom: "Intrus",
    email: "intrus@exemple.com",
    mot_de_passe: "motdepasse-solide",
  });

  assert.strictEqual(r.statut, 403);
  assert.ok(
    !requetes.some((q) => q.sql.startsWith("INSERT INTO UTILISATEUR")),
    "aucun compte ne doit être inséré"
  );
});

test("le rôle envoyé dans la requête est ignoré", async () => {
  // L'ancienne version lisait `role` depuis le corps : on pouvait donc
  // choisir son propre niveau de privilège. Même sur la base vide, le
  // premier compte doit être administrateur — et rien d'autre.
  const { appeler, requetes } = chargerRoute(0);

  await appeler({
    nom: "X",
    email: "x@exemple.com",
    mot_de_passe: "motdepasse-solide",
    role: "operateur",
  });

  const insertion = requetes.find((q) => q.sql.startsWith("INSERT INTO UTILISATEUR"));
  assert.match(insertion.sql, /'admin'/);
  assert.ok(
    !insertion.params.includes("operateur"),
    "le rôle du corps de la requête ne doit jamais atteindre la base"
  );
});

test("le refus ne révèle pas le nombre de comptes existants", async () => {
  // Renseigner un attaquant sur la taille de l'installation n'apporte
  // rien à l'utilisateur légitime.
  const { appeler } = chargerRoute(47);
  const r = await appeler({ nom: "X", email: "x@x.com", mot_de_passe: "motdepasse-solide" });

  assert.ok(!JSON.stringify(r.corps).includes("47"));
});

test("un mot de passe trop court est refusé pour le premier compte", async () => {
  // Ce compte est administrateur global et ne peut pas être supprimé
  // tant qu'il est le dernier : un mot de passe faible s'y installe pour
  // longtemps.
  const { appeler, requetes } = chargerRoute(0);
  const r = await appeler({ nom: "X", email: "x@x.com", mot_de_passe: "1234" });

  assert.strictEqual(r.statut, 400);
  assert.ok(!requetes.some((q) => q.sql.startsWith("INSERT INTO UTILISATEUR")));
});

test("les champs obligatoires sont vérifiés avant tout accès à la base", async () => {
  const { appeler, requetes } = chargerRoute(0);
  const r = await appeler({ email: "x@x.com" });

  assert.strictEqual(r.statut, 400);
  assert.strictEqual(requetes.length, 0, "aucune requête ne doit partir sur une saisie incomplète");
});
