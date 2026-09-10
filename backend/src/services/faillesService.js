/**
 * services/faillesService.js
 * Rapprocher une version lue sur le réseau avec les failles publiées.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LA RÈGLE QUI GOUVERNE TOUT CE FICHIER
 *
 * On ne déduit rien. Chaque ligne produite ici vient du NVD (National
 * Vulnerability Database, NIST), porte son numéro CVE, son score officiel
 * et sa date de publication, et se vérifie sur nvd.nist.gov en un clic.
 *
 * C'est la condition pour que ce module ait le droit d'exister. La
 * migration du 7 septembre avait refusé, à raison, d'inscrire des CVE
 * dans ce produit : à l'époque le scan ne voyait qu'un numéro de port.
 * Depuis le 10 septembre il lit la VERSION que le service annonce, et
 * une version est la seule chose à laquelle une faille puisse être
 * rattachée sans mentir.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QU'ON DIT, ET CE QU'ON NE DIT PAS
 *
 * On dit : « OpenSSH 8.2 — 3 failles publiées, à vérifier. »
 * On ne dit PAS : « cette machine est vulnérable. »
 *
 * La nuance n'est pas de la prudence de façade, elle est technique. Le
 * rapprochement se fait sur la version numérique (« 8.2 » pour
 * « OpenSSH 8.2p1 ») : le niveau de correctif n'est pas distingué, et une
 * faille corrigée par un correctif peut donc remonter alors qu'elle ne
 * s'applique plus. Un correctif de distribution — le « Ubuntu-4ubuntu0.5 »
 * de la bannière — corrige d'ailleurs souvent la faille SANS changer le
 * numéro de version amont.
 *
 * Un outil qui prononcerait « vulnérable » sur cette base se tromperait
 * régulièrement, et le premier technicien qui vérifierait cesserait de
 * croire tout le reste du produit.
 *
 * ─────────────────────────────────────────────────────────────────────
 * L'ABSENCE DE RÉSULTAT N'EST PAS UNE BONNE NOUVELLE
 *
 * Trois situations rendent une liste vide, et elles n'ont rien à voir :
 *
 *   • interrogé, zéro faille publiée          → rassurant
 *   • logiciel sans correspondance connue     → on ne sait pas
 *   • jamais interrogé (pas d'import lancé)   → on n'a pas regardé
 *
 * INTERROGATION_FAILLES existe pour les distinguer. Confondre les deux
 * dernières avec la première serait le défaut le plus grave qu'un outil
 * de sécurité puisse avoir : rassurer sans avoir regardé.
 */
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");

const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";

/**
 * Cadence des requêtes au NVD.
 *
 * Sans clé : 5 requêtes par fenêtre glissante de 30 secondes, soit une
 * toutes les 6 secondes. Avec une clé (gratuite, sur nvd.nist.gov) : 50,
 * soit une toutes les 0,6 seconde. Dépasser fait répondre 403 à TOUTES
 * les requêtes suivantes, y compris légitimes — on respecte donc la
 * cadence plutôt que de gérer des erreurs qu'on s'est créées.
 */
const ATTENTE_SANS_CLE_MS = 6200;
const ATTENTE_AVEC_CLE_MS = 800;

const FICHIER_CPE = path.join(__dirname, "..", "..", "donnees", "cpe-produits.json");

let correspondances = null;

/** Charge la table de correspondance, une seule fois. */
function chargerCorrespondances() {
  if (correspondances) return correspondances;
  try {
    const brut = JSON.parse(fs.readFileSync(FICHIER_CPE, "utf8"));
    correspondances = brut.correspondances || {};
  } catch (err) {
    console.error(
      `Table de correspondance CPE illisible (${FICHIER_CPE}) : ${err.message}\n` +
        "  Le rapprochement avec les failles connues est désactivé — aucune " +
        "conclusion ne sera tirée d'une donnée absente."
    );
    correspondances = {};
  }
  return correspondances;
}

/**
 * La partie NUMÉRIQUE d'une version annoncée.
 * « 8.2p1 » → « 8.2 », « 3.0.3 » → « 3.0.3 »,
 * « 8.0.32-0ubuntu0.20.04.2 » → « 8.0.32 ».
 *
 * Le suffixe est retiré parce que le NVD indexe la version amont ; il est
 * CONSERVÉ ailleurs, dans SERVICE_DETECTE, où il reste consultable.
 */
function versionNumerique(version) {
  const m = String(version || "").match(/^\d+(?:\.\d+){0,3}/);
  return m ? m[0] : null;
}

/**
 * La chaîne CPE à interroger pour un couple (produit, version), ou null
 * si ce logiciel n'a pas de correspondance connue.
 *
 * `null` est une réponse à part entière : « je ne sais pas quoi
 * demander ». Elle est enregistrée telle quelle, jamais remplacée par une
 * supposition — un vendeur CPE inventé renverrait zéro faille, et ce zéro
 * serait lu comme une bonne nouvelle.
 */
function cpeDepuisProduit(produit, version) {
  const table = chargerCorrespondances();
  const cle = String(produit || "").trim().toLowerCase();
  const base = table[cle];
  if (!base) return null;

  const numero = versionNumerique(version);
  if (!numero) return null;

  return `${base}:${numero}`;
}

/**
 * Extrait ce qui nous intéresse d'une réponse du NVD.
 * Fonction pure : c'est elle qui est testée, sans réseau.
 */
function extraireFailles(reponse) {
  const items = Array.isArray(reponse?.vulnerabilities) ? reponse.vulnerabilities : [];
  return items
    .map((v) => {
      const cve = v?.cve;
      if (!cve?.id) return null;

      const description =
        (cve.descriptions || []).find((d) => d.lang === "en")?.value ||
        (cve.descriptions || [])[0]?.value ||
        null;

      // Le NVD publie plusieurs versions du barème CVSS. On prend la plus
      // récente disponible, sans jamais recalculer un score : un score
      // recalculé par nos soins ne serait plus le score officiel, et ne
      // pourrait plus être vérifié sur nvd.nist.gov.
      const metriques =
        cve.metrics?.cvssMetricV40?.[0] ||
        cve.metrics?.cvssMetricV31?.[0] ||
        cve.metrics?.cvssMetricV30?.[0] ||
        cve.metrics?.cvssMetricV2?.[0] ||
        null;

      const donnees = metriques?.cvssData || {};

      return {
        cve_id: cve.id,
        severite: donnees.baseSeverity || metriques?.baseSeverity || null,
        score: Number.isFinite(Number(donnees.baseScore)) ? Number(donnees.baseScore) : null,
        description: description ? String(description).slice(0, 4000) : null,
        publie: cve.published ? String(cve.published).slice(0, 10) : null,
      };
    })
    .filter(Boolean);
}

/**
 * Interroge le NVD pour une chaîne CPE.
 * @returns {Promise<{failles: Array, total: number}>}
 */
async function interrogerNvd(cpe, cleApi = process.env.NVD_API_KEY) {
  const url = `${NVD_URL}?virtualMatchString=${encodeURIComponent(cpe)}&resultsPerPage=200`;
  const entetes = { Accept: "application/json" };
  // Le NVD veut la clé dans un EN-TÊTE, pas dans l'adresse : passée en
  // paramètre elle serait ignorée, et la cadence retomberait à 5 requêtes
  // par 30 secondes sans que rien ne le signale.
  if (cleApi) entetes.apiKey = cleApi;

  const reponse = await fetch(url, { headers: entetes });
  if (!reponse.ok) {
    throw new Error(`NVD a répondu ${reponse.status} ${reponse.statusText}`);
  }
  const donnees = await reponse.json();
  return {
    failles: extraireFailles(donnees),
    total: Number(donnees?.totalResults) || 0,
  };
}

/** Les couples (produit, version) réellement observés sur le parc. */
async function logicielsObserves() {
  const [rows] = await db.query(
    `SELECT DISTINCT produit, version
     FROM SERVICE_DETECTE
     WHERE produit IS NOT NULL AND version IS NOT NULL
     ORDER BY produit, version`
  );
  return rows;
}

/** Enregistre le résultat d'une interrogation, succès comme échec. */
async function tracerInterrogation(produit, version, cpe, statut, nbResultats, detail) {
  await db.query(
    `INSERT INTO INTERROGATION_FAILLES
       (produit, version, cpe, statut, nb_resultats, detail, date_interrogation)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       cpe = VALUES(cpe), statut = VALUES(statut),
       nb_resultats = VALUES(nb_resultats), detail = VALUES(detail),
       date_interrogation = NOW()`,
    [produit, version, cpe, statut, nbResultats, detail ? String(detail).slice(0, 200) : null]
  );
}

async function enregistrerFailles(produit, version, cpe, failles) {
  if (failles.length === 0) return 0;
  const valeurs = failles.flatMap((f) => [
    produit, version, f.cve_id, f.severite, f.score, f.description, f.publie, cpe,
  ]);
  const [r] = await db.query(
    `INSERT INTO FAILLE_LOGICIEL
       (produit, version, cve_id, severite, score, description, publie, cpe)
     VALUES ${failles.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
     ON DUPLICATE KEY UPDATE
       severite = VALUES(severite), score = VALUES(score),
       description = VALUES(description), publie = VALUES(publie),
       cpe = VALUES(cpe), date_import = NOW()`,
    valeurs
  );
  return r.affectedRows;
}

const patienter = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Importe les failles pour tous les logiciels observés sur le parc.
 *
 * @param {(texte:string)=>void} dire  pour rendre compte au fur et à mesure
 * @returns {Promise<{interroges:number, sansCpe:number, erreurs:number, failles:number}>}
 */
async function importerFailles(dire = () => {}) {
  const logiciels = await logicielsObserves();
  const bilan = { interroges: 0, sansCpe: 0, erreurs: 0, failles: 0 };

  if (logiciels.length === 0) {
    dire(
      "Aucun logiciel avec version en base. Lancez d'abord un scan : les " +
        "versions se lisent au scan, pas à l'import."
    );
    return bilan;
  }

  const cleApi = process.env.NVD_API_KEY || null;
  const attente = cleApi ? ATTENTE_AVEC_CLE_MS : ATTENTE_SANS_CLE_MS;
  dire(
    `${logiciels.length} logiciel(s) à interroger, ` +
      `une requête toutes les ${(attente / 1000).toFixed(1)} s ` +
      `(${cleApi ? "avec" : "sans"} clé NVD) — environ ` +
      `${Math.ceil((logiciels.length * attente) / 60000)} minute(s).`
  );

  for (const [i, l] of logiciels.entries()) {
    const cpe = cpeDepuisProduit(l.produit, l.version);
    const etiquette = `${l.produit} ${l.version}`;

    if (!cpe) {
      bilan.sansCpe++;
      await tracerInterrogation(
        l.produit, l.version, null, "sans_cpe", 0,
        "aucune correspondance CPE connue pour ce logiciel"
      );
      dire(`  ${etiquette} — pas de correspondance connue, rien n'est affirmé`);
      continue;
    }

    try {
      const { failles, total } = await interrogerNvd(cpe, cleApi);
      const ecrites = await enregistrerFailles(l.produit, l.version, cpe, failles);
      await tracerInterrogation(l.produit, l.version, cpe, "ok", total, null);
      bilan.interroges++;
      bilan.failles += ecrites;
      dire(`  ${etiquette} — ${total} faille(s) publiée(s)`);
    } catch (err) {
      bilan.erreurs++;
      // « erreur » et non « 0 résultat » : on n'a PAS regardé, et l'écran
      // doit le dire au lieu de rassurer.
      await tracerInterrogation(l.produit, l.version, cpe, "erreur", 0, err.message);
      dire(`  ${etiquette} — NON INTERROGÉ : ${err.message}`);
    }

    if (i < logiciels.length - 1) await patienter(attente);
  }

  return bilan;
}

/**
 * Les failles connues des services d'un équipement, AVEC l'état de
 * l'interrogation pour chacun — c'est cet état qui distingue « rien à
 * signaler » de « personne n'a regardé ».
 */
async function faillesDeLEquipement(idEquipement) {
  const [services] = await db.query(
    `SELECT port, nom_service, produit, version
     FROM SERVICE_DETECTE
     WHERE id_equipement = ? AND produit IS NOT NULL
     ORDER BY port`,
    [idEquipement]
  );
  if (services.length === 0) return [];

  const resultat = [];
  for (const s of services) {
    if (!s.version) {
      resultat.push({
        ...s,
        statut: "sans_version",
        explication:
          "ce service annonce son nom mais pas sa version : aucune faille ne " +
          "peut lui être rattachée sans supposer",
        failles: [],
      });
      continue;
    }

    const [[interrogation]] = await db.query(
      `SELECT statut, nb_resultats, detail, date_interrogation
       FROM INTERROGATION_FAILLES WHERE produit = ? AND version = ?`,
      [s.produit, s.version]
    );

    if (!interrogation) {
      resultat.push({
        ...s,
        statut: "jamais_interroge",
        explication:
          "la base des failles publiées n'a jamais été interrogée pour ce " +
          "logiciel — absence d'information, pas absence de faille",
        failles: [],
      });
      continue;
    }

    const [failles] = await db.query(
      `SELECT cve_id, severite, score, description, publie
       FROM FAILLE_LOGICIEL WHERE produit = ? AND version = ?
       ORDER BY score DESC, cve_id`,
      [s.produit, s.version]
    );

    resultat.push({
      ...s,
      statut: interrogation.statut,
      date_interrogation: interrogation.date_interrogation,
      explication:
        interrogation.statut === "erreur"
          ? `interrogation échouée (${interrogation.detail || "cause inconnue"}) — rien n'a pu être vérifié`
          : interrogation.statut === "sans_cpe"
            ? "ce logiciel n'a pas de correspondance dans la base publique : on ne sait pas quoi demander"
            : failles.length === 0
              ? "interrogé, aucune faille publiée pour cette version"
              /* PLUS DE FAILLES PUBLIÉES QU'ON N'EN A GARDÉES.

                 Une requête au NVD rend au plus deux cents résultats. Un
                 logiciel très ancien peut en compter davantage : on
                 afficherait alors deux cents lignes en laissant croire
                 qu'elles sont toutes. Le compte réel est connu — il est
                 enregistré au moment de l'interrogation — donc on le dit
                 au lieu de le taire. */
              : Number(interrogation.nb_resultats) > failles.length
                ? `${interrogation.nb_resultats} failles publiées pour cette version ; ` +
                  `les ${failles.length} premières sont listées ici, les plus graves d'abord`
                : null,
      failles,
    });
  }

  return resultat;
}

module.exports = {
  cpeDepuisProduit,
  versionNumerique,
  extraireFailles,
  interrogerNvd,
  importerFailles,
  faillesDeLEquipement,
  logicielsObserves,
  NVD_URL,
};
