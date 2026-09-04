/**
 * ouiService.js
 * Identification du fabricant à partir de l'adresse MAC.
 *
 * Les trois premiers octets d'une MAC forment l'OUI, attribué par l'IEEE
 * au fabricant de la carte réseau. Registre public, exploitable sans
 * SNMP, sans nmap et sans coopération de l'équipement : il suffit que la
 * MAC soit connue, ce qui est le cas dès qu'une communication a eu lieu
 * sur le réseau local.
 *
 * Le registre vit dans la table `OUI_FABRICANT`, et non dans une API en
 * ligne ni une bibliothèque npm : il doit fonctionner sans Internet et
 * pouvoir être mis à jour sans redéployer l'application. Un
 * administrateur peut même le corriger en SQL.
 *
 * Table vide ou absente : le service retombe sur la graine
 * `data/oui-ieee.json.gz` lue depuis le disque, si bien que la fonction
 * marche dès le premier démarrage.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const db = require("../db");

const CHEMIN_GRAINE = path.join(__dirname, "..", "..", "data", "oui-ieee.json.gz");

/** Durée de vie du cache mémoire. Le registre ne bouge qu'à l'import. */
const DUREE_CACHE_MS = 60 * 60 * 1000;

let cache = null;          // Map<oui, fabricant>
let cacheExpire = 0;
let origineCache = "aucune";

/**
 * Normalise une adresse MAC vers son OUI : 6 caractères hexadécimaux
 * majuscules, sans séparateur.
 *
 * Absorbe tous les formats rencontrés : `a4-34-d9-1f-22-03` (Windows /
 * table ARP), `a4:34:d9:1f:22:03` (Linux), `a434.d91f.2203` (Cisco),
 * `A434D91F2203`. Le registre IEEE, lui, utilise `A434D9`.
 *
 * @returns {string|null} l'OUI, ou null si l'entrée est inexploitable
 */
function normaliserOui(mac) {
  if (!mac || typeof mac !== "string") return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length < 6) return null;
  return hex.slice(0, 6);
}

/**
 * Une adresse MAC est-elle « localement administrée » ?
 *
 * Le deuxième bit de poids faible du premier octet (masque 0x02) distingue
 * une adresse attribuée par l'IEEE d'une adresse choisie localement. Quand
 * il vaut 1, l'adresse ne correspond à AUCUN fabricant réel : c'est le cas
 * des adresses aléatoires que les smartphones récents (iOS, Android) et
 * Windows utilisent par confidentialité, et de certaines machines
 * virtuelles.
 *
 * Concrètement, le deuxième caractère hexadécimal vaut 2, 6, A ou E.
 *
 * Le signaler évite deux erreurs : afficher un fabricant faux (l'OUI d'une
 * MAC aléatoire peut par hasard exister dans le registre), et laisser
 * croire à une identification alors qu'il n'y en a pas.
 */
function estMacAleatoire(mac) {
  const oui = normaliserOui(mac);
  if (!oui) return false;
  const premierOctet = parseInt(oui.slice(0, 2), 16);
  if (Number.isNaN(premierOctet)) return false;
  return (premierOctet & 0x02) === 0x02;
}

/** Charge la graine embarquée. Sert de repli si la table est vide. */
function lireGraine() {
  try {
    const brut = zlib.gunzipSync(fs.readFileSync(CHEMIN_GRAINE));
    return new Map(Object.entries(JSON.parse(brut.toString("utf8"))));
  } catch (err) {
    console.error("Graine OUI illisible:", err.message);
    return new Map();
  }
}

/**
 * Charge le registre en mémoire : la table d'abord, la graine en repli.
 * ~53 000 entrées ≈ 5 Mo de mémoire, chargées une fois par heure.
 */
async function chargerRegistre(forcer = false) {
  if (!forcer && cache && cacheExpire > Date.now()) return cache;

  let table = new Map();
  let sansBase = false;
  try {
    const [rows] = await db.query("SELECT oui, fabricant FROM OUI_FABRICANT");
    table = new Map(rows.map((r) => [r.oui, r.fabricant]));
  } catch (err) {
    // Deux situations normales, qui ne doivent pas s'annoncer comme des
    // pannes : la table n'existe pas encore, ou il n'y a pas de base du
    // tout. Le second cas est celui de l'AGENT — il n'a délibérément
    // aucun accès à la base du serveur central, et affichait pourtant
    // « Lecture de OUI_FABRICANT impossible » à chaque cycle. Un message
    // d'erreur pour un fonctionnement prévu use la confiance de celui qui
    // installe, et masque les vraies erreurs au milieu.
    sansBase =
      err.code === "ER_NO_SUCH_TABLE" ||
      /variables d'environnement manquantes/i.test(err.message || "");
    if (!sansBase) {
      console.error("Lecture de OUI_FABRICANT impossible:", err.message);
    }
  }

  if (table.size > 0) {
    cache = table;
    origineCache = `table (${table.size} entrées)`;
  } else {
    cache = lireGraine();
    origineCache = sansBase
      ? `graine embarquée (${cache.size} entrées) — sans accès à la base, comportement normal pour un agent`
      : `graine embarquée (${cache.size} entrées) — table vide, lancer tools/importer-oui.js`;
  }

  cacheExpire = Date.now() + DUREE_CACHE_MS;
  return cache;
}

/**
 * Vendeurs dont toute la production relève d'un seul type d'équipement.
 * Sert à enrichir le type détecté SANS risque d'erreur — on n'y met que
 * des constructeurs mono-produit.
 *
 * Volontairement court : Hewlett-Packard fabrique des imprimantes ET des
 * serveurs ET des switches, il n'y a donc rien à en déduire. Voir le
 * rapport pour la piste « OUI + port ouvert », plus puissante mais qui
 * demande de connaître les ports au moment de la déduction.
 */
const TYPE_PAR_FABRICANT = new Map([
  ["Axis Communications", "camera"],
  ["Axis", "camera"],
  ["Hikvision", "camera"],
  ["Dahua", "camera"],
  ["Mobotix", "camera"],
  ["Zebra Technologies", "imprimante"],
  ["Zebra", "imprimante"],
  ["Brother Industries", "imprimante"],
  ["Brother", "imprimante"],
  ["Lexmark International", "imprimante"],
  ["Lexmark", "imprimante"],
  ["Kyocera Document Solutions", "imprimante"],
  ["Kyocera", "imprimante"],
  ["Yealink", "telephonie"],
  ["Yealink(Xiamen) Network Technology", "telephonie"],
  ["Grandstream Networks", "telephonie"],
  ["Grandstream", "telephonie"],
  ["Snom Technology", "telephonie"],
  ["Polycom", "telephonie"],
  ["Raspberry Pi Foundation", "serveur"],
  ["Raspberry Pi Trading", "serveur"],
  ["VMware", "serveur"],
  ["Synology", "serveur"],
  ["QNAP Systems", "serveur"],
]);

/**
 * Résout le fabricant d'une adresse MAC.
 *
 * @returns {Promise<{fabricant:string|null, source:string, aleatoire:boolean,
 *                    oui:string|null, type_suggere:string|null}>}
 */
async function resoudreFabricant(mac) {
  const oui = normaliserOui(mac);
  if (!oui) {
    return { fabricant: null, source: "aucune", aleatoire: false, oui: null, type_suggere: null };
  }

  if (estMacAleatoire(mac)) {
    // On ne consulte même pas le registre : la réponse serait trompeuse.
    return {
      fabricant: null,
      source: "mac_aleatoire",
      aleatoire: true,
      oui,
      type_suggere: null,
    };
  }

  const registre = await chargerRegistre();
  const fabricant = registre.get(oui) || null;

  return {
    fabricant,
    source: fabricant ? "oui" : "aucune",
    aleatoire: false,
    oui,
    type_suggere: fabricant ? TYPE_PAR_FABRICANT.get(fabricant) || null : null,
  };
}

/** Version synchrone, une fois le registre chargé (utile en lot). */
function resoudreAvecRegistre(mac, registre) {
  const oui = normaliserOui(mac);
  if (!oui) return { fabricant: null, source: "aucune", aleatoire: false, oui: null, type_suggere: null };
  if (estMacAleatoire(mac)) {
    return { fabricant: null, source: "mac_aleatoire", aleatoire: true, oui, type_suggere: null };
  }
  const fabricant = registre.get(oui) || null;
  return {
    fabricant,
    source: fabricant ? "oui" : "aucune",
    aleatoire: false,
    oui,
    type_suggere: fabricant ? TYPE_PAR_FABRICANT.get(fabricant) || null : null,
  };
}

/** État du registre, pour diagnostic et affichage. */
async function etatRegistre() {
  const registre = await chargerRegistre();
  return { entrees: registre.size, origine: origineCache };
}

module.exports = {
  normaliserOui,
  estMacAleatoire,
  resoudreFabricant,
  resoudreAvecRegistre,
  chargerRegistre,
  etatRegistre,
  TYPE_PAR_FABRICANT,
  _viderCache: () => {
    cache = null;
    cacheExpire = 0;
  },
};
