/**
 * services/observationDnsDepot.js
 * Enregistrement et lecture des relevés DNS.
 *
 * SÉPARÉ DE observationDnsService, ET CE N'EST PAS DU RANGEMENT.
 *
 * L'analyse d'un nom de domaine tourne à DEUX endroits : sur le serveur
 * central, et sur l'agent d'un site distant — c'est même là qu'elle rend
 * le plus de service, puisque l'agrégation doit se faire avant l'envoi.
 * Or l'agent n'a aucun accès à la base de données du central : c'est la
 * raison même de son existence.
 *
 * Si l'analyse et l'écriture vivaient dans le même fichier, l'agent
 * ouvrirait une connexion à une base qu'il ne peut pas joindre, pour
 * n'utiliser que des fonctions de calcul. D'où la coupure : le calcul
 * d'un côté, la base de l'autre.
 */
const db = require("../db");
const { analyserNom } = require("./observationDnsService");

/**
 * Nombre maximal de domaines conservés par machine.
 *
 * Un poste ordinaire en contacte quelques centaines. Au-delà de ce
 * plafond, on garde les plus fréquents : la queue d'une distribution de
 * ce genre est faite de domaines vus une ou deux fois, qui n'apprennent
 * rien et occuperaient l'essentiel de la table.
 */
const MAX_DOMAINES_PAR_MACHINE = 400;

/**
 * Retrouve l'équipement derrière une adresse. NE LE CRÉE PAS.
 *
 * Une requête DNS n'est pas une preuve d'existence exploitable pour
 * l'inventaire : elle est vue par un tiers — le résolveur — et non
 * constatée sur la machine. Surtout, créer un équipement ici
 * contournerait la règle posée le 9 septembre : une adresse n'entre à
 * l'inventaire que sur une preuve directe. On ne rouvre pas par une
 * porte de côté ce qu'on a fermé par la grande.
 */
async function equipementParIp(idSite, ip) {
  const [rows] = await db.query(
    "SELECT id_equipement FROM EQUIPEMENT WHERE id_site = ? AND adresse_ip = ? LIMIT 1",
    [idSite, ip]
  );
  return rows[0] ? rows[0].id_equipement : null;
}

/** Écrit les domaines vus par une machine, en additionnant les compteurs. */
async function enregistrerDomaines(idEquipement, domaines) {
  if (!Array.isArray(domaines) || domaines.length === 0) return 0;

  const retenus = domaines.slice(0, MAX_DOMAINES_PAR_MACHINE);
  const TAILLE_LOT = 100;
  let ecrits = 0;

  for (let i = 0; i < retenus.length; i += TAILLE_LOT) {
    const lot = retenus.slice(i, i + TAILLE_LOT);
    const valeurs = lot.flatMap((d) => {
      const analyse = analyserNom(d.domaine);
      return [
        idEquipement,
        String(d.domaine).slice(0, 120),
        analyse.categorie,
        Math.max(1, Number(d.n) || 1),
      ];
    });

    // `compteur = compteur + VALUES(compteur)` : on ADDITIONNE. Chaque
    // envoi porte ce qui s'est passé depuis le précédent, pas un total.
    // Remplacer au lieu d'additionner ferait retomber le compteur à
    // quelques unités à chaque cycle, et « 340 fois depuis le 2
    // septembre » deviendrait « 3 fois », indéfiniment.
    await db.query(
      `INSERT INTO OBSERVATION_DNS (id_equipement, domaine, categorie, compteur)
       VALUES ${lot.map(() => "(?, ?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE
         compteur = compteur + VALUES(compteur),
         categorie = COALESCE(VALUES(categorie), categorie),
         derniere_vue = NOW()`,
      valeurs
    );
    ecrits += lot.length;
  }
  return ecrits;
}

/** Écrit ce qui mérite un regard, en dédoublonnant. */
async function enregistrerSignaux(idEquipement, domaines) {
  let nb = 0;
  for (const d of domaines) {
    const analyse = analyserNom(d.domaine);
    for (const s of analyse.signaux) {
      await db.query(
        `INSERT INTO SIGNAL_DNS (id_equipement, code, gravite, domaine, detail)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           occurrences = occurrences + 1,
           gravite = VALUES(gravite),
           detail = VALUES(detail),
           derniere_vue = NOW()`,
        [idEquipement, s.code, s.gravite, String(d.domaine).slice(0, 120), s.texte.slice(0, 400)]
      );
      nb++;
    }
  }
  return nb;
}

/**
 * Reçoit le relevé agrégé d'un agent.
 * @param {number} idSite
 * @param {Array<{ip:string, domaines:Array}>} releves
 */
async function recevoirReleves(idSite, releves) {
  const bilan = { machines: 0, domaines: 0, signaux: 0, inconnues: 0 };
  if (!Array.isArray(releves)) return bilan;

  for (const r of releves) {
    const idEquipement = await equipementParIp(idSite, r.ip);
    if (!idEquipement) {
      // Une adresse qui parle au résolveur sans figurer à l'inventaire
      // est une information en soi — une machine que le scan n'a jamais
      // vue. On la COMPTE pour pouvoir le dire, sans l'inscrire.
      bilan.inconnues++;
      continue;
    }
    bilan.machines++;
    bilan.domaines += await enregistrerDomaines(idEquipement, r.domaines || []);
    bilan.signaux += await enregistrerSignaux(idEquipement, r.domaines || []);
  }
  return bilan;
}

/** Ce qu'une machine contacte, et ce qui mérite un regard. */
async function observationsDeLEquipement(idEquipement, limite = 40) {
  const [[site]] = await db.query(
    `SELECT s.observation_dns, s.observation_dns_depuis
     FROM EQUIPEMENT e JOIN SITE s ON s.id_site = e.id_site
     WHERE e.id_equipement = ?`,
    [idEquipement]
  );

  // Observation éteinte : on le DIT. Une liste vide sans ce message se
  // lirait « cette machine ne contacte rien », ce qui est faux de toute
  // machine allumée.
  if (!site || !site.observation_dns) {
    return {
      active: false,
      explication:
        "l'observation des domaines n'est pas activée sur ce site — " +
        "aucune donnée n'est collectée, ce n'est pas une absence d'activité",
      domaines: [],
      signaux: [],
    };
  }

  const [domaines] = await db.query(
    `SELECT domaine, categorie, compteur, premiere_vue, derniere_vue
     FROM OBSERVATION_DNS WHERE id_equipement = ?
     ORDER BY compteur DESC LIMIT ?`,
    [idEquipement, Number(limite) || 40]
  );
  const [signaux] = await db.query(
    `SELECT code, gravite, domaine, detail, occurrences, premiere_vue, derniere_vue
     FROM SIGNAL_DNS WHERE id_equipement = ?
     ORDER BY FIELD(gravite, 'critique', 'avertissement', 'information'), derniere_vue DESC`,
    [idEquipement]
  );
  const [[total]] = await db.query(
    "SELECT COUNT(*) AS n FROM OBSERVATION_DNS WHERE id_equipement = ?",
    [idEquipement]
  );

  return {
    active: true,
    depuis: site.observation_dns_depuis,
    total_domaines: total.n,
    domaines,
    signaux,
  };
}

/**
 * Efface les domaines qu'on ne voit plus depuis le délai configuré.
 *
 * Une conservation sans fin transformerait le relevé en historique de
 * comportement sur plusieurs années — exactement ce que le dispositif
 * s'interdit. Le délai est un réglage, mais son absence n'est pas une
 * option : sans valeur configurée, on retombe sur 90 jours.
 */
async function purgerObservations() {
  const [[cfg]] = await db.query(
    "SELECT valeur FROM CONFIGURATION WHERE cle = 'retention_observations_dns_jours'"
  ).catch(() => [[null]]);

  const jours = Math.max(1, Number(cfg?.valeur) || 90);
  const [r] = await db.query(
    "DELETE FROM OBSERVATION_DNS WHERE derniere_vue < NOW() - INTERVAL ? DAY",
    [jours]
  );
  const [r2] = await db.query(
    "DELETE FROM SIGNAL_DNS WHERE derniere_vue < NOW() - INTERVAL ? DAY",
    [jours]
  );
  return { domaines: r.affectedRows, signaux: r2.affectedRows, jours };
}

module.exports = {
  recevoirReleves,
  observationsDeLEquipement,
  purgerObservations,
  equipementParIp,
  MAX_DOMAINES_PAR_MACHINE,
};
