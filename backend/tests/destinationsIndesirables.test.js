/**
 * tests/destinationsIndesirables.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * « INDÉSIRABLE » N'EST PAS « BLOQUÉ »
 *
 * Ces flux ont été OBSERVÉS : ils ont eu lieu. L'étiquette dit une seule
 * chose — ce correspondant figure dans une liste que la politique d'accès
 * web désigne comme indésirable. Elle ne dit jamais qu'il a été bloqué.
 *
 * ── CE QUE CES TESTS SURVEILLENT ──
 *
 *   1. La précédence. Une règle « autoriser boutique.exemple.com » doit
 *      l'emporter sur « catégorie Achats bloquée », sinon l'écran dira le
 *      contraire du pare-feu — et on ne saura plus lequel croire.
 *
 *   2. La catégorie NOMMÉE est celle du suffixe le plus spécifique. Sans
 *      ça, un domaine hérite de « .com » dès qu'il y figure.
 *
 *   3. Une IP n'est jamais cherchée dans une liste de domaines.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_SERVICE = require.resolve("../src/services/destinationService");

/**
 * @param {object} politique   la ligne POLITIQUE_WEB, ou null.
 * @param {Array} manuelles    [{domaine, action}]
 * @param {Array} categories   [{domaine, libelle}]
 */
function charger({ politique, manuelles = [], categories = [] }) {
  const demandes = [];
  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      demandes.push({ sql: propre, params });
      if (/FROM POLITIQUE_WEB/i.test(propre)) return [politique ? [politique] : []];
      if (/FROM POLITIQUE_DOMAINE/i.test(propre)) return [manuelles];
      if (/FROM DOMAINE_CATEGORIE/i.test(propre)) {
        const voulus = new Set(params[1] || []);
        return [categories.filter((c) => voulus.has(c.domaine))];
      }
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  delete require.cache[CHEMIN_SERVICE];
  return { service: require(CHEMIN_SERVICE), demandes };
}

const dest = (nom) => ({ destination: nom, service: "HTTPS", octets_total: 100 });

const POLITIQUE = { id_politique: 1, nom: "Politique du siège", active: 1 };

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[CHEMIN_SERVICE];
});

/* ═══════════════════════════════════════════════════════════════════════
   LES SUFFIXES
   ═══════════════════════════════════════════════════════════════════════ */

test("un nom rend ses suffixes du plus précis au plus large", () => {
  const { service } = charger({ politique: null });
  assert.deepEqual(service.suffixes("a.b.exemple.com"), [
    "a.b.exemple.com",
    "b.exemple.com",
    "exemple.com",
    "com",
  ]);
});

test("une adresse IP n'est pas un nom à chercher dans une liste de domaines", () => {
  const { service } = charger({ politique: null });
  assert.equal(service.nomExploitable("192.168.1.10"), null);
  assert.equal(service.nomExploitable("10.0.0.1 (réseau interne)"), null);
  assert.equal(service.nomExploitable(""), null);
  assert.equal(service.nomExploitable("youtube.com"), "youtube.com");
});

/* ═══════════════════════════════════════════════════════════════════════
   LE MARQUAGE
   ═══════════════════════════════════════════════════════════════════════ */

test("un domaine d'une catégorie de la politique est marqué, avec sa catégorie", async () => {
  const { service } = charger({
    politique: POLITIQUE,
    categories: [{ domaine: "youtube.com", libelle: "Vidéo" }],
  });

  const r = await service.marquerIndesirables([dest("r1.youtube.com")], 2);

  assert.equal(r.destinations[0].indesirable.raison, "categorie");
  assert.equal(r.destinations[0].indesirable.categorie, "Vidéo");
  assert.equal(r.politique.active, true);
  assert.equal(r.politique.nom, "Politique du siège");
});

test("la catégorie nommée est celle du suffixe le plus spécifique", async () => {
  /* Sans ce tri, un domaine hériterait de « .com » dès que « .com »
     figure dans une catégorie — et l'écran nommerait n'importe quoi. */
  const { service } = charger({
    politique: POLITIQUE,
    categories: [
      { domaine: "com", libelle: "Tout le .com" },
      { domaine: "youtube.com", libelle: "Vidéo" },
    ],
  });

  const r = await service.marquerIndesirables([dest("r1.youtube.com")], 2);
  assert.equal(r.destinations[0].indesirable.categorie, "Vidéo");
});

test("une règle manuelle « autoriser » l'emporte sur la catégorie", async () => {
  /* C'est le cas courant : on bloque une catégorie entière, puis on
     rouvre un site précis. Si l'écran disait l'inverse du pare-feu,
     personne ne saurait plus lequel croire. */
  const { service } = charger({
    politique: POLITIQUE,
    manuelles: [{ domaine: "boutique.exemple.com", action: "autoriser" }],
    categories: [{ domaine: "exemple.com", libelle: "Achats" }],
  });

  const r = await service.marquerIndesirables(
    [dest("boutique.exemple.com"), dest("pub.exemple.com")],
    2
  );

  assert.equal(r.destinations[0].indesirable, null, "explicitement autorisé");
  assert.equal(r.destinations[1].indesirable.categorie, "Achats");
});

test("une règle manuelle « bloquer » marque sans nommer de catégorie", async () => {
  const { service } = charger({
    politique: POLITIQUE,
    manuelles: [{ domaine: "paris-sportifs.example", action: "bloquer" }],
  });

  const r = await service.marquerIndesirables([dest("www.paris-sportifs.example")], 2);
  assert.equal(r.destinations[0].indesirable.raison, "regle_manuelle");
  assert.equal(r.destinations[0].indesirable.categorie, null);
});

test("un correspondant hors de toute liste n'est pas marqué", async () => {
  const { service } = charger({
    politique: POLITIQUE,
    categories: [{ domaine: "youtube.com", libelle: "Vidéo" }],
  });

  const r = await service.marquerIndesirables([dest("mise-a-jour.microsoft.com")], 2);
  assert.equal(r.destinations[0].indesirable, null);
});

/* ═══════════════════════════════════════════════════════════════════════
   L'ABSENCE DE POLITIQUE N'EST PAS UNE PANNE
   ═══════════════════════════════════════════════════════════════════════ */

test("sans politique, les destinations passent telles quelles", async () => {
  const { service } = charger({ politique: null });

  const r = await service.marquerIndesirables([dest("youtube.com")], 2);
  assert.equal(r.politique, null);
  assert.equal(r.destinations.length, 1);
});

test("une base sans le contrôle d'accès web ne fait pas échouer la lecture", async () => {
  /* Migration non passée : il n'y a pas de politique, donc rien n'est
     indésirable. Faire échouer toute la lecture des destinations pour
     autant serait perdre l'information principale à cause d'une
     information secondaire. */
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = {
    query: async () => {
      throw new Error("Table 'netsecure.POLITIQUE_WEB' doesn't exist");
    },
  };
  delete require.cache[CHEMIN_SERVICE];
  const service = require(CHEMIN_SERVICE);

  const entree = [dest("youtube.com")];
  const r = await service.marquerIndesirables(entree, 2);

  assert.equal(r.politique, null);
  assert.deepEqual(r.destinations, entree);
});

test("une liste vide ne déclenche aucune requête", async () => {
  const { service, demandes } = charger({ politique: POLITIQUE });

  const r = await service.marquerIndesirables([], 2);
  assert.deepEqual(r.destinations, []);
  assert.equal(demandes.length, 0, "rien à marquer, rien à demander");
});

/* ═══════════════════════════════════════════════════════════════════════
   LA REQUÊTE DES CATÉGORIES RESTE INDEXABLE
   ═══════════════════════════════════════════════════════════════════════ */

test("les catégories sont cherchées par égalité, jamais par LIKE", async () => {
  /* DOMAINE_CATEGORIE compte des centaines de milliers de lignes. Un
     `LIKE '%...'` n'utilise aucun index et parcourrait la table entière
     à chaque ouverture du panneau. */
  const { service, demandes } = charger({
    politique: POLITIQUE,
    categories: [{ domaine: "youtube.com", libelle: "Vidéo" }],
  });

  await service.marquerIndesirables([dest("r1.youtube.com")], 2);

  const requete = demandes.find((d) => /FROM DOMAINE_CATEGORIE/i.test(d.sql));
  assert.ok(requete, "la requête doit avoir eu lieu");
  assert.ok(!/LIKE/i.test(requete.sql), "aucun LIKE");
  assert.ok(/domaine IN \(\?\)/i.test(requete.sql), "une liste exacte de suffixes");
});
