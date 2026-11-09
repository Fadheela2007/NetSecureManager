/**
 * services/permissionsService.js
 * Qui a le droit de quoi, écran par écran.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE SEUL ENDROIT QUI SAIT QUELLE ROUTE APPARTIENT À QUEL ÉCRAN
 *
 * Et c'est délibérément UN seul endroit. Disséminer cette information
 * dans les cinquante-trois routes reviendrait à ce qu'on avait déjà :
 * un droit qu'on ne peut pas relire d'un coup d'œil, donc qu'on n'ose
 * plus changer.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUATRE NIVEAUX ORDONNÉS
 *
 *   rien < voir < modifier < administrer
 *
 * Ils décalquent les trois barrières qui existaient déjà dans le code —
 * pas de requireRole, requireRole("admin","operateur"), requireRole("admin").
 * C'est ce qui permet à la bascule de ne rien changer le premier jour.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EN CAS DE DOUTE, LE COMPORTEMENT D'AVANT
 *
 * Table absente (migration non passée), base injoignable, écran inconnu :
 * on rend `null`, et l'appelant retombe sur les rôles écrits dans le
 * code. La plateforme continue de fonctionner exactement comme avant.
 *
 * L'inverse — refuser par défaut — aurait l'air plus prudent et serait
 * pire : une migration oubliée fermerait TOUTE la plateforme à TOUT le
 * monde, y compris à l'administrateur qui doit la rouvrir. On ne
 * s'enferme pas dehors.
 */

const db = require("../db");

/* ═══════════════════════════════════════════════════════════════════════
   LES ÉCRANS, ET LES ROUTES QUI LEUR APPARTIENNENT

   La clé est le premier segment du chemin, après /api. Un tableau plutôt
   qu'un test par écran : ajouter une route, c'est ajouter un mot ici.
   ═══════════════════════════════════════════════════════════════════════ */
const ECRANS = {
  equipements: {
    libelle: "Équipements",
    prefixes: ["equipements", "recherche", "oui", "supervision"],
  },
  alertes: { libelle: "Alertes", prefixes: ["alertes", "regles-alerte"] },
  incidents: { libelle: "Incidents", prefixes: ["incidents"] },
  topologie: { libelle: "Topologie", prefixes: ["topologie"] },
  plages: {
    libelle: "Plan d'adressage",
    prefixes: ["plages", "plan-adressage", "reservations"],
  },
  bande_passante: {
    libelle: "Bande passante",
    prefixes: ["bande-passante", "reseau"],
  },
  acces_web: { libelle: "Accès web", prefixes: ["acces-web"] },
  sites: { libelle: "Sites", prefixes: ["sites"] },
  rapports: { libelle: "Rapports", prefixes: ["rapport"] },
  scan: { libelle: "Scan", prefixes: ["scan", "reseaux-detectes"] },
  journal: { libelle: "Journal", prefixes: ["logs"] },
  configuration: {
    libelle: "Configuration",
    prefixes: ["configuration", "reinitialisation"],
  },
  /* « permissions » vit avec « Utilisateurs », et c'est voulu : la
     matrice s'affiche sur cet écran, et le droit de la modifier est le
     même que celui de créer un compte. Deux réglages séparés pour la
     même page auraient produit l'état absurde où l'on voit la matrice
     sans pouvoir la toucher, sans que rien ne le dise. */
  utilisateurs: {
    libelle: "Utilisateurs",
    prefixes: ["utilisateurs", "permissions"],
  },
};

/** Index inverse, construit une fois : préfixe -> écran. */
const PAR_PREFIXE = new Map();
for (const [code, ecran] of Object.entries(ECRANS)) {
  for (const prefixe of ecran.prefixes) PAR_PREFIXE.set(prefixe, code);
}

const NIVEAUX = ["rien", "voir", "modifier", "administrer"];

/** Rang d'un niveau, pour les comparer. `rien` = 0. */
function rang(niveau) {
  const i = NIVEAUX.indexOf(String(niveau));
  return i === -1 ? 0 : i;
}

/**
 * À quel écran appartient ce chemin ?
 *
 * @param {string} chemin  ex. "/api/equipements/12/releves" ou "/equipements"
 * @returns {string|null}  le code de l'écran, ou null si on ne sait pas.
 */
function ecranDuChemin(chemin) {
  const segments = String(chemin || "")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  // "api" est présent quand on lit originalUrl, absent quand on lit le
  // chemin relatif au routeur : on l'enlève dans les deux cas.
  if (segments[0] === "api") segments.shift();
  return PAR_PREFIXE.get(segments[0]) || null;
}

/**
 * Le niveau qu'une route exige, déduit des rôles qu'elle déclare.
 *
 * On ne réécrit donc AUCUNE route : leur `requireRole` existant porte
 * déjà l'information, il suffisait de la lire.
 */
function niveauRequis(rolesAutorises) {
  if (!rolesAutorises || rolesAutorises.length === 0) return "voir";
  return rolesAutorises.includes("operateur") ? "modifier" : "administrer";
}

/* ═══════════════════════════════════════════════════════════════════════
   LA LECTURE EN BASE

   Mise en cache : cette table est lue à CHAQUE requête de la plateforme.
   Une lecture SQL par appel d'API serait une requête de plus sur tout ce
   qui existe, pour une table de trente-neuf lignes qui ne bouge presque
   jamais.

   Le cache est vidé dès qu'une permission change (`oublier()`), donc un
   droit retiré prend effet tout de suite. Le délai ci-dessous ne sert
   qu'au cas où la table serait modifiée en base, à la main.
   ═══════════════════════════════════════════════════════════════════════ */
const DUREE_CACHE_MS = 60000;

let cache = null;
let cacheExpire = 0;
let tableAbsenteSignalee = false;

function oublier() {
  cache = null;
  cacheExpire = 0;
}

async function charger() {
  if (cache && Date.now() < cacheExpire) return cache;

  try {
    const [lignes] = await db.query("SELECT role, ecran, niveau FROM PERMISSION");
    const table = new Map();
    for (const l of lignes) table.set(`${l.role}:${l.ecran}`, l.niveau);
    cache = table;
    cacheExpire = Date.now() + DUREE_CACHE_MS;
    return cache;
  } catch (err) {
    if (!/doesn't exist|Unknown column/i.test(err.message)) throw err;

    if (!tableAbsenteSignalee) {
      tableAbsenteSignalee = true;
      console.warn(
        "\n⚠  La table PERMISSION est absente de la base.\n" +
          "   Les droits restent ceux écrits dans le code — la plateforme\n" +
          "   fonctionne normalement, mais la page Utilisateurs ne pourra\n" +
          "   pas les modifier. Pour l'activer :\n" +
          "   backend/migrations/2026-09-30-permissions-ecrans.sql\n"
      );
    }
    // Cache vide mais VALIDE : sans ça, chaque requête réessaierait la
    // table absente et rejouerait l'échec des milliers de fois par heure.
    cache = new Map();
    cacheExpire = Date.now() + DUREE_CACHE_MS;
    return cache;
  }
}

/**
 * Le niveau d'un rôle sur un écran, ou `null` si la table ne le dit pas.
 *
 * `null` n'est PAS un refus : c'est « je ne sais pas ». L'appelant
 * retombe alors sur les rôles écrits dans le code.
 */
async function niveauDe(role, ecran) {
  if (!role || !ecran) return null;
  const table = await charger();
  return table.get(`${role}:${ecran}`) || null;
}

/**
 * Ce rôle a-t-il au moins ce niveau sur cet écran ?
 *
 * @returns {boolean|null}  null = la table ne dit rien, décidez sans elle.
 */
async function autorise(role, ecran, niveauAttendu) {
  const niveau = await niveauDe(role, ecran);
  if (niveau === null) return null;
  return rang(niveau) >= rang(niveauAttendu);
}

/** La matrice complète, pour l'écran de réglage. */
async function matrice() {
  const table = await charger();
  return {
    ecrans: Object.entries(ECRANS).map(([code, e]) => ({
      code,
      libelle: e.libelle,
    })),
    niveaux: NIVEAUX,
    permissions: Object.fromEntries(
      ["admin", "operateur", "lecteur"].map((role) => [
        role,
        Object.fromEntries(
          Object.keys(ECRANS).map((code) => [
            code,
            table.get(`${role}:${code}`) || null,
          ])
        ),
      ])
    ),
  };
}

module.exports = {
  ECRANS,
  NIVEAUX,
  rang,
  ecranDuChemin,
  niveauRequis,
  niveauDe,
  autorise,
  matrice,
  oublier,
};
