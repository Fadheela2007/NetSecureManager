/**
 * tests/creerAlerte-degrade.test.js
 *
 * Reproduit la panne observée en production :
 *
 *   Supervision de 192.168.0.160 échouée: Unknown column 'occurrences' in 'field list'
 *
 * La migration d'acquittement n'avait pas été exécutée. L'erreur remontait
 * jusqu'à checkEquipement et interrompait la supervision de CHAQUE
 * équipement en panne — c'est-à-dire précisément au moment où la
 * supervision sert à quelque chose.
 *
 * Le défaut n'était pas la migration manquante (c'est normal, une
 * migration s'exécute à la main) mais le fait qu'une amélioration du
 * confort d'affichage puisse arrêter la fonction principale du produit.
 *
 * Ces tests vérifient que le service dégrade au lieu de tomber.
 *
 * Banc d'essai : `src/db.js` est substitué dans require.cache avant le
 * chargement de monitoringService, aucune base réelle n'est nécessaire.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

const CHEMIN_DB = require.resolve("../src/db");

/** Erreur MySQL « colonne inconnue », telle que mysql2 la produit. */
function erreurColonne(nom) {
  const err = new Error(`Unknown column '${nom}' in 'field list'`);
  err.code = "ER_BAD_FIELD_ERROR";
  err.errno = 1054;
  err.sqlState = "42S22";
  return err;
}

/**
 * Charge monitoringService avec un faux db.query.
 *
 * @param {function} repondre  (sql, params) -> résultat, ou lève
 * @returns {{ service, requetes: Array }}
 */
function chargerAvecFausseBase(repondre) {
  const requetes = [];

  const faux = {
    query: async (sql, params) => {
      requetes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return repondre(sql, params);
    },
    getConnection: async () => ({ release() {} }),
  };

  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  const chemin = require.resolve("../src/services/monitoringService");
  delete require.cache[chemin];
  const service = require(chemin);

  return { service, requetes };
}

test.afterEach(() => {
  delete require.cache[CHEMIN_DB];
  delete require.cache[require.resolve("../src/services/monitoringService")];
});

/**
 * Exécute une fonction en retenant les appels à console.warn.
 *
 * Sans cela, l'avertissement « Dédoublonnage DÉSACTIVÉ » — que ces tests
 * provoquent VOLONTAIREMENT — s'affiche en tête de `npm test`. On lit
 * alors un bloc rouge alarmant au-dessus de 76 tests réussis, et on
 * croit que sa base de production est cassée.
 *
 * Une sortie de test doit être silencieuse quand tout va bien. Un
 * avertissement qui n'en est pas un apprend à ignorer les
 * avertissements — c'est le contraire du but.
 */
function sansAvertissement(fn) {
  const original = console.warn;
  console.warn = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.warn = original;
  });
}

// ─────────────────────────────────────────────────────────────────────
test("colonnes absentes : l'alerte est créée quand même, sans exception", async () => {
  const { service, requetes } = chargerAvecFausseBase((sql) => {
    // Toute requête mentionnant les colonnes de la migration échoue,
    // comme le ferait MySQL sur une base non migrée.
    if (/occurrences|derniere_occurrence|premiere_detection/.test(sql)) {
      throw erreurColonne("occurrences");
    }
    if (/^\s*INSERT INTO ALERTE/.test(sql)) return [{ insertId: 42 }];
    return [[]];
  });

  const id = await sansAvertissement(() =>
    service._creerAlerte(
      { id_equipement: 7, nom: "SRV-01", adresse_ip: "192.168.0.160" },
      "equipement_down",
      "critical",
      "Ne répond plus"
    )
  );

  assert.strictEqual(id, 42, "l'alerte doit être créée malgré la migration manquante");

  const insertions = requetes.filter((r) => r.sql.startsWith("INSERT INTO ALERTE"));
  const retenue = insertions[insertions.length - 1];
  assert.ok(
    !/occurrences/.test(retenue.sql),
    "l'insertion de repli ne doit mentionner aucune colonne de la migration"
  );
});

test("colonnes absentes : le diagnostic n'est journalisé qu'une seule fois", async () => {
  // Répété à chaque alerte de chaque équipement, l'avertissement noierait
  // la console — le problème même que le dédoublonnage doit résoudre.
  const { service } = chargerAvecFausseBase((sql) => {
    if (/occurrences|derniere_occurrence|premiere_detection/.test(sql)) {
      throw erreurColonne("occurrences");
    }
    if (/^\s*INSERT INTO ALERTE/.test(sql)) return [{ insertId: 1 }];
    return [[]];
  });

  const original = console.warn;
  let appels = 0;
  console.warn = () => { appels++; };

  try {
    for (let i = 0; i < 5; i++) {
      await service._creerAlerte({ id_equipement: i, nom: `EQ${i}` }, "equipement_down", "critical", "msg");
    }
  } finally {
    console.warn = original;
  }

  assert.strictEqual(appels, 1, `attendu 1 avertissement, obtenu ${appels}`);
});

test("colonnes absentes : une seule tentative, pas un essai par alerte", async () => {
  // Sans mémorisation, chaque alerte relancerait un SELECT voué à échouer :
  // un aller-retour MySQL gaspillé par équipement et par cycle.
  const { service, requetes } = chargerAvecFausseBase((sql) => {
    if (/occurrences|derniere_occurrence|premiere_detection/.test(sql)) {
      throw erreurColonne("occurrences");
    }
    if (/^\s*INSERT INTO ALERTE/.test(sql)) return [{ insertId: 1 }];
    return [[]];
  });

  const original = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 5; i++) {
      await service._creerAlerte({ id_equipement: i }, "equipement_down", "critical", "msg");
    }
  } finally {
    console.warn = original;
  }

  const selects = requetes.filter((r) => r.sql.startsWith("SELECT id_alerte"));
  assert.strictEqual(selects.length, 1, `attendu 1 SELECT de sondage, obtenu ${selects.length}`);
});

// ─────────────────────────────────────────────────────────────────────
test("base migrée : le dédoublonnage fonctionne, aucune alerte en double", async () => {
  let existeDeja = false;

  const { service, requetes } = chargerAvecFausseBase((sql) => {
    if (sql.includes("SELECT id_alerte")) {
      return [existeDeja ? [{ id_alerte: 99, occurrences: 3 }] : []];
    }
    if (/^\s*INSERT INTO ALERTE/.test(sql)) {
      existeDeja = true;
      return [{ insertId: 99 }];
    }
    return [{ affectedRows: 1 }];
  });

  const eq = { id_equipement: 7, nom: "SRV-01" };

  const premier = await service._creerAlerte(eq, "equipement_down", "critical", "Ne répond plus");
  const second = await service._creerAlerte(eq, "equipement_down", "critical", "Toujours pas");

  assert.strictEqual(premier, 99);
  assert.strictEqual(second, 99, "la seconde détection réutilise l'alerte existante");

  const insertions = requetes.filter((r) => r.sql.startsWith("INSERT INTO ALERTE"));
  assert.strictEqual(insertions.length, 1, "une seule alerte créée pour deux détections");

  const maj = requetes.filter((r) => r.sql.startsWith("UPDATE ALERTE"));
  assert.strictEqual(maj.length, 1);
  assert.ok(maj[0].sql.includes("occurrences = occurrences + 1"));
});

// ─────────────────────────────────────────────────────────────────────
test("une VRAIE panne SQL remonte toujours, elle n'est pas avalée", async () => {
  // Le repli doit rester étroit. Une table absente, une connexion perdue
  // ou une contrainte violée sont de vraies pannes : les masquer
  // laisserait la plateforme tourner en silence sur une base cassée.
  const { service } = chargerAvecFausseBase(() => {
    const err = new Error("Table 'NetSecureManager.ALERTE' doesn't exist");
    err.code = "ER_NO_SUCH_TABLE";
    err.errno = 1146;
    throw err;
  });

  await assert.rejects(
    () => service._creerAlerte({ id_equipement: 1 }, "equipement_down", "critical", "msg"),
    /doesn't exist/
  );
});

test("une erreur de connexion remonte aussi", async () => {
  const { service } = chargerAvecFausseBase(() => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:3306");
    err.code = "ECONNREFUSED";
    throw err;
  });

  await assert.rejects(
    () => service._creerAlerte({ id_equipement: 1 }, "equipement_down", "critical", "msg"),
    /ECONNREFUSED/
  );
});
