const mysql = require("mysql2/promise");

// Aucun secret en dur : tout vient de .env.
const REQUIS = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"];

/** Variables absentes de l'environnement. */
function configurationManquante() {
  return REQUIS.filter((cle) => !process.env[cle]);
}

/**
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE MODULE NE LÈVE PLUS À L'IMPORT.
 *
 * Il levait directement au chargement : `require("./db")` échouait si
 * .env était incomplet. Le principe — échouer tôt plutôt que se
 * connecter avec de mauvais identifiants — reste juste, mais la
 * réalisation faisait des dégâts collatéraux.
 *
 * Une chaîne d'imports aussi anodine que
 *   outil de mesure réseau -> discoveryService -> ouiService -> db
 * suffisait à tuer un programme qui n'ouvre jamais la moindre requête.
 * L'outil `mesurer-scan.js` mesure des durées de ping : il n'a aucun
 * besoin de la base, et il ne démarrait pas.
 *
 * Le contrôle a donc été déplacé à l'endroit où il a un sens :
 *   • à la PREMIÈRE REQUÊTE (message clair, plutôt qu'un plantage
 *     mysql2 illisible) ;
 *   • au DÉMARRAGE DU SERVEUR, via verifierConfiguration(), qui
 *     conserve le comportement « échouer tôt » là où il est utile.
 * ─────────────────────────────────────────────────────────────────────
 */
function verifierConfiguration() {
  const manquantes = configurationManquante();
  if (manquantes.length > 0) {
    throw new Error(
      `Variables d'environnement manquantes dans backend/.env : ${manquantes.join(", ")}`
    );
  }
}

let pool = null;

function obtenirPool() {
  verifierConfiguration();
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

/**
 * Le module exporte la même interface qu'avant (`query`, `getConnection`,
 * `execute`…) : aucun appelant n'a besoin d'être modifié. La connexion
 * est simplement créée à la première utilisation réelle.
 */
/**
 * Enveloppe qui renvoie une PROMESSE REJETÉE plutôt que de lever
 * de façon synchrone.
 *
 * La distinction n'est pas cosmétique. Plusieurs appels du code
 * s'écrivent `db.query(...).catch(...)` — notamment les replis
 * volontaires quand une migration n'est pas passée. Une exception
 * synchrone les traverserait sans être rattrapée et ferait tomber la
 * requête HTTP, exactement là où l'on avait pris soin de dégrader
 * proprement.
 */
function asynchrone(methode) {
  return (...args) => {
    try {
      return obtenirPool()[methode](...args);
    } catch (err) {
      return Promise.reject(err);
    }
  };
}

module.exports = {
  query: asynchrone("query"),
  execute: asynchrone("execute"),
  getConnection: asynchrone("getConnection"),
  end: () => (pool ? pool.end() : Promise.resolve()),

  verifierConfiguration,
  configurationManquante,
  /** Accès au pool sous-jacent, pour les cas non couverts ci-dessus. */
  get pool() {
    return obtenirPool();
  },
};