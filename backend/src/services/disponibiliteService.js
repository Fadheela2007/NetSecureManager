/**
 * disponibiliteService.js
 * Calcul du taux de disponibilité par équipement sur une période donnée.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MÉTHODE RETENUE : les ALERTES font foi, les RELEVÉS mesurent la confiance.
 *
 * Deux approches étaient possibles :
 *
 *   A. Compter les relevés enregistrés par rapport au nombre attendu.
 *   B. Additionner les durées des alertes `equipement_down`.
 *
 * J'ai retenu B pour le calcul, avec A comme indicateur de fiabilité.
 * Raison décisive : si le backend est resté arrêté deux jours, la méthode A
 * conclut que TOUS les équipements ont été indisponibles deux jours. C'est la
 * réponse la plus fausse possible — on confond « je n'ai pas regardé » avec
 * « c'était en panne ». La méthode B, elle, ne voit aucune alerte et ne
 * conclut rien.
 *
 * Mais B a ses propres angles morts, tous rendus explicites dans la réponse :
 *
 *   • Une panne plus courte que `seuil_echecs_avant_alerte` cycles (3 min par
 *     défaut) ne crée pas d'alerte : elle est invisible. Le taux est donc un
 *     majorant — la disponibilité réelle est au mieux celle affichée.
 *   • Un équipement découvert récemment n'a pas d'historique sur toute la
 *     période : on ramène le calcul à sa durée d'existence réelle.
 *   • Si le backend n'a pas tourné, B ne le sait pas. D'où le contrôle de
 *     couverture ci-dessous.
 *
 * CONTRÔLE DE COUVERTURE — c'est le rôle des relevés.
 * On compte les heures distinctes où AU MOINS UN équipement du parc a produit
 * un relevé. Peu importe lequel : ce qui est mesuré, c'est « le backend
 * tournait-il ». Cela sépare proprement « cet équipement était en panne »
 * (les autres ont des relevés) de « le backend était arrêté » (personne n'en a).
 * ─────────────────────────────────────────────────────────────────────
 *
 * ⚠ LIMITE ARCHITECTURALE À CONNAÎTRE — voir le rapport.
 * Le cycle de supervision pingue TOUS les équipements depuis le serveur
 * central, y compris ceux des sites distants. Si ces machines sont sur un
 * réseau privé inaccessible depuis le central, elles apparaissent en panne
 * permanente et leur taux de disponibilité est dénué de sens. Le champ
 * `avertissements` le signale quand le cas est détecté.
 */

const db = require("../db");

/** En dessous de ce taux de couverture, le chiffre n'est pas présenté comme fiable. */
const COUVERTURE_MIN_FIABLE = 0.8;

/** Durée minimale d'observation en dessous de laquelle un taux n'a pas de sens. */
const HEURES_MIN_OBSERVATION = 24;

/**
 * Cache de la couverture de collecte. Identique pour tous les équipements
 * d'une même période : inutile de refaire le COUNT(DISTINCT ...) sur RELEVE
 * pour chaque ligne d'un rapport de 200 équipements.
 */
const CACHE_MS = 5 * 60000;
const cacheCouverture = new Map(); // jours -> { valeur, expire }

function bornerJours(jours) {
  const n = Number(jours);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

/**
 * Part de la période pendant laquelle le backend a effectivement collecté.
 * Mesurée à l'échelle du parc entier, pas d'un équipement.
 *
 * @returns {{ heuresObservees: number, heuresAttendues: number, taux: number }}
 */
async function couvertureCollecte(jours) {
  const cle = String(jours);
  const enCache = cacheCouverture.get(cle);
  if (enCache && enCache.expire > Date.now()) return enCache.valeur;

  const heuresAttendues = jours * 24;
  const [rows] = await db.query(
    `SELECT COUNT(DISTINCT DATE_FORMAT(date_releve, '%Y-%m-%d %H')) AS heures
     FROM RELEVE
     WHERE date_releve >= NOW() - INTERVAL ? DAY`,
    [jours]
  );

  const heuresObservees = Number(rows[0]?.heures || 0);
  const valeur = {
    heuresObservees,
    heuresAttendues,
    taux: heuresAttendues > 0 ? Math.min(1, heuresObservees / heuresAttendues) : 0,
  };

  cacheCouverture.set(cle, { valeur, expire: Date.now() + CACHE_MS });
  return valeur;
}

/**
 * Minutes d'indisponibilité par équipement sur la période, en UNE requête
 * pour tout le parc (utilisée par les rapports).
 *
 * Chaque alerte est ramenée à la fenêtre demandée :
 *   début = max(date_creation, début de fenêtre)
 *   fin   = min(date_resolution ou maintenant, maintenant)
 * Une alerte encore active compte donc jusqu'à l'instant présent.
 *
 * @returns {Map<number, { minutes: number, pannes: number }>}
 */
async function indisponibiliteParEquipement(jours) {
  const [rows] = await db.query(
    `SELECT a.id_equipement,
            SUM(
              GREATEST(0, TIMESTAMPDIFF(
                SECOND,
                GREATEST(a.date_creation, NOW() - INTERVAL ? DAY),
                LEAST(COALESCE(a.date_resolution, NOW()), NOW())
              ))
            ) AS secondes,
            COUNT(*) AS pannes
     FROM ALERTE a
     WHERE a.type_alerte = 'equipement_down'
       AND a.id_equipement IS NOT NULL
       AND COALESCE(a.date_resolution, NOW()) >= NOW() - INTERVAL ? DAY
     GROUP BY a.id_equipement`,
    [jours, jours]
  );

  const map = new Map();
  for (const r of rows) {
    map.set(Number(r.id_equipement), {
      minutes: Number(r.secondes || 0) / 60,
      pannes: Number(r.pannes || 0),
    });
  }
  return map;
}

/**
 * Compose le résultat pour un équipement à partir des éléments déjà collectés.
 * Séparée pour que le mode « lot » (rapports) n'exécute pas N requêtes.
 */
function composer({ equipement, jours, indispo, couverture }) {
  const maintenant = Date.now();
  const debutFenetre = maintenant - jours * 24 * 3600 * 1000;

  // Un équipement découvert il y a 2 jours n'a pas d'historique sur 30 jours :
  // on ramène le calcul à sa durée d'existence réelle plutôt que de supposer
  // qu'il allait bien avant d'exister.
  const premiereTrace = equipement.date_ajout
    ? new Date(equipement.date_ajout).getTime()
    : debutFenetre;
  const debutEffectif = Math.max(debutFenetre, premiereTrace);
  const heuresObservables = (maintenant - debutEffectif) / 3600000;

  const avertissements = [];
  let fiable = true;

  if (heuresObservables < HEURES_MIN_OBSERVATION) {
    fiable = false;
    avertissements.push(
      `Équipement découvert il y a moins de ${HEURES_MIN_OBSERVATION} h : ` +
        `l'historique est trop court pour un taux significatif.`
    );
  } else if (premiereTrace > debutFenetre) {
    const joursReels = Math.floor(heuresObservables / 24);
    avertissements.push(
      `Équipement découvert après le début de la période : le taux porte sur ` +
        `${joursReels} jour(s) réellement observés, pas sur ${jours}.`
    );
  }

  if (couverture.taux < COUVERTURE_MIN_FIABLE) {
    fiable = false;
    avertissements.push(
      `La supervision n'a collecté que ${Math.round(couverture.taux * 100)} % de la période ` +
        `(${couverture.heuresObservees} h sur ${couverture.heuresAttendues} h). ` +
        `Le backend a probablement été arrêté : les pannes survenues pendant ces ` +
        `interruptions n'ont pas pu être détectées.`
    );
  }

  const minutesIndispo = Math.min(indispo.minutes, heuresObservables * 60);
  const minutesObservables = heuresObservables * 60;
  const taux =
    minutesObservables > 0
      ? Math.max(0, Math.min(100, ((minutesObservables - minutesIndispo) / minutesObservables) * 100))
      : null;

  // Une panne plus courte que le seuil d'alerte ne laisse aucune trace :
  // le taux est structurellement un majorant.
  avertissements.push(
    "Les interruptions plus courtes que le seuil d'alerte (quelques minutes) " +
      "ne sont pas comptabilisées : ce taux est un majorant."
  );

  return {
    id_equipement: equipement.id_equipement,
    nom: equipement.nom,
    adresse_ip: equipement.adresse_ip,
    periode_jours: jours,
    debut_effectif: new Date(debutEffectif).toISOString(),
    heures_observables: Math.round(heuresObservables * 10) / 10,
    minutes_indisponible: Math.round(minutesIndispo),
    nb_pannes: indispo.pannes,
    taux_disponibilite: fiable && taux !== null ? Math.round(taux * 100) / 100 : null,
    taux_indicatif: taux !== null ? Math.round(taux * 100) / 100 : null,
    fiable,
    couverture_pourcent: Math.round(couverture.taux * 1000) / 10,
    avertissements,
  };
}

/** Disponibilité d'un seul équipement. */
async function calculerDisponibilite(idEquipement, joursDemandes) {
  const jours = bornerJours(joursDemandes);

  const [rows] = await db.query(
    "SELECT id_equipement, nom, adresse_ip, id_site, date_ajout FROM EQUIPEMENT WHERE id_equipement = ?",
    [idEquipement]
  );
  if (rows.length === 0) return null;

  const [couverture, indispoTous] = await Promise.all([
    couvertureCollecte(jours),
    indisponibiliteParEquipement(jours),
  ]);

  return composer({
    equipement: rows[0],
    jours,
    indispo: indispoTous.get(Number(idEquipement)) || { minutes: 0, pannes: 0 },
    couverture,
  });
}

/**
 * Disponibilité de plusieurs équipements — 3 requêtes au total, quel que soit
 * le nombre d'équipements. Utilisée par les rapports PDF et Excel.
 */
async function calculerDisponibiliteLot(equipements, joursDemandes) {
  const jours = bornerJours(joursDemandes);
  if (!equipements || equipements.length === 0) return new Map();

  const [couverture, indispoTous] = await Promise.all([
    couvertureCollecte(jours),
    indisponibiliteParEquipement(jours),
  ]);

  const resultats = new Map();
  for (const eq of equipements) {
    resultats.set(
      Number(eq.id_equipement),
      composer({
        equipement: eq,
        jours,
        indispo: indispoTous.get(Number(eq.id_equipement)) || { minutes: 0, pannes: 0 },
        couverture,
      })
    );
  }
  return resultats;
}

module.exports = {
  calculerDisponibilite,
  calculerDisponibiliteLot,
  couvertureCollecte,
  _viderCache: () => cacheCouverture.clear(),
};
