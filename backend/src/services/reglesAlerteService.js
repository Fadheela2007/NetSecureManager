/**
 * services/reglesAlerteService.js
 *
 * CE QUI DÉCLENCHE UNE ALERTE, ET AVEC QUELLE GRAVITÉ.
 *
 * Ces décisions vivaient dans le code : la liste des types qui doivent
 * rester allumés, le niveau « critical » écrit en dur, les seuils de
 * charge dans la table de configuration. Elles vivent désormais dans
 * REGLE_ALERTE, modifiable depuis l'écran Alertes.
 *
 * DEUX PRINCIPES, ET ILS NE SONT PAS NÉGOCIABLES.
 *
 *   1. UNE RÈGLE MANQUANTE NE DOIT JAMAIS ÉTEINDRE LA SUPERVISION. Table
 *      absente, ligne absente, base en retard : on retombe sur le
 *      comportement d'avant, décrit par DEFAUTS ci-dessous. Une
 *      plateforme qui cesse de surveiller parce qu'un réglage manque est
 *      pire qu'une plateforme sans réglages.
 *
 *   2. CE QUI EST AFFICHÉ EST CE QUI EST APPLIQUÉ. Le moteur lit cette
 *      table, et l'écran affiche cette même table. Il ne peut donc pas y
 *      avoir de règle montrée à l'exploitant que le cycle ignore.
 *
 * LE CACHE EST COURT — 60 secondes. Le cycle de supervision passe chaque
 * minute : lire la table à chaque équipement ferait des centaines de
 * requêtes pour des valeurs qui changent trois fois par an. Une minute
 * d'attente après un changement de réglage est imperceptible à l'usage,
 * et se force par un redémarrage.
 */

const db = require("../db");

const DUREE_CACHE_MS = 60 * 1000;

/* Le comportement d'avant cette table, mot pour mot. Sert de repli quand
   la base n'a pas encore la migration, et de valeur pour une ligne
   qu'aucune semence n'a créée. */
const TYPES_TOUJOURS_ALLUMES = new Set([
  "serveur",
  "imprimante",
  "routeur",
  "routeur/switch",
  "pare-feu",
  "camera",
  "telephonie",
]);

const DEFAUTS = {
  equipement_down: (cible) => ({
    active: TYPES_TOUJOURS_ALLUMES.has(String(cible || "inconnu").toLowerCase()),
    niveau: "critical",
    seuil: null,
    releves_requis: 3,
  }),
  cpu: () => ({ active: true, niveau: "warning", seuil: 90, releves_requis: 3 }),
  memoire: () => ({ active: true, niveau: "warning", seuil: 90, releves_requis: 3 }),
  agent_muet: () => ({ active: true, niveau: "critical", seuil: 30, releves_requis: null }),
};

let cache = null;
let cacheExpire = 0;
let absenceSignalee = false;

/** Toutes les règles, indexées par `code|cible`. Jamais d'exception. */
async function charger() {
  if (cache && Date.now() < cacheExpire) return cache;

  try {
    const [lignes] = await db.query(
      `SELECT id_regle, code, cible, active, niveau, seuil, releves_requis, libelle, aide
         FROM REGLE_ALERTE`
    );
    cache = new Map(
      lignes.map((l) => [
        `${l.code}|${l.cible}`,
        {
          id_regle: l.id_regle,
          code: l.code,
          cible: l.cible,
          active: Number(l.active) === 1,
          niveau: l.niveau,
          seuil: l.seuil === null ? null : Number(l.seuil),
          releves_requis: l.releves_requis === null ? null : Number(l.releves_requis),
          libelle: l.libelle,
          aide: l.aide,
        },
      ])
    );
    cacheExpire = Date.now() + DUREE_CACHE_MS;
    return cache;
  } catch (err) {
    if (!absenceSignalee) {
      absenceSignalee = true;
      console.warn(
        "\n⚠  REGLE_ALERTE est absente ou illisible : " +
          err.message +
          "\n   La supervision continue avec les règles d'origine.\n" +
          "   Pour rendre les conditions modifiables :\n" +
          "   backend/migrations/2026-09-25-regles-alerte.sql\n"
      );
    }
    // Un cache vide, valable une minute : on ne martèle pas la base avec
    // une requête qui vient d'échouer.
    cache = new Map();
    cacheExpire = Date.now() + DUREE_CACHE_MS;
    return cache;
  }
}

/** Oublie le cache — appelé après une modification depuis l'écran. */
function invalider() {
  cache = null;
  cacheExpire = 0;
}

/**
 * La règle qui s'applique, avec son repli.
 *
 * @param {string} code   condition : equipement_down, cpu, memoire, agent_muet
 * @param {string} cible  type d'équipement, ou "tous"
 */
async function regle(code, cible = "tous") {
  const regles = await charger();
  const trouvee = regles.get(`${code}|${cible}`);
  if (trouvee) return trouvee;

  const defaut = DEFAUTS[code];
  return defaut
    ? { code, cible, libelle: null, aide: null, ...defaut(cible) }
    : { code, cible, active: false, niveau: "warning", seuil: null, releves_requis: null };
}

/**
 * Faut-il alerter quand une machine de ce type ne répond plus ?
 *
 * Le choix porté par la machine elle-même (`surveillance_permanente`)
 * PRIME sur la règle de son type : une règle décrit le cas général, une
 * exception décrit une machine précise, et c'est l'exception qui gagne.
 */
async function alerteHorsLigne(typeLibelle, choixMachine) {
  if (choixMachine !== null && choixMachine !== undefined) {
    const r = await regle("equipement_down", String(typeLibelle || "inconnu").toLowerCase());
    return { active: Number(choixMachine) === 1, niveau: r.niveau };
  }
  const r = await regle("equipement_down", String(typeLibelle || "inconnu").toLowerCase());
  return { active: r.active, niveau: r.niveau };
}

module.exports = { charger, invalider, regle, alerteHorsLigne, DEFAUTS, TYPES_TOUJOURS_ALLUMES };
