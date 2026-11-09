/**
 * disponibiliteService.js
 * Taux de disponibilité par équipement sur une période donnée.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUI A CHANGÉ LE 28/09, ET POURQUOI IL LE FALLAIT
 *
 * Le calcul additionnait la durée des alertes `equipement_down`. Le
 * raisonnement d'origine était bon : compter les relevés reçus par
 * rapport au nombre ATTENDU conclut qu'un parc entier était en panne
 * pendant les deux jours où le serveur est resté arrêté. On confond « je
 * n'ai pas regardé » avec « c'était en panne ».
 *
 * Mais depuis que les postes de travail ne lèvent plus d'alerte
 * `equipement_down` — et c'était une bonne décision, alerter sur un poste
 * éteint le soir apprend à ignorer les alertes — ce calcul rendait
 * mécaniquement 100,00 % pour TOUT poste de travail. Un poste éteint
 * quatorze heures par jour pendant trente jours sortait à 100 % dans le
 * rapport remis au dirigeant. Le vrai chiffre est proche de 42 %.
 *
 * Même chose pour une machine restée « inconnue » : jamais d'alerte,
 * donc comptée disponible en permanence. Le seul chiffre qu'un décideur
 * regarde vraiment était faux, et faux dans le sens flatteur.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE NOUVEAU CALCUL, ET COMMENT IL RÉPOND À L'OBJECTION D'ORIGINE
 *
 *     taux = cycles où CETTE machine a répondu
 *            ────────────────────────────────────
 *            cycles réellement effectués sur SON site
 *
 * Le dénominateur n'est pas le nombre de cycles ATTENDUS — c'est le
 * nombre de cycles qui ont EU LIEU. Ils se mesurent : un cycle a eu lieu
 * à telle minute si au moins une machine du site y a produit un relevé.
 *
 * Les heures pendant lesquelles le serveur était arrêté ne produisent
 * aucun relevé pour personne : elles ne sont donc dans aucun des deux
 * termes. L'objection d'origine tombe, sans qu'on ait besoin de deviner
 * quoi que ce soit.
 *
 * ── POURQUOI PAR SITE, ET PAS SUR LE PARC ENTIER ──
 *
 * Le cycle central tourne chaque minute ; un agent distant envoie toutes
 * les cinq minutes. Un dénominateur commun mettrait donc les machines
 * d'un site à agent à 20 % de disponibilité — elles répondent une fois
 * sur cinq à une cadence qui n'est pas la leur. Chaque site est comparé
 * à sa propre cadence.
 *
 * ── POURQUOI `latence_ms IS NOT NULL` ──
 *
 * C'est la marque d'une réponse au ping. Le collecteur NetFlow écrit lui
 * aussi dans RELEVE, toutes les cinq minutes, mais ses lignes prouvent
 * que le routeur a vu passer du trafic, pas que la machine a répondu. Les
 * confondre ferait baisser la cadence apparente du site.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE LE CHIFFRE VEUT DIRE, ET CE QU'IL NE VEUT PAS DIRE
 *
 * Pour un serveur, une imprimante, un routeur : c'est bien un taux de
 * disponibilité, et 98 % est un mauvais résultat.
 *
 * Pour un POSTE DE TRAVAIL, c'est un taux de PRÉSENCE. 42 % décrit
 * quelqu'un qui éteint son ordinateur le soir et le week-end — c'est le
 * comportement attendu, pas une panne. La réponse le dit explicitement
 * plutôt que de laisser un rouge alarmant sur un écran.
 *
 * ── CE QUI RESTE UN ANGLE MORT ──
 *
 * Une panne plus courte que l'intervalle entre deux cycles passe entre
 * les mailles. À une minute d'intervalle c'est peu ; sur un site à agent,
 * cinq minutes de coupure peuvent ne laisser aucune trace. Le taux reste
 * un majorant, et la réponse le répète.
 */

const db = require("../db");

/** En dessous de ce nombre de cycles observés, un taux n'a pas de sens. */
const CYCLES_MIN_FIABLE = 200;

/** Durée minimale d'observation en dessous de laquelle un taux n'a pas de sens. */
const HEURES_MIN_OBSERVATION = 24;

/**
 * En dessous de deux machines qui alimentent le dénominateur, celui-ci est
 * défini par la machine qu'on mesure elle-même — elle sort donc à 100 %
 * par construction. Le cas est rare (un site d'une seule machine) mais il
 * doit être dit, pas masqué.
 */
const MACHINES_MIN_FIABLE = 2;

/**
 * Cache des agrégats. Les deux requêtes balaient RELEVE sur toute la
 * période : les refaire pour chacune des 200 lignes d'un rapport serait
 * absurde, et elles rendent le même résultat à cinq minutes près.
 */
const CACHE_MS = 5 * 60000;
const cacheAgregats = new Map(); // jours -> { valeur, expire }

function bornerJours(jours) {
  const n = Number(jours);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

/**
 * Jour local au format AAAA-MM-JJ.
 *
 * PAS `toISOString()`. Celui-ci convertit en UTC : à Douala, minuit local
 * devient 23 h la veille, et toutes les comparaisons de jour glissent d'un
 * cran. C'est exactement le défaut trouvé dans le graphe des alertes par
 * jour, et il n'a aucune raison d'être réintroduit ici.
 */
function jourLocal(date) {
  const d = date instanceof Date ? date : new Date(date);
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  const jour = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mois}-${jour}`;
}

/**
 * Les deux agrégats, en deux requêtes pour tout le parc.
 *
 * Découpés PAR JOUR pour qu'un équipement découvert en cours de période
 * puisse être comparé aux seuls jours où il existait, sans refaire une
 * requête par équipement.
 *
 * @returns {{ parSite: Map<string,{cycles,machines}>, parEquipement: Map<string,number>, joursDuParc: Set<string> }}
 */
async function chargerAgregats(jours) {
  const cle = String(jours);
  const enCache = cacheAgregats.get(cle);
  if (enCache && enCache.expire > Date.now()) return enCache.valeur;

  const [lignesSite, lignesEquipement] = await Promise.all([
    /* Les cycles qui ont EU LIEU, par site et par jour. Un cycle = une
       minute pendant laquelle au moins une machine du site a répondu. */
    db.query(
      `SELECT e.id_site,
              DATE_FORMAT(r.date_releve, '%Y-%m-%d') AS jour,
              COUNT(DISTINCT DATE_FORMAT(r.date_releve, '%Y-%m-%d %H:%i')) AS cycles,
              COUNT(DISTINCT r.id_equipement) AS machines
         FROM RELEVE r
         JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
        WHERE r.date_releve >= NOW() - INTERVAL ? DAY
          AND r.latence_ms IS NOT NULL
        GROUP BY e.id_site, jour`,
      [jours]
    ),
    /* Les cycles auxquels CHAQUE machine a répondu, par jour. */
    db.query(
      `SELECT r.id_equipement,
              DATE_FORMAT(r.date_releve, '%Y-%m-%d') AS jour,
              COUNT(DISTINCT DATE_FORMAT(r.date_releve, '%Y-%m-%d %H:%i')) AS cycles
         FROM RELEVE r
        WHERE r.date_releve >= NOW() - INTERVAL ? DAY
          AND r.latence_ms IS NOT NULL
        GROUP BY r.id_equipement, jour`,
      [jours]
    ),
  ]);

  const parSite = new Map();
  for (const l of lignesSite[0]) {
    parSite.set(`${l.id_site}|${l.jour}`, {
      cycles: Number(l.cycles || 0),
      machines: Number(l.machines || 0),
    });
  }

  const parEquipement = new Map();
  for (const l of lignesEquipement[0]) {
    parEquipement.set(`${l.id_equipement}|${l.jour}`, Number(l.cycles || 0));
  }

  const valeur = { parSite, parEquipement };
  cacheAgregats.set(cle, { valeur, expire: Date.now() + CACHE_MS });
  return valeur;
}

/** La liste des jours de la fenêtre, du plus ancien à aujourd'hui. */
function joursDeLaFenetre(jours) {
  const liste = [];
  const aujourdhui = new Date();
  for (let i = jours - 1; i >= 0; i -= 1) {
    const d = new Date(aujourdhui);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    liste.push(jourLocal(d));
  }
  return liste;
}

/**
 * Compose le résultat pour un équipement à partir des agrégats déjà lus.
 * Séparée pour que le mode « lot » (rapports) n'exécute pas N requêtes.
 */
function composer({ equipement, jours, agregats }) {
  const maintenant = Date.now();
  const debutFenetre = maintenant - jours * 24 * 3600 * 1000;

  // Un équipement découvert il y a deux jours n'a pas d'historique sur
  // trente : on le compare aux seuls jours où il existait, plutôt que de
  // supposer qu'il allait bien avant d'exister.
  const premiereTrace = equipement.date_ajout
    ? new Date(equipement.date_ajout).getTime()
    : debutFenetre;
  const debutEffectif = Math.max(debutFenetre, premiereTrace);
  const heuresObservables = Math.max(0, (maintenant - debutEffectif) / 3600000);
  const jourArrivee = jourLocal(new Date(debutEffectif));

  const idSite = equipement.id_site;
  const idEquipement = Number(equipement.id_equipement);

  let cyclesSite = 0;
  let cyclesRepondus = 0;
  let machinesMax = 0;

  for (const jour of joursDeLaFenetre(jours)) {
    if (jour < jourArrivee) continue; // comparaison de chaînes AAAA-MM-JJ : sûre
    const site = agregats.parSite.get(`${idSite}|${jour}`);
    if (!site || site.cycles === 0) continue; // aucun cycle ce jour-là : rien à compter
    cyclesSite += site.cycles;
    machinesMax = Math.max(machinesMax, site.machines);
    cyclesRepondus += agregats.parEquipement.get(`${idEquipement}|${jour}`) || 0;
  }

  const avertissements = [];
  let fiable = true;

  const taux =
    cyclesSite > 0 ? Math.max(0, Math.min(100, (cyclesRepondus / cyclesSite) * 100)) : null;

  if (cyclesSite === 0) {
    fiable = false;
    avertissements.push(
      "Aucun cycle de supervision n'a été enregistré sur ce site pendant la période : " +
        "il n'y a rien à quoi comparer cette machine."
    );
  }

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

  if (cyclesSite > 0 && cyclesSite < CYCLES_MIN_FIABLE) {
    fiable = false;
    avertissements.push(
      `Seulement ${cyclesSite} cycle(s) de supervision sur la période. ` +
        `La supervision a probablement été arrêtée une grande partie du temps : ` +
        `les pannes survenues pendant ces interruptions n'ont pas pu être vues.`
    );
  }

  if (cyclesSite > 0 && machinesMax < MACHINES_MIN_FIABLE) {
    fiable = false;
    avertissements.push(
      "Cette machine est la seule de son site à produire des relevés : elle définit " +
        "donc elle-même la cadence à laquelle on la compare, et ressort à 100 % par " +
        "construction. Le chiffre n'a pas de valeur tant qu'une deuxième machine n'est " +
        "pas supervisée sur ce site."
    );
  }

  /* CE QUE MESURE LE CHIFFRE DÉPEND DU TYPE DE MACHINE, et le taire
     produirait un rouge alarmant sur un comportement normal. */
  const type = String(equipement.type_libelle || "").toLowerCase();
  const estPoste = type === "poste_travail";
  if (estPoste) {
    avertissements.push(
      "Sur un poste de travail, ce chiffre est un taux de PRÉSENCE, pas de " +
        "disponibilité : un poste éteint le soir et le week-end tourne autour de " +
        "40 %, et c'est le comportement attendu."
    );
  }

  avertissements.push(
    "Une interruption plus courte que l'intervalle entre deux cycles ne laisse " +
      "aucune trace : ce taux est un majorant."
  );

  const minutesObservables = heuresObservables * 60;
  const partIndispo = cyclesSite > 0 ? (cyclesSite - cyclesRepondus) / cyclesSite : 0;

  return {
    id_equipement: equipement.id_equipement,
    nom: equipement.nom,
    adresse_ip: equipement.adresse_ip,
    periode_jours: jours,

    /* CE QUE LE CHIFFRE MESURE, dit par celui qui le calcule.
       Sans ce champ, l'interface applique un jugement de qualité — vert
       au-dessus de 99 %, rouge en dessous de 95 — à un poste de travail
       qui tourne autour de 40 % parce qu'on l'éteint le soir. Elle
       afficherait une catastrophe rouge sur un comportement normal.
       La règle vit ici, avec la donnée, et non recopiée dans l'écran. */
    nature: estPoste ? "presence" : "disponibilite",

    debut_effectif: new Date(debutEffectif).toISOString(),
    heures_observables: Math.round(heuresObservables * 10) / 10,

    /* Les deux chiffres bruts, pour que le taux soit vérifiable à la main
       plutôt qu'à croire sur parole. */
    cycles_observes: cyclesSite,
    cycles_repondus: cyclesRepondus,

    minutes_indisponible: Math.round(minutesObservables * partIndispo),
    nb_pannes: Number(equipement.nb_pannes || 0),

    taux_disponibilite: fiable && taux !== null ? Math.round(taux * 100) / 100 : null,
    taux_indicatif: taux !== null ? Math.round(taux * 100) / 100 : null,
    fiable,

    /* Part de la période réellement couverte par la supervision, déduite
       des cycles observés plutôt que supposée. */
    couverture_pourcent:
      minutesObservables > 0
        ? Math.round(Math.min(100, (cyclesSite / minutesObservables) * 1000)) / 10
        : 0,

    avertissements,
  };
}

/**
 * Nombre de pannes SIGNALÉES, par équipement.
 *
 * Reste fondé sur les alertes, et c'est volontaire : « combien de fois
 * a-t-on été prévenu » est une question différente de « combien de temps
 * la machine a-t-elle été absente ». Un type qui ne lève pas d'alerte —
 * un poste de travail — rend donc zéro, ce qui est exact.
 */
async function pannesSignalees(jours) {
  const [rows] = await db.query(
    `SELECT a.id_equipement, COUNT(*) AS pannes
       FROM ALERTE a
      WHERE a.type_alerte = 'equipement_down'
        AND a.id_equipement IS NOT NULL
        AND COALESCE(a.date_resolution, NOW()) >= NOW() - INTERVAL ? DAY
      GROUP BY a.id_equipement`,
    [jours]
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.id_equipement), Number(r.pannes || 0));
  return map;
}

/** Disponibilité d'un seul équipement. */
async function calculerDisponibilite(idEquipement, joursDemandes) {
  const jours = bornerJours(joursDemandes);

  const [rows] = await db.query(
    `SELECT e.id_equipement, e.nom, e.adresse_ip, e.id_site, e.date_ajout,
            t.libelle AS type_libelle
       FROM EQUIPEMENT e
       LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
      WHERE e.id_equipement = ?`,
    [idEquipement]
  );
  if (rows.length === 0) return null;

  const [agregats, pannes] = await Promise.all([
    chargerAgregats(jours),
    pannesSignalees(jours),
  ]);

  return composer({
    equipement: { ...rows[0], nb_pannes: pannes.get(Number(idEquipement)) || 0 },
    jours,
    agregats,
  });
}

/**
 * Disponibilité de plusieurs équipements — trois requêtes au total, quel
 * que soit le nombre d'équipements. Utilisée par les rapports PDF et Excel.
 */
async function calculerDisponibiliteLot(equipements, joursDemandes) {
  const jours = bornerJours(joursDemandes);
  if (!equipements || equipements.length === 0) return new Map();

  const [agregats, pannes] = await Promise.all([
    chargerAgregats(jours),
    pannesSignalees(jours),
  ]);

  const resultats = new Map();
  for (const eq of equipements) {
    resultats.set(
      Number(eq.id_equipement),
      composer({
        equipement: { ...eq, nb_pannes: pannes.get(Number(eq.id_equipement)) || 0 },
        jours,
        agregats,
      })
    );
  }
  return resultats;
}

/**
 * Couverture de collecte du parc entier, conservée pour les appelants qui
 * s'en servent seule. Déduite des mêmes agrégats.
 */
async function couvertureCollecte(joursDemandes) {
  const jours = bornerJours(joursDemandes);
  const agregats = await chargerAgregats(jours);

  let cycles = 0;
  for (const valeur of agregats.parSite.values()) cycles += valeur.cycles;

  const minutesAttendues = jours * 24 * 60;
  return {
    heuresObservees: Math.round(cycles / 60),
    heuresAttendues: jours * 24,
    taux: minutesAttendues > 0 ? Math.min(1, cycles / minutesAttendues) : 0,
  };
}

module.exports = {
  calculerDisponibilite,
  calculerDisponibiliteLot,
  couvertureCollecte,
  jourLocal,
  CYCLES_MIN_FIABLE,
  _viderCache: () => cacheAgregats.clear(),
};
