const mysql = require("mysql2/promise");

// Aucun secret en dur : tout vient de .env.
const REQUIS = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"];

/** Variables absentes de l'environnement. */
function configurationManquante() {
  return REQUIS.filter((cle) => !process.env[cle]);
}

/**
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

      /* -----------------------------------------------------------------
         Les DECIMAL sont renvoyés comme NOMBRES, pas comme chaînes.

         CE QUI N'ALLAIT PAS. Par défaut, le pilote MySQL rend les colonnes
         DECIMAL sous forme de chaînes — délibérément, pour ne perdre
         aucune précision sur des valeurs monétaires très grandes.

         Toutes nos colonnes de mesure sont en DECIMAL : latence,
         processeur, mémoire, débits, taux de disponibilité. Le graphique
         de latence recevait donc « 3.00 » au lieu de 3. La bibliothèque
         de graphiques, qui ne convertit pas, ne savait pas placer cette
         valeur sur un axe et ne traçait RIEN.

         Le symptôme était trompeur : un graphique parfaitement vide alors
         que la base contenait 32 relevés tous valides. Rien à l'écran ne
         distinguait « aucune donnée » de « données du mauvais type ».

         Les autres écrans s'en sortaient par accident : JavaScript
         convertit implicitement les chaînes lors des soustractions et des
         comparaisons. « 10 » - « 5 » vaut bien 5. Ce n'est pas de la
         justesse, c'est de la chance — et elle finit toujours par tourner.

         POURQUOI ICI ET NON DANS CHAQUE ÉCRAN. Corriger à la source vaut
         pour tous les appelants, présents et futurs. Vingt conversions
         éparpillées, c'est vingt occasions d'en oublier une.

         LA LIMITE. Un DECIMAL dépassant la précision d'un nombre flottant
         perdrait des décimales. Nos valeurs — millisecondes, pourcentages,
         kilobits — en sont très loin. Le jour où la plateforme manipulera
         des montants, il faudra reconsidérer ce réglage colonne par
         colonne.
         ----------------------------------------------------------------- */
      decimalNumbers: true,
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