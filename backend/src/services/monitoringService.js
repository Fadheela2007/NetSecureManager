/**
 * monitoringService.js
 * Supervision continue des équipements déjà découverts : ping périodique,
 * relevé SNMP, génération d'alertes, notification, escalade en incident.
 *
 * Dépendances : npm install node-cron
 */

const cron = require("node-cron");
const ping = require("ping");
const db = require("../db");
const reglesAlerte = require("./reglesAlerteService");
const { planDuSite } = require("./planAdressageService");
const { notifierAlerte } = require("./notificationService");
const { snmpProbe, diagnosePanne, snmpMetrics } = require("./discoveryService");
const { passagePlanificateur } = require("./rapportPlanifieService");
const { diffuser } = require("./tempsReelService");
const {
  calculerDebitsEquipement,
  oublier: oublierTrafic,
  memoriserInterfaces,
} = require("./traficService");
const { purgerAdressesSansPreuve } = require("./inventaireService");
const { SEUIL_ALERTE_JOURS } = require("./certificatService");
const { purgerObservations } = require("./observationDnsDepot");

// Nombre d'équipements sondés simultanément. Chaque vérification peut durer
// plusieurs secondes (ping + SNMP + diagnostic de panne sur 5 ports) : sans
// borne, un parc de 200 équipements lance 200 vérifications à la fois et le
// cycle déborde sur la minute suivante (avertissements "missed execution").
const CONCURRENCE_SUPERVISION = 20;

// Empêche deux cycles de supervision de se chevaucher.
let cycleEnCours = false;
let escaladeEnCours = false;
let agentsEnCours = false;
let purgeEnCours = false;
// Horodatage de la dernière vérification, pour respecter intervalle_scan_minutes
let derniereVerification = 0;

// Purge : on supprime par tranches pour ne pas verrouiller RELEVE, qui est de
// loin la table la plus volumineuse (une ligne par équipement et par cycle).
const TAILLE_LOT_PURGE = 5000;
const MAX_LOTS_PAR_PASSAGE = 20; // plafond de 100 000 lignes par heure

/**
 * Compteurs de dépassement consécutif, par équipement et par métrique.
 * Clé : `${id_equipement}:${metrique}` -> nombre de relevés consécutifs au-dessus
 * du seuil de déclenchement.
 *
 * En mémoire plutôt qu'en base : ce sont des compteurs volatils, sans valeur
 * historique, et les écrire ajouterait une requête par équipement et par cycle.
 * Conséquence assumée : au redémarrage du backend, un équipement déjà en charge
 * doit à nouveau accumuler N relevés avant d'alerter. Sans gravité — les
 * alertes déjà créées, elles, sont bien en base.
 */
const depassements = new Map();

function compteurDepassement(idEquipement, metrique, auDessus) {
  const cle = `${idEquipement}:${metrique}`;
  if (!auDessus) {
    depassements.delete(cle);
    return 0;
  }
  const n = (depassements.get(cle) || 0) + 1;
  depassements.set(cle, n);
  return n;
}

async function getConfig(cle, defaut) {
  const [rows] = await db.query("SELECT valeur FROM CONFIGURATION WHERE cle = ?", [cle]);
  return rows[0] ? Number(rows[0].valeur) : defaut;
}

/**
 * Charge en UNE requête toute la configuration nécessaire à un cycle.
 *
 * Auparavant, getConfig() était appelée par équipement en échec : sur un parc
 * de 50 machines hors ligne, cela faisait 50 requêtes par minute pour lire la
 * même valeur. Avec les seuils de charge, on serait passé à 4 requêtes par
 * équipement. La configuration est donc lue une fois par cycle et transmise.
 */
async function chargerConfigCycle() {
  const [rows] = await db.query("SELECT cle, valeur FROM CONFIGURATION");
  const map = new Map(rows.map((r) => [r.cle, Number(r.valeur)]));
  const lire = (cle, defaut) => {
    const v = map.get(cle);
    return Number.isFinite(v) ? v : defaut;
  };

  return {
    seuilEchecs: lire("seuil_echecs_avant_alerte", 3),
    seuilCpu: lire("seuil_cpu_pourcent", 90),
    seuilRam: lire("seuil_ram_pourcent", 90),
    relevesAvantAlerte: lire("releves_consecutifs_avant_alerte_charge", 3),
    margeHysteresis: lire("marge_hysteresis_pourcent", 10),
  };
}

/**
 * Métriques surveillées. Le seuil de RÉSOLUTION est volontairement plus bas que
 * celui de DÉCLENCHEMENT (hystérésis) : voir l'explication dans creerAlerteCharge.
 */
const METRIQUES_CHARGE = [
  {
    cle: "cpu",
    champ: "cpuPercent",
    // Colonne correspondante dans RELEVE : sert à savoir si cette machine
    // a DÉJÀ été mesurée sous le seuil. Voir `estLePointNormal`.
    colonne: "cpu_pourcent",
    type: "cpu_eleve",
    libelle: "processeur",
    // Le code lu dans REGLE_ALERTE. Distinct de `type`, qui nomme
    // l'alerte produite : l'un règle, l'autre raconte.
    codeRegle: "cpu",
    seuilDe: (cfg) => cfg.seuilCpu,
  },
  {
    cle: "ram",
    champ: "ramPercent",
    colonne: "ram_pourcent",
    type: "ram_elevee",
    libelle: "mémoire vive",
    codeRegle: "memoire",
    seuilDe: (cfg) => cfg.seuilRam,
  },
];

/**
 * Évalue les seuils de charge à partir des métriques DÉJÀ collectées.
 *
 * Aucune interrogation SNMP supplémentaire : on travaille sur l'objet `metrics`
 * que checkEquipement vient d'obtenir. Le coût ajouté au cycle est nul en
 * dehors de l'insertion d'une alerte, qui est rare par construction.
 *
 * ANTI-CLIGNOTEMENT — deux protections cumulées :
 *
 *   1. N relevés consécutifs au-dessus du seuil avant de déclencher
 *      (même principe que echecs_consecutifs pour la disponibilité).
 *   2. HYSTÉRÉSIS : on déclenche à `seuil` mais on ne résout qu'en dessous de
 *      `seuil - marge`. Un processeur qui oscille entre 89 et 91 % ne produit
 *      donc ni alerte ni résolution en boucle. Sans cela, chaque oscillation
 *      autour du seuil créerait une alerte ET une notification.
 *
 * Une valeur NULL (équipement n'exposant pas HOST-RESOURCES-MIB, cas le plus
 * fréquent) n'est jamais évaluée : ni alerte, ni résolution, ni erreur.
 */
/**
 * Cette valeur haute est-elle le point de fonctionnement NORMAL de la machine ?
 *
 * LE CAS QUI A MOTIVÉ CETTE RÈGLE.
 *
 * Une imprimante HP déclare « Random Access Memory » : 356 Mo au total,
 * 337 Mo occupés — 94,5 %, relevé après relevé, à la décimale près. Elle
 * charge son micrologiciel et ses polices au démarrage et ne les libère
 * jamais. C'est son état normal depuis toujours et pour toujours.
 *
 * Le seuil à 90 % déclenchait donc une alerte permanente, que rien ne
 * pourra jamais résoudre. Sur un parc de dix imprimantes, c'est dix
 * lignes rouges définitives — et le jour où un vrai serveur sature, sa
 * ligne se perd au milieu.
 *
 * LA RÈGLE, ET POURQUOI ELLE EST GÉNÉRALE.
 *
 * Une alerte doit décrire un CHANGEMENT. Si une machine n'a jamais été
 * mesurée sous le seuil depuis qu'on l'observe, la valeur haute n'est pas
 * un événement : c'est sa définition. On ne l'annonce donc pas.
 *
 * Ce critère ne devine ni le type d'appareil ni son usage — il ne regarde
 * que l'historique de la mesure elle-même. Il vaut pour le processeur
 * comme pour la mémoire, sur une imprimante comme sur un serveur.
 *
 * CE QU'ON PERD, ET C'EST ASSUMÉ. Une machine qui serait à 95 % dès le
 * premier relevé et qui aurait réellement besoin d'attention ne
 * déclenchera rien. Nous n'avons aucune trace qu'elle ait été différente :
 * l'appeler incident serait une affirmation sans preuve. La valeur reste
 * lisible sur sa fiche et dans les graphiques.
 *
 * DÈS QU'ELLE DESCEND UNE FOIS, la machine sort de ce régime : une remontée
 * ultérieure est alors un vrai changement, et elle alerte normalement.
 */
async function estLePointNormal(idEquipement, colonne, seuil) {
  try {
    const [[r]] = await db.query(
      `SELECT COUNT(*) AS n FROM RELEVE
       WHERE id_equipement = ? AND ${colonne} IS NOT NULL AND ${colonne} < ?`,
      [idEquipement, seuil]
    );
    return Number(r.n) === 0;
  } catch (err) {
    // Un doute sur l'historique ne doit pas faire taire une alerte :
    // en cas d'échec, on garde le comportement d'avant.
    console.error("Historique de charge illisible:", err.message);
    return false;
  }
}

async function evaluerSeuilsCharge(equipement, metrics, cfg) {
  if (!metrics) return;

  for (const m of METRIQUES_CHARGE) {
    const valeur = metrics[m.champ];

    // Garde-fou NULL : la majorité des équipements ne remontent pas ces
    // métriques. On remet le compteur à zéro pour ne pas cumuler des
    // dépassements séparés par des trous de mesure.
    if (valeur === null || valeur === undefined || !Number.isFinite(Number(valeur))) {
      depassements.delete(`${equipement.id_equipement}:${m.cle}`);
      continue;
    }

    const v = Number(valeur);

    /* ── LE RÉGLAGE DE L'ÉCRAN PASSE AVANT LA CONFIGURATION ──
       `seuil_cpu_pourcent` et consorts restent le repli : une base sans
       la table de règles se comporte exactement comme avant. */
    const regle = await reglesAlerte.regle(m.codeRegle, "tous");
    if (!regle.active) {
      depassements.delete(`${equipement.id_equipement}:${m.cle}`);
      continue;
    }

    const seuil = Number.isFinite(regle.seuil) && regle.seuil !== null
      ? regle.seuil
      : m.seuilDe(cfg);
    const relevesRequis =
      Number.isFinite(regle.releves_requis) && regle.releves_requis
        ? regle.releves_requis
        : cfg.relevesAvantAlerte;
    const seuilResolution = Math.max(0, seuil - cfg.margeHysteresis);

    if (v >= seuil) {
      const n = compteurDepassement(equipement.id_equipement, m.cle, true);
      if (n === relevesRequis) {
        // Strictement égal : on n'alerte qu'au relevé qui franchit le compte,
        // pas à chaque relevé suivant.
        if (await estLePointNormal(equipement.id_equipement, m.colonne, seuil)) {
          console.log(
            `Supervision — ${equipement.adresse_ip} : ${m.libelle} à ${v.toFixed(1)} % ` +
              `n'est jamais descendue sous ${seuil} % ; état normal de la machine, pas d'alerte.`
          );
        } else {
          await creerAlerteCharge(equipement, m, v, seuil, n, regle.niveau);
        }
      }
    } else if (v < seuilResolution) {
      compteurDepassement(equipement.id_equipement, m.cle, false);
      await resoudreAlertes(equipement.id_equipement, m.type);
    }
    // Entre seuilResolution et seuil : zone morte de l'hystérésis.
    // On ne fait rien — ni alerte, ni résolution.
  }
}

async function creerAlerteCharge(equipement, metrique, valeur, seuil, nbReleves, niveau = "warning") {
  // Le dédoublonnage est assuré par creerAlerte() : on ne fait plus de
  // contrôle d'existence ici, sinon le compteur d'occurrences ne
  // s'incrémenterait jamais pour les alertes de charge.
  const nom = equipement.nom || equipement.adresse_ip;
  await creerAlerte(
    equipement,
    metrique.type,
    /* 'warning' reste le DÉFAUT, et pour une bonne raison : une charge
       élevée n'est pas une panne, l'équipement répond. Réserver
       'critical' à l'indisponibilité garde au niveau sa valeur de signal
       — si tout est critique, plus rien ne l'est. L'exploitant peut en
       décider autrement depuis l'écran des règles ; c'est son parc. */
    niveau,
    `Charge ${metrique.libelle} élevée sur ${nom} : ${valeur.toFixed(0)} % ` +
      `(seuil ${seuil} %) sur ${nbReleves} relevés consécutifs.`,
    metrique.type
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   CE QUI COMPTE COMME « ELLE EST LÀ ».

   Ces trois codes viennent de `diagnosePanne`. Ils ne se valent pas en
   confort — un port ouvert est plus parlant qu'une réponse ARP — mais ils
   se valent en VÉRITÉ : dans les trois cas, quelque chose a répondu à
   cette adresse pendant que nous regardions.

     • `pare_feu_probable` — un port TCP est ouvert ;
     • `refus_tcp`         — aucun port ouvert, mais la machine refuse
                             franchement la connexion : une pile réseau
                             vivante est derrière ;
     • `voisinage_arp`     — elle ne répond à rien au-dessus d'IP, mais
                             elle répond en ARP sur le segment local, ce
                             qu'aucun pare-feu Windows ne filtre.

   POURQUOI CETTE LISTE EST ÉCRITE ICI PLUTÔT QU'EN DUR DANS LE TEST.

   La version précédente comparait à la seule valeur `pare_feu_probable`.
   Les deux autres preuves existaient déjà dans le balayage — une machine
   entrait à l'inventaire en « up » sur un refus TCP — mais la supervision
   les ignorait et la repassait en « inconnu » au bout de trois cycles.
   La plateforme se contredisait elle-même à quelques minutes
   d'intervalle, et c'est ce qui vidait l'écran après chaque scan.

   Toute preuve future s'ajoute désormais à cette liste, à un seul
   endroit, et les deux chemins l'appliquent ensemble.
   ═══════════════════════════════════════════════════════════════════════ */
const PREUVES_DE_VIE = ["pare_feu_probable", "refus_tcp", "voisinage_arp"];

/** Ce que le cycle a dû prouver autrement que par le ping. Remis à zéro
 *  et résumé en une ligne à la fin de chaque cycle — voir cycleSupervision. */
const compteurPreuves = { pare_feu_probable: 0, refus_tcp: 0, voisinage_arp: 0 };

/* ═══════════════════════════════════════════════════════════════════════
   QUI A LE DROIT DE DÉCLENCHER UNE ALERTE EN DISPARAISSANT.

   Ces types-là doivent rester allumés : leur silence est un incident.
   Un poste de travail, non — il s'éteint le soir, pendant les congés, et
   quand son utilisateur part en réunion.

   « inconnu » ne figure pas dans la liste, et c'est cohérent avec le
   reste de la plateforme : on n'affirme pas une panne sur une machine
   dont on ne sait même pas ce qu'elle est. Elle reste visible hors
   ligne, et la case de sa fiche permet de trancher à la main.
   ═══════════════════════════════════════════════════════════════════════ */
const TYPES_TOUJOURS_ALLUMES = new Set([
  "serveur",
  "imprimante",
  "routeur",
  "routeur/switch",
  "pare-feu",
  "camera",
  "telephonie",
]);

/** L'avertissement de colonne absente ne part qu'une fois. */
let colonneSurveillanceSignalee = false;

/**
 * Vrai si la disparition de cette machine mérite une alerte.
 *
 * LE CHOIX EXPLICITE PRIME SUR LE TYPE. `surveillance_permanente` vaut
 * NULL tant que personne n'a rien dit — on suit alors le type. Mise à 1
 * ou à 0, elle tranche, y compris contre le type : un poste qui pilote
 * une machine de production doit alerter, un vieux serveur d'essai non.
 *
 * NE LÈVE JAMAIS. Une base sans la colonne du 25/09 retombe sur le type
 * seul, et le dit une fois. Le pire serait qu'une question de confort
 * d'affichage casse la supervision elle-même.
 */
async function doitAlerterSiHorsLigne(equipement) {
  const parLeType = (libelle) =>
    TYPES_TOUJOURS_ALLUMES.has(String(libelle || "inconnu").toLowerCase());

  try {
    const [[ligne]] = await db.query(
      `SELECT e.surveillance_permanente AS choix,
              COALESCE(t.libelle, 'inconnu') AS type_libelle
         FROM EQUIPEMENT e
         LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
        WHERE e.id_equipement = ?`,
      [equipement.id_equipement]
    );
    if (!ligne) return false;

    /* LA RÈGLE DE L'ÉCRAN « ALERTES » DÉCIDE, et l'exception portée par
       la machine la surcharge. Le service de règles retombe de lui-même
       sur le comportement d'origine si la table manque : rien ici n'a
       besoin de le savoir. */
    const decision = await reglesAlerte.alerteHorsLigne(ligne.type_libelle, ligne.choix);
    return decision.active;
  } catch (err) {
    if (!colonneManquante(err)) throw err;

    if (!colonneSurveillanceSignalee) {
      colonneSurveillanceSignalee = true;
      console.warn(
        "\n⚠  EQUIPEMENT.surveillance_permanente est absente de la base.\n" +
          "   Les alertes hors ligne suivent le type seul ; le réglage par\n" +
          "   machine est sans effet. Pour l'activer :\n" +
          "   backend/migrations/2026-09-25-surveillance-permanente.sql\n"
      );
    }

    const [[ligne]] = await db.query(
      `SELECT COALESCE(t.libelle, 'inconnu') AS type_libelle
         FROM EQUIPEMENT e
         LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
        WHERE e.id_equipement = ?`,
      [equipement.id_equipement]
    );
    return parLeType(ligne?.type_libelle);
  }
}

/** La gravité à donner à « ne répond plus », selon la règle de son type. */
async function niveauHorsLigne(equipement) {
  try {
    const [[ligne]] = await db.query(
      `SELECT COALESCE(t.libelle, 'inconnu') AS type_libelle
         FROM EQUIPEMENT e
         LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
        WHERE e.id_equipement = ?`,
      [equipement.id_equipement]
    );
    const r = await reglesAlerte.regle(
      "equipement_down",
      String(ligne?.type_libelle || "inconnu").toLowerCase()
    );
    return r.niveau || "critical";
  } catch {
    // Une gravité par défaut vaut mieux qu'une alerte qui n'existe pas.
    return "critical";
  }
}

/**
 * Sème dans traficService les interfaces à écarter du total, lues dans
 * INTERFACE_RESEAU.
 *
 * Mémorisé une heure par équipement : un nom d'interface ne change qu'à
 * une mise à jour de micrologiciel. Sans ce cache, on ajouterait une
 * requête par équipement et par minute — exactement le genre de coût
 * qu'on vient de retirer ailleurs.
 *
 * NE LÈVE JAMAIS. Si la lecture échoue, on repart sur ce que traficService
 * sait déjà : au pire le comportement d'avant la correction, jamais une
 * supervision interrompue.
 */
const SEMIS_TTL_MS = 60 * 60 * 1000;
const MAX_SEMIS_SUIVIS = 10000;
const dernierSemis = new Map(); // id_equipement -> horodatage

async function semerInterfacesIgnorees(idEquipement) {
  const maintenant = Date.now();
  const precedent = dernierSemis.get(idEquipement);
  if (precedent && maintenant - precedent < SEMIS_TTL_MS) return;

  // Plafond : un parc ne dépasse pas ce nombre, mais une carte sans borne
  // sur un processus qui tourne des mois finit toujours par coûter.
  if (dernierSemis.size >= MAX_SEMIS_SUIVIS) dernierSemis.clear();
  dernierSemis.set(idEquipement, maintenant);

  try {
    const [rows] = await db.query(
      "SELECT index_snmp, nom FROM INTERFACE_RESEAU WHERE id_equipement = ? AND nom IS NOT NULL",
      [idEquipement]
    );
    if (rows.length > 0) memoriserInterfaces(idEquipement, rows);
  } catch {
    /* Table ou colonne absente : rien à semer, la supervision continue. */
  }
}

async function checkEquipement(equipement, cfg) {
  const res = await ping.promise.probe(equipement.adresse_ip, { timeout: 2 });

  if (res.alive) {
    /* TOUT CE QUI N'EST PAS DÉJÀ « up » DOIT Y REVENIR.

       Le test portait sur `=== "down"`. Il couvrait les deux seuls états
       que ce cycle produisait alors. Depuis qu'un équipement sans preuve
       de vie est marqué « inconnu » (voir plus bas), un troisième état
       circule ici — et une machine « inconnu » qui se met à répondre
       n'entrait dans aucune des deux branches utiles : ses échecs étaient
       remis à zéro, mais son statut restait « inconnu » POUR TOUJOURS.

       Elle répondait au ping à chaque cycle, produisait des relevés, et
       l'interface continuait d'annoncer qu'on ne savait rien d'elle. */
    if (equipement.statut !== "up") {
      await db.query("UPDATE EQUIPEMENT SET statut = 'up', echecs_consecutifs = 0 WHERE id_equipement = ?", [equipement.id_equipement]);
      await resoudreAlertes(equipement.id_equipement, "equipement_down");

      // Le retour en ligne est diffusé au même titre que la panne : une
      // interface qui n'apprend que les mauvaises nouvelles laisse un
      // bandeau rouge affiché sur un problème déjà résolu. Vaut aussi
      // pour un « inconnu » qui se manifeste : c'est une bonne nouvelle,
      // et elle doit remonter à l'écran sans rechargement.
      diffuser(equipement.id_site ?? null, "equipement", {
        id_equipement: equipement.id_equipement,
        statut: "up",
      });
    } else {
      await db.query("UPDATE EQUIPEMENT SET echecs_consecutifs = 0 WHERE id_equipement = ?", [equipement.id_equipement]);
    }

    const snmpData = await snmpProbe(equipement.adresse_ip);
    if (snmpData) {
      const metrics = await snmpMetrics(equipement.adresse_ip);

      /* ── LES NOMS D'INTERFACE VIENNENT DE LA BASE, PAS DU RÉSEAU ──

         `snmpMetrics` sans inventaire ne lit pas `ifDescr` : ses interfaces
         n'ont pas de nom, et la boucle locale entrait donc dans le total —
         jusqu'à quatre-vingt-seize fois le débit réel sur une imprimante.

         Demander l'inventaire à chaque cycle corrigerait le chiffre au prix
         de cinq colonnes SNMP de plus par équipement et par minute. Inutile :
         le scan a déjà écrit ces noms dans INTERFACE_RESEAU, et ils ne
         changent pas. On les sème depuis la base, une fois par heure et par
         équipement, et `traficService` s'en souvient pour tous les cycles
         suivants. Aucun paquet SNMP supplémentaire. */
      await semerInterfacesIgnorees(equipement.id_equipement);

      // Débit calculé sur TOUTES les interfaces, plus le total de
      // l'équipement. Auparavant seule `interfaces[0]` était mesurée : la
      // consommation d'un switch 24 ports était celle de son port 1.
      const debits = calculerDebitsEquipement(
        equipement.id_equipement,
        metrics.interfaces || []
      );

      await db.query(
        `INSERT INTO RELEVE (id_equipement, latence_ms, cpu_pourcent, ram_pourcent, trafic_entrant_kbps, trafic_sortant_kbps)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          equipement.id_equipement,
          res.time,
          metrics.cpuPercent,
          metrics.ramPercent,
          debits.total.entrant,
          debits.total.sortant,
        ]
      );

      // Débit courant par interface : pas d'historique par port, qui ferait
      // exploser le volume (24 ports × 1 relevé/min = 34 000 lignes par
      // jour et par switch). L'historique reste au niveau de l'équipement,
      // le détail par port donne l'instantané — ce qui suffit à repérer le
      // port saturé d'un commutateur.
      await enregistrerDebitsInterfaces(equipement.id_equipement, debits.parInterface);

      // Évaluation des seuils sur les métriques déjà en mémoire :
      // aucune interrogation SNMP ni lecture de configuration supplémentaire.
      await evaluerSeuilsCharge(equipement, metrics, cfg);
    } else {
      await db.query(`INSERT INTO RELEVE (id_equipement, latence_ms) VALUES (?, ?)`, [equipement.id_equipement, res.time]);
    }
    return;
  }

  // Échec du ping : on incrémente le compteur avant de conclure quoi que ce soit
  const echecs = (equipement.echecs_consecutifs || 0) + 1;

  // L'équipement ne répond plus : ses compteurs de charge n'ont plus de sens.
  // On les remet à zéro pour qu'un retour en ligne reparte d'un état propre.
  for (const m of METRIQUES_CHARGE) {
    depassements.delete(`${equipement.id_equipement}:${m.cle}`);
  }
  // Idem pour les compteurs de trafic : au retour, le premier relevé ne
  // doit pas produire un pic calculé sur des heures d'écart.
  oublierTrafic(equipement.id_equipement);

  const seuilEchecs = cfg.seuilEchecs;
  if (echecs >= seuilEchecs) {
    // ── LA PREUVE CONTRAIRE EST CHERCHÉE AVANT D'ALERTER ──
    //
    // LE DÉFAUT CORRIGÉ, ET IL ÉTAIT GRAVE.
    //
    // `diagnosePanne` teste les ports TCP courants. Quand l'un répond, il
    // conclut « ne répond plus au ping, mais le port 80 reste actif —
    // probablement un pare-feu qui bloque le ping ». Autrement dit : la
    // machine FONCTIONNE.
    //
    // Ce diagnostic était écrit dans le message… et l'alerte critique
    // partait quand même, l'équipement passait « hors ligne ». On envoyait
    // donc quelqu'un vérifier une machine qui marche.
    //
    // Or un poste Windows bloque le ping par défaut, et les machines
    // découvertes par la table ARP n'ont, par construction, jamais répondu
    // au ping. Sur un parc bureautique, c'est le cas le plus fréquent.
    //
    // Un outil de supervision qui invente des pannes est pire qu'aucun
    // outil : au bout de deux semaines, plus personne ne lit ses alertes.
    const diagnostic = await diagnosePanne(equipement.adresse_ip);

    if (PREUVES_DE_VIE.includes(diagnostic.code)) {
      compteurPreuves[diagnostic.code]++;

      // La machine a répondu à quelque chose : elle est en ligne. Ne pas
      // répondre au ping est une propriété de la machine, pas une panne.
      await db.query(
        "UPDATE EQUIPEMENT SET statut = 'up', echecs_consecutifs = 0 WHERE id_equipement = ?",
        [equipement.id_equipement]
      );

      /* LA PREUVE EST ÉCRITE, ET DATÉE.
         La fiche disait « en ligne » sans dire sur quoi la supervision se
         fondait — or c'est précisément la question qu'on pose quand on ne
         croit pas un écran. Le balayage enregistrait déjà sa preuve ; la
         supervision, qui parle plus souvent que lui, ne disait rien.
         Colonnes ajoutées le 09/09 : sur une base plus ancienne, ce
         complément d'information s'abstient, il n'interrompt rien. */
      await db
        .query(
          `UPDATE EQUIPEMENT SET preuve_existence = ?, preuve_detail = ?, date_preuve = NOW()
           WHERE id_equipement = ?`,
          [diagnostic.code, diagnostic.detail.slice(0, 255), equipement.id_equipement]
        )
        .catch(() => {});

      // Une alerte ouverte par une version précédente doit se refermer.
      await resoudreAlertes(equipement.id_equipement, "equipement_down");

      /* Le test portait sur `=== "down"`. Il laissait donc l'écran sur
         « inconnu » pour toutes les machines que ce nouveau barème vient
         de rendre à l'état « up » — c'est-à-dire exactement celles que ce
         correctif concerne. */
      if (equipement.statut !== "up") {
        diffuser(equipement.id_site ?? null, "equipement", {
          id_equipement: equipement.id_equipement,
          statut: "up",
        });
      }
      // Le compteur repart de zéro : la vérification TCP ne sera refaite
      // qu'après `seuilEchecs` cycles, soit trois minutes par défaut, et
      // non à chaque minute.
      return;
    }

    /* ═══════════════════════════════════════════════════════════════
       ON N'ANNONCE PAS QU'UNE MACHINE « NE RÉPOND PLUS »
       QUAND ELLE N'A JAMAIS RÉPONDU.

       LE DÉFAUT, CONSTATÉ EN CONDITIONS RÉELLES.

       Le balayage complète le ping par la lecture de la table ARP du
       poste, pour rattraper les machines qui bloquent l'ICMP. L'idée est
       juste — un poste Windows ne répond pas au ping par défaut.

       Mais cette table garde en mémoire les machines vues RÉCEMMENT,
       plusieurs minutes après leur départ. Sur un parc Wi-Fi, elle est
       pleine de portables et de téléphones déjà partis. Le scan les
       enregistre « en ligne » sans qu'ils aient jamais répondu, puis la
       supervision les déclare hors ligne trois cycles plus tard.

       Mesuré sur un parc de 47 machines : 13 alertes critiques, dont
       11 pour des appareils n'ayant jamais émis le moindre signe de vie.
       C'est ce qui saturait le tableau de bord après chaque scan.

       LE CRITÈRE RETENU, ET POURQUOI CELUI-LÀ.

       Un relevé n'est écrit que lorsque le ping aboutit. Zéro relevé
       signifie donc, sans ambiguïté : cette machine n'a jamais répondu
       depuis sa découverte. Ajouté au fait que `diagnosePanne` vient de
       ne trouver aucun port TCP ouvert, il ne reste AUCUNE preuve
       qu'elle existe.

       On la marque alors « inconnu » — l'ENUM le prévoit — et non
       « down ». La nuance n'est pas cosmétique : « down » affirme une
       panne constatée, « inconnu » dit qu'on n'a rien pu observer. Une
       alerte critique sur une machine qu'on n'a jamais vue serait une
       affirmation sans preuve, et c'est exactement ce qui apprend aux
       exploitants à ignorer les alertes.

       CE QUI N'EST PAS PERDU. Si la machine se manifeste un jour — elle
       répond au ping, ou un port s'ouvre — elle repasse « up » par le
       chemin normal, et sa disparition ultérieure déclenchera bien une
       alerte. Le silence n'est ignoré que tant qu'il est TOTAL depuis
       l'origine.
       ═══════════════════════════════════════════════════════════════ */
    /* `SELECT 1 … LIMIT 1` et non `COUNT(*)` : la question est binaire —
       « existe-t-il au moins un relevé ? ». Un COUNT parcourt TOUTES les
       entrées d'index de la machine, soit environ 43 000 après trente
       jours de rétention, et il tourne à chaque cycle pour chaque machine
       hors ligne. Sur un parc où deux cents postes sont éteints la nuit,
       cela faisait plusieurs millions d'entrées parcourues par minute
       pour répondre oui ou non. */
    const [[preuve]] = await db.query(
      "SELECT 1 AS n FROM RELEVE WHERE id_equipement = ? LIMIT 1",
      [equipement.id_equipement]
    );

    /* `LIMIT 1` ne renvoie AUCUNE ligne quand il n'y a pas de relevé —
       là où `COUNT(*)` en renvoyait toujours une, avec zéro. Le test porte
       donc sur l'absence de ligne, pas sur la valeur. */
    if (!preuve) {
      if (equipement.statut !== "inconnu") {
        console.log(
          `Supervision — ${equipement.adresse_ip} n'a jamais répondu depuis sa ` +
            `découverte (table ARP) : marqué « inconnu », sans alerte.`
        );
      }
      await db.query(
        "UPDATE EQUIPEMENT SET statut = 'inconnu', echecs_consecutifs = ? WHERE id_equipement = ?",
        [echecs, equipement.id_equipement]
      );
      // Une alerte ouverte par une version précédente doit se refermer :
      // elle affirmait une panne qu'on ne peut pas constater.
      await resoudreAlertes(equipement.id_equipement, "equipement_down");
      diffuser(equipement.id_site ?? null, "equipement", {
        id_equipement: equipement.id_equipement,
        statut: "inconnu",
      });
      return;
    }

    /* ── UN POSTE ÉTEINT N'EST PAS UNE PANNE ──

       Le changement d'état est enregistré dans tous les cas : la fiche et
       les listes montrent bien la machine hors ligne. Ce qui dépend du
       rôle, c'est l'ALERTE — c'est-à-dire le fait de réveiller quelqu'un.

       Un employé qui éteint son poste le soir produisait jusqu'ici une
       alerte critique. Multiplié par le parc, cela apprenait à
       l'exploitant que le rouge ne veut rien dire, et noyait la seule
       alerte qui comptait. */
    const alerter = await doitAlerterSiHorsLigne(equipement);

    if (equipement.statut !== "down") {
      if (alerter) {
        /* LA GRAVITÉ VIENT DE LA RÈGLE. Une imprimante éteinte et un
           serveur tombé n'ont pas la même urgence, et c'est l'exploitant
           qui doit pouvoir le dire — pas le code. */
        const niveau = await niveauHorsLigne(equipement);
        await creerAlerte(
          equipement, "equipement_down", niveau,
          `L'équipement ${equipement.nom || equipement.adresse_ip} ne répond plus. ${diagnostic.detail}`,
          diagnostic.code
        );
      } else {
        console.log(
          `Supervision — ${equipement.adresse_ip} est hors ligne : poste de ` +
            "travail, aucune alerte (« surveiller en permanence » sur sa fiche " +
            "pour en créer une)."
        );
      }
    }

    /* Une alerte ouverte AVANT ce changement de règle, ou avant qu'on
       décoche « surveiller en permanence », affirme une panne que la
       plateforme ne considère plus comme telle. On la clôture au lieu de
       la laisser vivre sa vie. */
    if (!alerter) {
      await resoudreAlertes(equipement.id_equipement, "equipement_down");
    }
    await db.query("UPDATE EQUIPEMENT SET statut = 'down', echecs_consecutifs = ? WHERE id_equipement = ?", [echecs, equipement.id_equipement]);
    diffuser(equipement.id_site ?? null, "equipement", {
      id_equipement: equipement.id_equipement,
      statut: "down",
    });
  } else {
    await db.query("UPDATE EQUIPEMENT SET echecs_consecutifs = ? WHERE id_equipement = ?", [echecs, equipement.id_equipement]);
  }
}

/**
 * Crée une alerte, ou incrémente celle qui existe déjà pour le même
 * problème.
 *
 * Le dédoublonnage est placé ici et non chez les appelants : un problème
 * persistant produisait une alerte par cycle, parce que chaque scan remet
 * le statut à `up` et réarme ainsi la transition vers `down` que surveille
 * `checkEquipement`. Aucun appelant ne peut contourner ce point unique.
 *
 * « Même problème » : même équipement, même type, non résolu. Une alerte
 * acquittée compte aussi — l'opérateur a dit qu'il s'en occupait, le
 * problème qui persiste ne doit pas ressortir du silence. Seule la
 * première occurrence notifie, pour éviter une rafale de courriels sur
 * une panne qui dure.
 */

/**
 * Les colonnes `occurrences`, `premiere_detection` et `derniere_occurrence`
 * viennent de la migration 2026-08-18-alertes-acquittement.sql. Absentes,
 * MySQL renvoie ER_BAD_FIELD_ERROR (1054), et l'erreur remontait jusqu'à
 * checkEquipement en interrompant la supervision de l'équipement. Le
 * service repasse donc en « une alerte par détection » : bruyant, correct.
 *
 * Le diagnostic n'est journalisé qu'une fois, sinon il noie la console.
 *
 *   null = pas encore testé · true = dédoublonnage actif · false = dégradé
 */
let dedoublonnageDisponible = null;

function colonneManquante(err) {
  return err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054);
}

function signalerModeDegrade() {
  if (dedoublonnageDisponible === false) return;
  dedoublonnageDisponible = false;
  console.warn(
    "\n⚠  Dédoublonnage des alertes DÉSACTIVÉ : les colonnes occurrences / " +
      "premiere_detection / derniere_occurrence sont absentes de la table ALERTE.\n" +
      "   La supervision continue normalement, mais un problème persistant " +
      "recréera une alerte à chaque cycle.\n" +
      "   Pour le réactiver, exécuter la migration :\n" +
      "   backend/migrations/2026-08-18-alertes-acquittement.sql\n"
  );
}

async function creerAlerte(equipement, type, niveau, message, causeCode = null) {
  if (dedoublonnageDisponible !== false) {
    try {
      const [existantes] = await db.query(
        `SELECT id_alerte, occurrences FROM ALERTE
         WHERE id_equipement = ? AND type_alerte = ? AND statut <> 'resolue'
         ORDER BY date_creation DESC LIMIT 1`,
        [equipement.id_equipement, type]
      );
      dedoublonnageDisponible = true;

      if (existantes.length > 0) {
        const existante = existantes[0];
        // Le message est rafraîchi : le diagnostic peut avoir évolué
        // (« pare-feu probable » devenu « injoignable total »). La date de
        // première détection, elle, ne bouge jamais.
        await db.query(
          `UPDATE ALERTE
           SET occurrences = occurrences + 1,
               derniere_occurrence = NOW(),
               message = ?,
               cause_code = COALESCE(?, cause_code),
               niveau = ?
           WHERE id_alerte = ?`,
          [message, causeCode, niveau, existante.id_alerte]
        );
        return existante.id_alerte;
      }
    } catch (err) {
      if (!colonneManquante(err)) throw err;
      signalerModeDegrade();
    }
  }

  const [result] = await (dedoublonnageDisponible === false
    ? // Mode dégradé : l'insertion se limite aux colonnes historiques.
      db.query(
        `INSERT INTO ALERTE (id_equipement, type_alerte, niveau, message, statut, cause_code)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        [equipement.id_equipement, type, niveau, message, causeCode]
      )
    : db
        .query(
          `INSERT INTO ALERTE (id_equipement, type_alerte, niveau, message, statut, cause_code,
                               occurrences, premiere_detection, derniere_occurrence)
           VALUES (?, ?, ?, ?, 'active', ?, 1, NOW(), NOW())`,
          [equipement.id_equipement, type, niveau, message, causeCode]
        )
        .catch((err) => {
          // Filet de sécurité : le SELECT a pu passer (la colonne
          // occurrences existe) alors qu'une des deux colonnes de date
          // manque — migration partiellement appliquée.
          if (!colonneManquante(err)) throw err;
          signalerModeDegrade();
          return db.query(
            `INSERT INTO ALERTE (id_equipement, type_alerte, niveau, message, statut, cause_code)
             VALUES (?, ?, ?, ?, 'active', ?)`,
            [equipement.id_equipement, type, niveau, message, causeCode]
          );
        }));

  // Notifications volontairement NON attendues : l'alerte est déjà en base et
  // visible dans l'interface. Attendre le SMTP ici faisait déborder le cycle
  // cron d'une minute dès que le serveur mail était lent ou en échec.
  notifierAlerte(equipement, message, result.insertId).catch(() => {});

  // Prévient les interfaces ouvertes qu'il y a du neuf. L'événement ne
  // porte aucune donnée : chaque interface va la rechercher par les
  // routes normales, qui appliquent déjà le cloisonnement et les rôles.
  diffuser(equipement.id_site ?? null, "alerte", {
    id_equipement: equipement.id_equipement,
    type_alerte: type,
    niveau,
  });

  return result.insertId;
}

/**
 * Met à jour le débit courant de chaque interface.
 *
 * N'insère jamais de ligne : si l'interface n'a pas encore été inventoriée
 * (l'inventaire est collecté lors des scans, pas à chaque cycle), la mise
 * à jour ne touche rien et c'est très bien ainsi. Le débit apparaîtra au
 * prochain scan, une fois l'interface connue.
 */
async function enregistrerDebitsInterfaces(idEquipement, parInterface) {
  if (!Array.isArray(parInterface) || parInterface.length === 0) return 0;

  let maj = 0;
  for (const i of parInterface) {
    if (i.trafic_entrant_kbps === null && i.trafic_sortant_kbps === null) continue;
    try {
      const [r] = await db.query(
        `UPDATE INTERFACE_RESEAU
         SET trafic_entrant_kbps = ?, trafic_sortant_kbps = ?, date_trafic = NOW()
         WHERE id_equipement = ? AND index_snmp = ?`,
        [i.trafic_entrant_kbps, i.trafic_sortant_kbps, idEquipement, i.index_snmp]
      );
      maj += r.affectedRows;
    } catch (err) {
      // Colonnes absentes tant que la migration n'est pas passée : on
      // n'échoue pas, le reste du cycle doit continuer.
      console.error(`Débit interface ${i.index_snmp} non enregistré:`, err.message);
      return maj;
    }
  }
  return maj;
}

async function resoudreAlertes(idEquipement, type) {
  await db.query(
    `UPDATE ALERTE SET statut = 'resolue', date_resolution = NOW()
     WHERE id_equipement = ? AND type_alerte = ? AND statut IN ('active', 'traitee')`,
    [idEquipement, type]
  );
}

/**
 * Alerte rattachée à un SITE et non à un équipement (id_equipement NULL).
 * Utilisée pour les pannes d'agent : le problème ne concerne aucune machine
 * en particulier, mais la remontée d'informations du site entier.
 */
async function creerAlerteSite(site, type, niveau, message, causeCode = null) {
  // Même dédoublonnage que creerAlerte, sur le couple (site, type).
  const [existantes] = await db.query(
    `SELECT id_alerte FROM ALERTE
     WHERE id_site = ? AND type_alerte = ? AND statut <> 'resolue'
     ORDER BY date_creation DESC LIMIT 1`,
    [site.id_site, type]
  );
  if (existantes.length > 0) {
    await db.query(
      `UPDATE ALERTE SET occurrences = occurrences + 1, derniere_occurrence = NOW(), message = ?
       WHERE id_alerte = ?`,
      [message, existantes[0].id_alerte]
    );
    return existantes[0].id_alerte;
  }

  const [result] = await db.query(
    `INSERT INTO ALERTE (id_equipement, id_site, type_alerte, niveau, message, statut, cause_code,
                         occurrences, premiere_detection, derniere_occurrence)
     VALUES (NULL, ?, ?, ?, ?, 'active', ?, 1, NOW(), NOW())`,
    [site.id_site, type, niveau, message, causeCode]
  );

  // Même principe que creerAlerte : notification non attendue.
  notifierAlerte({ id_site: site.id_site, nom: site.nom }, message, result.insertId).catch(() => {});

  return result.insertId;
}

/**
 * Détecte les agents distants qui ont cessé de transmettre.
 *
 * DISTINCTION AGENT / SITE MANUEL — choix expliqué dans le rapport :
 * on ne surveille que les sites dont `dernier_push` n'est PAS NULL, c'est-à-dire
 * ceux qui ont déjà transmis au moins une fois. Un site scanné manuellement
 * depuis l'interface ne pousse jamais, sa colonne reste NULL, il ne peut donc
 * pas déclencher d'alerte. Aucun drapeau à cocher, aucune configuration :
 * le premier push d'un agent suffit à l'inscrire à la surveillance.
 */
async function verifierAgents() {
  /* Le seuil et la gravité viennent de la règle « agent muet » de l'écran
     Alertes ; `seuil_agent_muet_minutes` reste le repli pour une base qui
     n'a pas encore la table des règles. */
  const regleAgent = await reglesAlerte.regle("agent_muet", "tous");
  const seuilMinutes =
    regleAgent.seuil && Number.isFinite(regleAgent.seuil)
      ? regleAgent.seuil
      : await getConfig("seuil_agent_muet_minutes", 30);

  // Règle éteinte : on ne surveille plus le silence des agents. C'est un
  // choix discutable, donc il appartient à l'exploitant, pas au code.
  if (!regleAgent.active) return;

  // Même colonne, même repli : sans elle, aucun agent muet ne peut être
  // détecté — mais ce n'est pas une raison pour faire échouer le cycle.
  let muets = [];
  try {
    [muets] = await db.query(
    `SELECT id_site, nom, ville, dernier_push,
            TIMESTAMPDIFF(MINUTE, dernier_push, NOW()) AS minutes_silence
     FROM SITE
     WHERE dernier_push IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, dernier_push, NOW()) >= ?`,
      [seuilMinutes]
    );
  } catch (err) {
    if (!colonneManquante(err)) throw err;
    return; // colonne absente : rien à surveiller, signalé ailleurs
  }

  for (const site of muets) {
    // Une seule alerte active par site : on ne réalerte pas à chaque passage.
    const [existantes] = await db.query(
      `SELECT id_alerte FROM ALERTE
       WHERE id_site = ? AND type_alerte = 'agent_muet' AND statut = 'active'`,
      [site.id_site]
    );
    if (existantes.length > 0) continue;

    const heures = Math.floor(site.minutes_silence / 60);
    const duree = heures >= 1 ? `${heures} h` : `${site.minutes_silence} min`;

    await creerAlerteSite(
      site,
      "agent_muet",
      regleAgent.niveau || "critical",
      `L'agent du site « ${site.nom} » (${site.ville}) n'a rien transmis depuis ${duree}. ` +
        `L'état des équipements de ce site n'est plus observable : ils sont passés en « inconnu ».`,
      "agent_muet"
    );

    // Le site n'est plus observé : on ne peut affirmer ni « up » ni « down ».
    // L'ENUM prévoit déjà `inconnu` — c'est exactement ce cas. Les laisser à
    // `up` afficherait un parc en bonne santé qui n'est peut-être plus là ;
    // les passer à `down` inventerait une panne qu'on n'a pas constatée.
    await db.query(
      `UPDATE EQUIPEMENT SET statut = 'inconnu', echecs_consecutifs = 0
       WHERE id_site = ? AND statut <> 'inconnu'`,
      [site.id_site]
    );

    // Les alertes d'indisponibilité en cours reposaient sur une observation
    // qui n'a plus lieu : on ne peut pas continuer à les affirmer. Elles sont
    // clôturées, et l'alerte `agent_muet` prend le relais pour signaler que le
    // problème est désormais la perte de visibilité elle-même.
    // Sans cela, ces alertes resteraient actives indéfiniment et gonfleraient
    // le temps d'indisponibilité dans le calcul de disponibilité.
    await db.query(
      `UPDATE ALERTE a
       JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
       SET a.statut = 'resolue', a.date_resolution = NOW()
       WHERE a.type_alerte = 'equipement_down'
         AND a.statut IN ('active', 'traitee')
         AND e.id_site = ?`,
      [site.id_site]
    );
  }

  /* ═══════════════════════════════════════════════════════════════════
     L'ANGLE MORT : UN AGENT DÉCLARÉ QUI N'A JAMAIS TRANSMIS.

     La requête ci-dessus filtre `dernier_push IS NOT NULL` — elle ne
     détecte donc qu'un agent qui S'EST TU. Un site déclaré « supervisé
     par un agent local » dont l'agent n'a JAMAIS transmis échappait aux
     deux mécanismes à la fois :

       • le cycle central l'ignore, puisqu'il est déclaré agent local ;
       • la détection d'agent muet l'ignore, faute de `dernier_push`.

     Résultat : un site supervisé par PERSONNE, et aucune alerte pour le
     dire. Constaté sur cette installation — 111 équipements dans ce cas,
     découverts seulement en lisant l'avertissement au démarrage du
     serveur, qui suppose qu'on redémarre et qu'on lise.

     C'est le même défaut de fond que celui corrigé par la migration du
     8 septembre, à l'autre bout : on avait réglé « un essai d'agent
     exclut un site », il restait « une déclaration d'agent sans agent
     exclut un site ». Une case cochée par erreur, ou cochée pour un
     essai jamais défait, suffit à faire disparaître un parc entier.

     POURQUOI ON N'ÉCRIT PAS `statut = 'inconnu'` ICI, contrairement au
     cas de l'agent devenu muet. Un agent qui se tait rend caduques des
     observations qu'il avait faites : les états affichés vieillissent et
     deviennent trompeurs. Un agent qui n'a jamais parlé n'a rien rendu
     caduc — les états en base viennent d'un scan lancé depuis
     l'interface, et ils sont vrais. Les effacer détruirait un inventaire
     légitime pour signaler un problème de configuration.
     ═══════════════════════════════════════════════════════════════════ */
  let jamaisConnectes = [];
  try {
    [jamaisConnectes] = await db.query(
      `SELECT s.id_site, s.nom, s.ville,
              (SELECT COUNT(*) FROM EQUIPEMENT e WHERE e.id_site = s.id_site) AS nb
       FROM SITE s
       WHERE s.supervision_par_agent = TRUE
         AND s.dernier_push IS NULL`
    );
  } catch (err) {
    // Colonne absente : ce contrôle n'a pas lieu d'être, le mode de
    // supervision n'est pas encore explicite sur cette base.
    if (!colonneManquante(err)) throw err;
  }

  for (const site of jamaisConnectes) {
    const [existantes] = await db.query(
      `SELECT id_alerte FROM ALERTE
       WHERE id_site = ? AND type_alerte = 'agent_muet' AND statut = 'active'`,
      [site.id_site]
    );
    if (existantes.length > 0) continue;

    await creerAlerteSite(
      site,
      "agent_muet",
      "critical",
      `Le site « ${site.nom} » (${site.ville}) est déclaré supervisé par un agent local, ` +
        `mais aucun agent n'a jamais transmis. Ses ${site.nb} équipement(s) ne sont ` +
        `surveillés par personne : ni par un agent, ni par le serveur central. ` +
        `Installez l'agent sur ce site, ou décochez « supervisé par un agent local » ` +
        `sur la page Sites pour que le serveur central reprenne la main.`,
      "agent_jamais_connecte"
    );
  }

  // Résolution automatique dès qu'un site recommence à transmettre.
  await db.query(
    `UPDATE ALERTE a
     JOIN SITE s ON s.id_site = a.id_site
     SET a.statut = 'resolue', a.date_resolution = NOW()
     WHERE a.type_alerte = 'agent_muet'
       AND a.statut IN ('active', 'traitee')
       AND s.dernier_push IS NOT NULL
       AND TIMESTAMPDIFF(MINUTE, s.dernier_push, NOW()) < ?`,
    [seuilMinutes]
  );

  // Et dès qu'un site repasse sous supervision centrale : le problème
  // signalé était « personne ne surveille ce site », il ne se pose plus.
  // Sans cette clôture, l'alerte resterait active après la correction —
  // et une alerte qui ne s'éteint pas quand on la corrige apprend aux
  // utilisateurs à ignorer les alertes.
  await db
    .query(
      `UPDATE ALERTE a
       JOIN SITE s ON s.id_site = a.id_site
       SET a.statut = 'resolue', a.date_resolution = NOW()
       WHERE a.type_alerte = 'agent_muet'
         AND a.statut IN ('active', 'traitee')
         AND s.supervision_par_agent = FALSE`
    )
    .catch((err) => {
      if (!colonneManquante(err)) throw err;
    });
}

/**
 * Purge les relevés au-delà de la durée de rétention configurée.
 *
 * Suppression PAR LOTS : un DELETE unique sur plusieurs centaines de milliers
 * de lignes verrouille la table et bloque les insertions du cycle de
 * supervision. On procède par tranches avec un plafond par passage, quitte à
 * étaler la purge sur plusieurs heures lors du premier nettoyage.
 */
/**
 * Alerte sur les certificats qui expirent.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE CONTRÔLE NE RESSEMBLE À AUCUN AUTRE DE CE FICHIER
 *
 * Toutes les autres vérifications constatent un problème DÉJÀ SURVENU :
 * une machine est tombée, une mémoire est saturée, un agent s'est tu.
 * Celle-ci est la seule qui prévienne AVANT.
 *
 * C'est aussi la seule panne du parc dont la date est connue à la
 * seconde près, des mois à l'avance, et écrite dans l'équipement
 * lui-même. Ne pas l'annoncer serait un gâchis particulier : l'outil a
 * l'information en main et laisse quand même le service tomber.
 *
 * ELLE N'ENVOIE RIEN SUR LE RÉSEAU. Les dates viennent de la table,
 * remplie au dernier scan. Le contrôle est une simple lecture.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEUX NIVEAUX, ET LE SEUIL EST CHOISI
 *
 * Trente jours : le délai qu'il faut pour obtenir un certificat auprès
 * d'une autorité, le faire valider en interne et le déployer. Alerter à
 * sept jours produirait une urgence là où une tâche planifiée suffisait.
 *
 * UN CERTIFICAT PÉRIMÉ RESTE UNE ALERTE, il ne devient pas un état
 * normal parce qu'il dure. C'est le piège classique de ce genre de
 * contrôle : le rendre silencieux passé un certain temps, au motif que
 * « tout le monde sait ».
 */
async function verifierCertificats() {
  let lignes;
  try {
    [lignes] = await db.query(
      `SELECT c.id_equipement, c.port, c.sujet, c.valide_au,
              DATEDIFF(c.valide_au, NOW()) AS jours_restants,
              e.id_site, e.adresse_ip,
              COALESCE(e.nom_personnalise, e.nom) AS nom
       FROM CERTIFICAT_TLS c
       JOIN EQUIPEMENT e ON e.id_equipement = c.id_equipement
       WHERE c.valide_au IS NOT NULL`
    );
  } catch (err) {
    // Migration 2026-09-10 non passée : le cycle continue sans ce
    // contrôle plutôt que d'abandonner tous les autres.
    if (/doesn't exist|Unknown column/i.test(err.message)) return;
    throw err;
  }

  /* UN ÉQUIPEMENT, UNE ALERTE — pas une par port.

     Un serveur qui expose 443, 993 et 465 avec le MÊME certificat
     produirait trois alertes identiques pour un seul renouvellement à
     faire. Le dédoublonnage du fichier porte sur (équipement, type) : on
     retient donc le certificat le plus urgent de la machine, et son
     message nomme le port concerné. */
  const parEquipement = new Map();
  for (const l of lignes) {
    const actuel = parEquipement.get(l.id_equipement);
    if (!actuel || Number(l.jours_restants) < Number(actuel.jours_restants)) {
      parEquipement.set(l.id_equipement, l);
    }
  }

  for (const c of parEquipement.values()) {
    const jours = Number(c.jours_restants);
    const equipement = {
      id_equipement: c.id_equipement,
      id_site: c.id_site,
      adresse_ip: c.adresse_ip,
      nom: c.nom,
    };
    const quoi = `${c.sujet || "certificat"} (port ${c.port})`;

    if (jours < 0) {
      await creerAlerte(
        equipement,
        "certificat_expire",
        "critical",
        `Certificat EXPIRÉ depuis ${Math.abs(jours)} jour(s) : ${quoi}. ` +
          "Le service est inaccessible ou affiche un avertissement de sécurité " +
          "à chaque connexion.",
        "certificat_expire"
      );
      // L'avertissement devient une panne : l'alerte préventive n'a plus
      // lieu d'être, sinon les deux coexistent et se contredisent.
      await resoudreAlertes(c.id_equipement, "certificat_expire_bientot");
    } else if (jours <= SEUIL_ALERTE_JOURS) {
      await creerAlerte(
        equipement,
        "certificat_expire_bientot",
        "warning",
        `Certificat à renouveler sous ${jours} jour(s) : ${quoi}. ` +
          `Expiration le ${new Date(c.valide_au).toLocaleDateString("fr-FR")}.`,
        "certificat_expire_bientot"
      );
    } else {
      // Renouvelé : les deux alertes se referment. Sans cette branche,
      // une alerte réglée resterait affichée jusqu'à ce qu'un humain
      // l'acquitte — et un tableau de bord qui garde des alertes mortes
      // finit par ne plus être lu du tout.
      await resoudreAlertes(c.id_equipement, "certificat_expire");
      await resoudreAlertes(c.id_equipement, "certificat_expire_bientot");
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   DEUX ALERTES QUE LE PLAN D'ADRESSAGE EST SEUL À POUVOIR LEVER.

   1. UNE PLAGE PRESQUE PLEINE. Un responsable réseau découvre d'habitude
      qu'il n'a plus d'adresses le jour où une machine ne peut plus se
      connecter — c'est-à-dire trop tard, et au pire moment. Le compte est
      là, dans le plan ; il suffisait de le regarder.

   2. UNE MACHINE POSÉE SUR UNE ZONE RÉSERVÉE. Typiquement une adresse
      fixe donnée à la main dans le pool DHCP. Ça marche, jusqu'au jour où
      le DHCP attribue la même adresse à quelqu'un d'autre. La panne qui
      suit est intermittente, et on la cherche du côté du câble.

   LES DEUX SONT RÉGLABLES depuis l'écran Alertes, comme les autres :
   niveau, seuil, et interrupteur. Une règle éteinte n'est pas évaluée du
   tout — pas « évaluée en silence ».

   NE LÈVE JAMAIS : ni une plage illisible, ni une base sans les tables du
   28/09 ne doivent interrompre les autres tâches planifiées.
   ═══════════════════════════════════════════════════════════════════════ */
async function evaluerPlansDAdressage() {
  const reglePlage = await reglesAlerte.regle("plage_presque_pleine", "tous");
  const regleZone = await reglesAlerte.regle("adresse_sur_zone_reservee", "tous");
  if (!reglePlage.active && !regleZone.active) return;

  const seuilPourcent =
    Number.isFinite(reglePlage.seuil) && reglePlage.seuil !== null ? reglePlage.seuil : 10;

  const [sites] = await db.query("SELECT id_site, nom FROM SITE");

  for (const site of sites) {
    let plans = [];
    try {
      plans = await planDuSite(site.id_site);
    } catch (err) {
      console.error(`Plan d'adressage du site ${site.id_site} illisible:`, err.message);
      continue;
    }

    for (const plan of plans) {
      if (plan.erreur) continue;

      // ── 1. La place qui reste ──
      if (reglePlage.active && plan.total_attribuables > 0) {
        const partLibre = (plan.nb_libres / plan.total_attribuables) * 100;

        if (partLibre <= seuilPourcent) {
          await creerAlerteSite(
            site,
            `plage_pleine_${plan.cidr}`,
            reglePlage.niveau || "warning",
            `La plage ${plan.cidr} n'a plus que ${plan.nb_libres} adresse(s) libre(s) ` +
              `sur ${plan.total_attribuables} (${partLibre.toFixed(0)} %). ` +
              `Le plus grand bloc d'un seul tenant fait ${plan.plus_grand_bloc_libre ?? "?"} adresse(s).`,
            "plage_presque_pleine"
          );
        } else {
          /* LA RÉSOLUTION EST AUSSI IMPORTANTE QUE L'ALERTE. Une plage
             qu'on a désencombrée — machines retirées, zone réservée
             supprimée — doit voir son alerte se refermer, sinon l'écran
             garde un problème réglé. */
          await db.query(
            `UPDATE ALERTE SET statut = 'resolue', date_resolution = NOW()
              WHERE id_site = ? AND type_alerte = ? AND statut IN ('active', 'traitee')`,
            [site.id_site, `plage_pleine_${plan.cidr}`]
          );
        }
      }

      // ── 2. Les machines posées sur une zone réservée ──
      if (regleZone.active) {
        const occupants = plan.occupants_de_zones_reservees || [];

        for (const o of occupants) {
          if (!o.id_equipement) continue;
          await creerAlerte(
            { id_equipement: o.id_equipement, id_site: site.id_site, nom: o.nom, adresse_ip: o.adresse },
            "adresse_sur_zone_reservee",
            regleZone.niveau || "warning",
            `${o.nom || o.adresse} occupe ${o.adresse}, dans une zone réservée : ` +
              `« ${o.motif} ». Tant que la zone est distribuée par un autre mécanisme — ` +
              "un serveur DHCP, par exemple — cette adresse peut être attribuée deux fois.",
            "adresse_sur_zone_reservee"
          );
        }

        /* Les machines qui ONT ÉTÉ déplacées hors d'une zone réservée
           voient leur alerte se refermer. On compare sur la liste du
           passage courant : ce qui n'y est plus n'est plus en conflit. */
        const encoreEnConflit = new Set(occupants.map((o) => o.id_equipement).filter(Boolean));
        const [ouvertes] = await db.query(
          `SELECT a.id_alerte, a.id_equipement FROM ALERTE a
             JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
            WHERE a.type_alerte = 'adresse_sur_zone_reservee'
              AND a.statut = 'active' AND e.id_site = ?`,
          [site.id_site]
        );
        for (const a of ouvertes) {
          if (!encoreEnConflit.has(a.id_equipement)) {
            await resoudreAlertes(a.id_equipement, "adresse_sur_zone_reservee");
          }
        }
      }
    }
  }
}

/**
 * Supprime par lots, sans jamais tenir la table longtemps.
 *
 * Un `DELETE` d'un seul bloc sur plusieurs centaines de milliers de lignes
 * pose un verrou InnoDB de plusieurs secondes — pendant lesquelles le
 * cycle de supervision n'écrit plus ses relevés. La purge des relevés
 * était déjà écrite ainsi ; les nouvelles suivent la même règle.
 */
async function supprimerParLots(sql, params, libelle) {
  let total = 0;
  for (let lot = 0; lot < MAX_LOTS_PAR_PASSAGE; lot++) {
    const [r] = await db.query(sql, [...params, TAILLE_LOT_PURGE]);
    total += r.affectedRows;
    if (r.affectedRows < TAILLE_LOT_PURGE) break;
  }
  if (total > 0) {
    console.log(
      `Purge — ${libelle} : ${total} ligne(s) supprimée(s).` +
        (total >= TAILLE_LOT_PURGE * MAX_LOTS_PAR_PASSAGE
          ? " Plafond du passage atteint, la purge reprendra à la prochaine heure."
          : "")
    );
  }
  return total;
}

/**
 * ═══════════════════════════════════════════════════════════════════════
 * REFERMER LES INCIDENTS, PUIS EFFACER CE QUI A ASSEZ VÉCU
 *
 * ── D'ABORD LES INCIDENTS, ET C'EST LE PLUS IMPORTANT ──
 *
 * `escaladeIncidents()` ouvre un incident pour toute alerte critique de
 * plus de quinze minutes. RIEN ne le refermait quand l'alerte se
 * résolvait : les seules écritures sur `INCIDENT.statut` étaient une
 * action manuelle et la réinitialisation générale.
 *
 * Un serveur qui redémarre chaque nuit produisait donc un incident ouvert
 * par nuit, pour un problème disparu à trois heures du matin. En quelques
 * semaines, l'écran Incidents devenait une liste de dossiers morts — et
 * le seul incident réel s'y perdait. Un outil qui crie tout le temps
 * n'est plus écouté, c'est le raisonnement que la plateforme applique
 * partout ailleurs.
 *
 * La fermeture se fait ICI, par une seule requête qui rattrape tous les
 * chemins de résolution, plutôt qu'en quatre appels dispersés qu'un
 * cinquième chemin futur oublierait.
 *
 * ── CE QUI EST GARDÉ, ET COMBIEN DE TEMPS ──
 *
 * Les durées sont dans CONFIGURATION, modifiables depuis l'écran. Voir la
 * migration 2026-09-28-retentions.sql pour le raisonnement derrière
 * chacune.
 *
 * Les incidents n'ont pas de durée propre : ils partent avec leur alerte,
 * par la cascade déjà déclarée. Un incident sans son alerte n'aurait
 * aucun sens.
 *
 * NE LÈVE JAMAIS. Chaque étape est indépendante : une table absente —
 * migration non passée — ne doit pas empêcher les autres purges. C'est la
 * même leçon que la vérification des certificats, qui mourait en silence
 * parce qu'elle partageait un `try` avec autre chose.
 */
async function purgerHistoriques() {
  // 1. Refermer les incidents dont l'alerte est résolue.
  try {
    const [r] = await db.query(
      `UPDATE INCIDENT i
         JOIN ALERTE a ON a.id_alerte = i.id_alerte
          SET i.statut = 'ferme', i.date_fermeture = COALESCE(a.date_resolution, NOW())
        WHERE i.statut <> 'ferme'
          AND a.statut = 'resolue'`
    );
    if (r.affectedRows > 0) {
      console.log(
        `Incidents — ${r.affectedRows} dossier(s) refermé(s) : leur alerte est résolue.`
      );
    }
  } catch (err) {
    console.error("Fermeture automatique des incidents ignorée:", err.message);
  }

  // 2. Alertes résolues trop anciennes. Les incidents suivent par cascade.
  try {
    const jours = await getConfig("retention_alertes_resolues_jours", 90);
    if (Number.isFinite(jours) && jours > 0) {
      await supprimerParLots(
        `DELETE FROM ALERTE
          WHERE statut = 'resolue'
            AND date_resolution IS NOT NULL
            AND date_resolution < NOW() - INTERVAL ? DAY
          LIMIT ?`,
        [jours],
        `alertes résolues de plus de ${jours} jours`
      );
    }
  } catch (err) {
    console.error("Purge des alertes ignorée:", err.message);
  }

  // 3. Journal d'activité. Durée longue : il sert de preuve.
  try {
    const jours = await getConfig("retention_journal_jours", 365);
    if (Number.isFinite(jours) && jours > 0) {
      await supprimerParLots(
        "DELETE FROM LOG_ACTIVITE WHERE date_log < NOW() - INTERVAL ? DAY LIMIT ?",
        [jours],
        `journal de plus de ${jours} jours`
      );
    }
  } catch (err) {
    console.error("Purge du journal ignorée:", err.message);
  }

  /* 4. Logiciels qu'aucun inventaire n'a revus depuis longtemps.
        Ici la purge ne libère pas que de la place : elle rétablit la
        justesse de la fiche, qui affichait trois versions d'un même
        navigateur dont deux désinstallées depuis des mois. */
  try {
    const jours = await getConfig("retention_logiciels_jours", 60);
    if (Number.isFinite(jours) && jours > 0) {
      await supprimerParLots(
        "DELETE FROM LOGICIEL_INSTALLE WHERE derniere_vue < NOW() - INTERVAL ? DAY LIMIT ?",
        [jours],
        `logiciels non revus depuis ${jours} jours`
      );
    }
  } catch (err) {
    if (!/doesn't exist|Unknown column/i.test(err.message)) {
      console.error("Purge de l'inventaire logiciel ignorée:", err.message);
    }
  }
}

async function purgerReleves() {
  const jours = await getConfig("retention_releves_jours", 30);
  if (!Number.isFinite(jours) || jours <= 0) {
    console.warn("Purge des relevés ignorée : retention_releves_jours invalide.");
    return 0;
  }

  let total = 0;
  for (let lot = 0; lot < MAX_LOTS_PAR_PASSAGE; lot++) {
    const [result] = await db.query(
      `DELETE FROM RELEVE
       WHERE date_releve < NOW() - INTERVAL ? DAY
       LIMIT ?`,
      [jours, TAILLE_LOT_PURGE]
    );
    total += result.affectedRows;
    if (result.affectedRows < TAILLE_LOT_PURGE) break;
  }

  if (total > 0) {
    console.log(
      `Purge des relevés : ${total} ligne(s) supprimée(s) (rétention ${jours} jour(s)).` +
        (total >= TAILLE_LOT_PURGE * MAX_LOTS_PAR_PASSAGE
          ? " Plafond du passage atteint, la purge reprendra à la prochaine heure."
          : "")
    );
  }
  return total;
}

/** Niveaux acceptés, du moins au plus grave. */
const NIVEAUX_ALERTE = ["info", "warning", "critical"];

/**
 * Lit `niveaux_escalade_incident` et renvoie la liste des niveaux qui
 * autorisent la création d'un incident.
 *
 * Valeur attendue : liste séparée par des virgules, par ex. `critical` ou
 * `warning,critical`. Défaut : `critical` seul.
 *
 * Cette clé n'est pas numérique : elle ne peut pas passer par getConfig(),
 * qui convertit en Number.
 */
async function niveauxEscalade() {
  const DEFAUT = ["critical"];
  try {
    const [rows] = await db.query(
      "SELECT valeur FROM CONFIGURATION WHERE cle = 'niveaux_escalade_incident'"
    );
    if (!rows[0]) return DEFAUT;

    const niveaux = String(rows[0].valeur)
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter((n) => NIVEAUX_ALERTE.includes(n));

    // Une valeur vide ou entièrement invalide ne doit pas désactiver
    // silencieusement toute escalade : on retombe sur le défaut.
    if (niveaux.length === 0) {
      console.warn(
        "niveaux_escalade_incident invalide ou vide — retour au défaut « critical »."
      );
      return DEFAUT;
    }
    return niveaux;
  } catch (err) {
    console.error("Lecture de niveaux_escalade_incident impossible:", err.message);
    return DEFAUT;
  }
}

/**
 * Escalade des alertes restées actives trop longtemps en incidents.
 *
 * FILTRAGE PAR NIVEAU — seules les alertes `critical` deviennent des
 * incidents par défaut.
 *
 * Sans ce filtre, une charge processeur élevée pendant 15 minutes ouvrait un
 * incident. Or une sauvegarde, une indexation ou une mise à jour saturent
 * légitimement un serveur bien au-delà de ce délai : la file d'incidents se
 * remplissait de situations normales, et les vraies urgences — un équipement
 * injoignable, un agent muet — s'y noyaient.
 *
 * Une alerte non escaladée reste parfaitement visible dans la page Alertes et
 * déclenche sa notification. Elle n'ouvre simplement pas de dossier de suivi.
 */
async function escaladeIncidents() {
  const seuilMinutes = await getConfig("seuil_escalade_minutes", 15);
  const niveaux = await niveauxEscalade();
  const placeholders = niveaux.map(() => "?").join(",");

  const [alertes] = await db.query(
    `SELECT * FROM ALERTE
     WHERE statut = 'active'
       AND niveau IN (${placeholders})
       AND TIMESTAMPDIFF(MINUTE, date_creation, NOW()) >= ?
       AND id_alerte NOT IN (SELECT id_alerte FROM INCIDENT)`,
    [...niveaux, seuilMinutes]
  );

  for (const alerte of alertes) {
    await db.query(
      `INSERT INTO INCIDENT (id_alerte, titre, description, statut)
       VALUES (?, ?, ?, 'ouvert')`,
      [alerte.id_alerte, `Incident: ${alerte.type_alerte}`, alerte.message]
    );
  }
  return alertes.length;
}

/**
 * Évite de répéter l'avertissement « supervision à l'arrêt » à chaque
 * cycle — c'est-à-dire chaque minute. Un message juste, répété soixante
 * fois par heure, cesse d'être lu.
 */
let supervisionVideSignalee = false;

/** Même logique pour l'absence de SITE.dernier_push : une fois suffit. */
let colonneDernierPushSignalee = false;
let colonneModeSupervisionSignalee = false;

// `colonneManquante` était déclarée UNE SECONDE FOIS ici, écrasant
// silencieusement celle définie plus haut dans le même fichier. Les deux
// versions étaient identiques, donc sans effet visible — mais deux
// définitions du même nom dans un fichier de mille lignes signifient
// qu'une correction apportée à l'une ne s'appliquera pas.

async function cycleSupervision() {
  // Une seule lecture de la configuration pour tout le cycle.
  const cfg = await chargerConfigCycle();

  // Périmètre du cycle central : ne superviser que ce qu'on peut
  // atteindre. Le serveur pinguait auparavant tous les équipements, y
  // compris ceux des sites distants — or l'architecture repose sur un
  // agent local précisément parce qu'un réseau privé distant n'est pas
  // joignable depuis le central. Ces machines étaient marquées `down` en
  // permanence alors qu'elles fonctionnaient.
  //
  // Critère : `SITE.dernier_push`. Un site qui a déjà transmis est
  // supervisé par son agent ; un site qui n'a jamais transmis est scanné
  // depuis l'interface, donc joignable. Même convention que verifierAgents().
  //
  // Repli si la colonne manque (migration 2026-08-10 non passée) : la
  // requête échouait, l'exception remontait au planificateur et le cycle
  // ENTIER était abandonné, toutes les minutes. Constaté en réel :
  // 113 équipements, aucun relevé, aucun graphique, pour une colonne
  // absente. Le repli supervise alors tout le parc — moins juste, les
  // sites distants risquant d'être marqués hors ligne à tort, mais une
  // plateforme qui se trompe sur un site distant reste utile, une
  // plateforme muette non.
  let equipements;
  try {
    // Le critère est la DÉCLARATION, plus la trace d'un envoi.
    //
    // On filtrait sur `dernier_push IS NULL` : un agent lancé une seule
    // fois, pour un essai, sur un site local, l'excluait définitivement de
    // la supervision. Constaté — 135 équipements plus surveillés par
    // personne pendant quatre jours, parce qu'un agent de test avait
    // tourné cinq minutes.
    //
    // `supervision_par_agent` dit ce qu'on VEUT ; `dernier_push` garde son
    // rôle propre, savoir si un agent déclaré transmet encore.
    [equipements] = await db.query(
      `SELECT e.* FROM EQUIPEMENT e
       JOIN SITE s ON s.id_site = e.id_site
       WHERE s.supervision_par_agent = FALSE`
    );
  } catch (err) {
    if (!colonneManquante(err)) throw err;

    // DÉGRADATION EN DEUX TEMPS, ET NON D'UN COUP.
    //
    // La colonne `supervision_par_agent` vient de la migration
    // 2026-09-08. Absente, on retombe sur l'ANCIEN critère plutôt que de
    // superviser tout le parc : `dernier_push IS NULL` reste imparfait,
    // mais il évite de pinguer en vain les sites distants et de les
    // déclarer en panne à tort. On ne dégrade au maximum qu'en dernier
    // recours.
    try {
      if (!colonneModeSupervisionSignalee) {
        colonneModeSupervisionSignalee = true;
        console.warn(
          "\n⚠  SITE.supervision_par_agent est absente de la base.\n" +
            "   Repli sur l'ancien critère (dernier_push), qui exclut un site\n" +
            "   dès qu'un agent y a poussé une seule fois — même pour un essai.\n" +
            "   Pour corriger :\n" +
            "   backend/migrations/2026-09-08-mode-de-supervision-explicite.sql\n"
        );
      }
      [equipements] = await db.query(
        `SELECT e.* FROM EQUIPEMENT e
         JOIN SITE s ON s.id_site = e.id_site
         WHERE s.dernier_push IS NULL`
      );
    } catch (err2) {
      if (!colonneManquante(err2)) throw err2;

      if (!colonneDernierPushSignalee) {
        colonneDernierPushSignalee = true;
        console.warn(
          "\n⚠  SITE.dernier_push est absente de la base.\n" +
            "   La supervision continue en mode dégradé : TOUS les équipements\n" +
            "   sont sondés, y compris ceux des sites distants — qui seront\n" +
            "   marqués hors ligne à tort s'ils ne sont pas joignables d'ici.\n" +
            "   Pour rétablir le comportement normal :\n" +
            "   backend/migrations/2026-08-10-fiabilite-usage-prolonge.sql\n"
        );
      }
      [equipements] = await db.query("SELECT * FROM EQUIPEMENT");
    }
  }

  // GARDE-FOU : LE CYCLE QUI NE SUPERVISE PLUS RIEN, EN SILENCE.
  //
  // Le filtre ci-dessus est correct — on ne pingue pas un site distant
  // injoignable — mais il a un effet de bord redoutable. Il suffit
  // qu'un agent ait poussé UNE FOIS pour un site pour que ce site sorte
  // définitivement du cycle central. Sur le site local, qui héberge le
  // serveur, la supervision s'arrête alors complètement.
  //
  // Constaté en conditions réelles : un agent de test lancé une fois sur
  // le site local avait renseigné `dernier_push`. Résultat, plus aucun
  // relevé sur 113 équipements — donc aucun graphique, aucune mesure de
  // bande passante. Et RIEN ne le signalait : les statuts restaient
  // figés au dernier état connu, l'interface avait l'air normale.
  //
  // Une panne silencieuse qui laisse l'écran crédible est le pire cas
  // possible pour un outil de supervision : le client croit être
  // surveillé et ne l'est plus.
  //
  // On ne corrige pas automatiquement — remettre `dernier_push` à NULL
  // couperait la supervision d'un vrai site distant. On le DIT, une
  // fois par démarrage, avec la requête exacte à exécuter.
  if (equipements.length === 0 && !supervisionVideSignalee) {
    const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM EQUIPEMENT");
    if (total > 0) {
      supervisionVideSignalee = true;
      const [sitesExclus] = await db.query(
        `SELECT s.id_site, s.nom, s.dernier_push, COUNT(e.id_equipement) AS equipements
         FROM SITE s JOIN EQUIPEMENT e ON e.id_site = s.id_site
         WHERE s.supervision_par_agent = TRUE
         GROUP BY s.id_site, s.nom, s.dernier_push`
      );
      console.warn(
        `\n⚠  SUPERVISION CENTRALE À L'ARRÊT : ${total} équipement(s) en base, aucun supervisé.\n` +
          "   Tous les sites sont déclarés « supervisés par un agent local »,\n" +
          "   et sont donc exclus du cycle central.\n" +
          sitesExclus
            .map(
              (s) =>
                `     • site ${s.id_site} « ${s.nom} » — ${s.equipements} équipement(s), ` +
                `dernier push ${s.dernier_push || "jamais"}`
            )
            .join("\n") +
          "\n\n   Si un de ces sites est en réalité LOCAL, décochez « supervisé par\n" +
          "   un agent local » sur la page Sites — ou, en base :\n\n" +
          "     UPDATE SITE SET supervision_par_agent = FALSE WHERE id_site = <numéro>;\n"
      );
    }
  } else if (equipements.length > 0) {
    // La situation s'est rétablie : on réarme l'avertissement pour qu'il
    // reparaisse si le problème revient.
    supervisionVideSignalee = false;
  }

  // Traitement par lots bornés : on attend chaque lot avant de lancer le suivant.
  for (let i = 0; i < equipements.length; i += CONCURRENCE_SUPERVISION) {
    const lot = equipements.slice(i, i + CONCURRENCE_SUPERVISION);
    await Promise.all(
      lot.map((eq) =>
        checkEquipement(eq, cfg).catch((err) =>
          console.error(`Supervision de ${eq.adresse_ip} échouée:`, err.message)
        )
      )
    );
  }

  /* ── CE QUE LE PING N'A PAS SUFFI À PROUVER ──

     Une ligne, et seulement quand il y a quelque chose à dire. Elle
     répond à la question qu'on se pose devant un parc bureautique :
     « ces machines sont-elles vraiment en ligne ? » — en disant sur quoi
     la plateforme se fonde pour l'affirmer, machine muette au ping par
     machine muette au ping. */
  const totalPreuves =
    compteurPreuves.pare_feu_probable +
    compteurPreuves.refus_tcp +
    compteurPreuves.voisinage_arp;
  if (totalPreuves > 0) {
    console.log(
      `Supervision — ${totalPreuves} machine(s) muette(s) au ping mais bien en ligne : ` +
        `${compteurPreuves.pare_feu_probable} par port ouvert, ` +
        `${compteurPreuves.refus_tcp} par refus TCP, ` +
        `${compteurPreuves.voisinage_arp} par réponse ARP.`
    );
    compteurPreuves.pare_feu_probable = 0;
    compteurPreuves.refus_tcp = 0;
    compteurPreuves.voisinage_arp = 0;
  }

  /* ── FIN DE CYCLE : LE SEUL ÉVÉNEMENT QUI DIT « IL Y A DE NOUVELLES
     MESURES ». ──

     Les événements « equipement » existants ne partent QUE sur un
     changement d'état — une machine qui tombe, une qui revient. Or le cas
     normal, celui qui remplit les graphiques, est un cycle où rien ne
     change d'état et où cent relevés sont pourtant écrits.

     Sans cet événement, tous les écrans de MESURE — graphiques de
     latence, bande passante, taux de disponibilité — n'apprenaient jamais
     qu'il y avait du neuf. Ils affichaient l'état du chargement de la
     page et attendaient un F5. Sur un outil de supervision, c'est
     précisément le geste qu'on ne veut pas faire devant un client.

     L'événement ne porte aucune mesure : chaque écran va relire par les
     routes normales, qui appliquent le cloisonnement et les rôles. */
  if (equipements.length > 0) {
    diffuser(null, "cycle", { equipements: equipements.length });
  }

  /* ── L'INVENTAIRE SE NETTOIE TOUT SEUL, À CHAQUE CYCLE ──

     Placé APRÈS la boucle, jamais avant : un équipement sondé à l'instant
     vient peut-être d'écrire son premier relevé, et il ne doit pas être
     jugé sur un état antérieur d'une seconde.

     Portée VOLONTAIREMENT globale, alors que le cycle ne supervise que les
     sites sans agent : une adresse sans équipement inscrite par un agent
     distant est exactement le même défaut, et n'aurait sinon jamais été
     nettoyée. Les équipements poussés par un agent portent le statut
     « up », que le critère écarte d'office. */
  await purgerAdressesSansPreuve().catch((err) =>
    console.error("Nettoyage de l'inventaire ignoré:", err.message)
  );
}

function start() {
  // Le cron tourne chaque minute, mais ne déclenche la vérification que si
  // l'intervalle configuré (intervalle_scan_minutes) est écoulé. Cela permet
  // de modifier l'intervalle depuis l'interface sans redémarrer le serveur.
  cron.schedule("* * * * *", async () => {
    if (cycleEnCours) {
      console.warn("Cycle de supervision précédent encore en cours — passage ignoré.");
      return;
    }

    try {
      const intervalleMinutes = await getConfig("intervalle_scan_minutes", 1);
      const ecouleMinutes = (Date.now() - derniereVerification) / 60000;
      if (ecouleMinutes < intervalleMinutes) return;

      cycleEnCours = true;
      derniereVerification = Date.now();
      await cycleSupervision();
    } catch (err) {
      console.error("Erreur du cycle de supervision:", err.message);
    } finally {
      cycleEnCours = false;
    }
  });

  cron.schedule("*/5 * * * *", async () => {
    if (escaladeEnCours) return;
    try {
      escaladeEnCours = true;
      await escaladeIncidents();
    } catch (err) {
      console.error("Erreur d'escalade des incidents:", err.message);
    } finally {
      escaladeEnCours = false;
    }
  });

  // Surveillance des agents distants : toutes les 5 minutes. Inutile d'aller
  // plus vite, le seuil de silence se compte en dizaines de minutes.
  cron.schedule("*/5 * * * *", async () => {
    if (agentsEnCours) return;
    try {
      agentsEnCours = true;

      /* ── DEUX `try` ET NON UN SEUL ──

         Les deux vérifications partagent le même passage parce qu'elles
         ont la même cadence, PAS parce qu'elles dépendent l'une de
         l'autre.

         Dans un `try` commun, une exception de `verifierAgents` — par
         exemple `creerAlerteSite` sur une base à laquelle il manque une
         colonne — empêchait `verifierCertificats` d'être seulement
         atteinte. La seule fonction de la plateforme qui prévienne AVANT
         la panne mourait donc en silence, et un certificat expirait sans
         que rien ne soit dit, alors que l'information était connue des
         mois à l'avance.

         Une vérification qui échoue ne doit jamais en éteindre une
         autre. */
      try {
        await verifierAgents();
      } catch (err) {
        console.error("Erreur de vérification des agents:", err.message);
      }

      try {
        await verifierCertificats();
      } catch (err) {
        console.error("Erreur de vérification des certificats:", err.message);
      }
    } catch (err) {
      console.error("Erreur du passage agents/certificats:", err.message);
    } finally {
      agentsEnCours = false;
    }
  });

  /* ── LE PLAN D'ADRESSAGE, UNE FOIS PAR HEURE ──
     À la 35e minute, pour ne croiser ni la supervision, ni les rapports,
     ni la purge. Un plan ne change pas en cinq minutes : le calculer plus
     souvent coûterait sans rien apprendre. */
  cron.schedule("35 * * * *", async () => {
    try {
      await evaluerPlansDAdressage();
    } catch (err) {
      console.error("Évaluation du plan d'adressage échouée:", err.message);
    }
  });

  // Rapport planifié : passage horaire à la 10e minute. Le service décide
  // lui-même si le moment correspond à la planification configurée.
  cron.schedule("10 * * * *", async () => {
    try {
      await passagePlanificateur();
    } catch (err) {
      console.error("Erreur du planificateur de rapports:", err.message);
    }
  });

  // Purge des relevés : une fois par heure, à la 20e minute pour ne pas
  // tomber en même temps que les autres tâches.
  cron.schedule("20 * * * *", async () => {
    if (purgeEnCours) return;
    try {
      purgeEnCours = true;
      await purgerReleves();

      /* ── LA PURGE DES OBSERVATIONS DNS N'ÉTAIT APPELÉE NULLE PART ──

         `purgerObservations()` était écrite, documentée et exportée — et
         aucun planificateur ne l'appelait. Les domaines contactés par
         chaque machine s'accumulaient donc SANS FIN, alors que le module
         annonce une rétention : « une conservation sans fin
         transformerait le relevé en historique de comportement sur
         plusieurs années — exactement ce que le dispositif s'interdit ».

         C'est la pire forme de défaut sur une fonction d'observation :
         la règle est écrite, personne ne la remet en question, et elle
         ne s'applique pas. Rien à l'écran ne l'aurait montré — une
         table qui grossit ne se voit pas.

         Ce que ça change : au premier passage, tout relevé dont la
         dernière occurrence dépasse la rétention (réglage
         `retention_observations_dns_jours`, 90 jours à défaut) est
         effacé. Sur un site qui n'observe rien, l'appel ne supprime
         rien et ne coûte rien.

         Placée ICI et non dans son propre cron : c'est la même nature de
         travail que la purge des relevés — du ménage horaire — et le
         verrou `purgeEnCours` protège déjà les deux d'un recouvrement. */
      const obs = await purgerObservations().catch((err) => {
        // Migration du 14 septembre non passée : les tables n'existent
        // pas encore. Ce n'est pas une panne, et cela ne doit pas
        // empêcher la purge des relevés qui vient de réussir.
        if (!/doesn't exist|Unknown column/i.test(err.message)) {
          console.error("Purge des observations DNS ignorée:", err.message);
        }
        return null;
      });
      if (obs && (obs.domaines > 0 || obs.signaux > 0)) {
        console.log(
          `Purge des observations DNS : ${obs.domaines} domaine(s) et ` +
            `${obs.signaux} signal(aux) effacé(s) (rétention ${obs.jours} jour(s)).`
        );
      }

      /* Alertes, journal, inventaire logiciel — et la fermeture des
         incidents dont l'alerte est résolue. Même passage horaire, même
         verrou : c'est du ménage, il n'a aucune raison d'avoir son propre
         planificateur. */
      await purgerHistoriques();
    } catch (err) {
      console.error("Erreur de purge des relevés:", err.message);
    } finally {
      purgeEnCours = false;
    }
  });
}

/**
 * Évalue les seuils de charge sur un relevé reçu d'un agent.
 *
 * Sans cela, les alertes cpu_eleve / ram_elevee ne s'appliqueraient qu'au
 * site local : les équipements distants produiraient des relevés que
 * personne ne comparerait aux seuils, et la fonctionnalité serait
 * silencieusement à moitié morte.
 *
 * La configuration est lue UNE fois pour tout le lot, comme dans le cycle
 * local. Les compteurs de dépassement sont les mêmes (`depassements`, clé
 * id_equipement) : l'hystérésis et le nombre de relevés consécutifs
 * s'appliquent donc à l'identique, quelle que soit la provenance du relevé.
 *
 * @param {Array<{equipement:object, metrics:object}>} lot
 */
async function evaluerChargeDepuisPush(lot) {
  if (!Array.isArray(lot) || lot.length === 0) return 0;

  const cfg = await chargerConfigCycle();
  let evalues = 0;

  for (const { equipement, metrics } of lot) {
    try {
      await evaluerSeuilsCharge(equipement, metrics, cfg);
      evalues++;
    } catch (err) {
      console.error(
        `Évaluation des seuils pour ${equipement?.adresse_ip} échouée:`,
        err.message
      );
    }
  }
  return evalues;
}

module.exports = {
  start,
  purgerReleves,
  verifierAgents,
  evaluerChargeDepuisPush,
  // Création d'alerte, avec dédoublonnage et compteur d'occurrences.
  // Exportée sans préfixe car appelée depuis les routes — le scan crée
  // les alertes de conflit d'adresses. Le préfixe « _ » est réservé à ce
  // qui n'existe que pour les tests.
  creerAlerte,
  // Exportés pour les tests et le diagnostic.
  _evaluerSeuilsCharge: evaluerSeuilsCharge,
  _chargerConfigCycle: chargerConfigCycle,
  _reinitialiserDepassements: () => depassements.clear(),
  _escaladeIncidents: escaladeIncidents,
  _niveauxEscalade: niveauxEscalade,
  _creerAlerte: creerAlerte,
  _reinitialiserDedoublonnage: () => {
    dedoublonnageDisponible = null;
  },
};