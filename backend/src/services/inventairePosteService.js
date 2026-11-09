/**
 * services/inventairePosteService.js
 * Réception de ce qu'un agent de poste sait de sa propre machine.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEUX DURÉES DE VIE, DEUX TRAITEMENTS
 *
 * Un LOGICIEL installé reste des mois. On garde son historique : première
 * et dernière observation, jamais effacées par un envoi. Un logiciel
 * désinstallé cesse simplement d'être « revu », et cette information vaut
 * autant que sa présence.
 *
 * Un PROCESSUS dure parfois trois secondes. En garder l'historique ferait
 * des millions de lignes par semaine pour une information périmée à la
 * lecture. On garde donc une PHOTOGRAPHIE, remplacée à chaque envoi, avec
 * sa date — sans laquelle on lirait l'instantané d'il y a trois jours en
 * croyant voir maintenant.
 *
 * ─────────────────────────────────────────────────────────────────────
 * `null` N'EST PAS `[]`, ET LA DIFFÉRENCE EST TOUT LE SUJET
 *
 * L'agent envoie `[]` quand il a collecté et n'a rien trouvé, et `null`
 * quand la collecte a ÉCHOUÉ — PowerShell refusé, commande absente,
 * droits insuffisants. Les confondre effacerait l'inventaire complet
 * d'une machine sur un simple refus temporaire, et la fiche afficherait
 * « aucun logiciel » avec l'aplomb d'une information vérifiée.
 *
 * `null` ne touche donc à rien. C'est la même règle que
 * `COALESCE(VALUES(nom), nom)` sur le scan : on ne remplace que par
 * mieux, jamais par du vide.
 */
const db = require("../db");
const { calculerDebitsEquipement } = require("./traficService");
const { enregistrerTopologiePoste } = require("./topologieService");

/**
 * Retrouve l'équipement correspondant à la machine qui s'annonce, ou le
 * crée.
 *
 * L'ADRESSE MATÉRIELLE D'ABORD, L'ADRESSE IP ENSUITE. En DHCP, l'adresse
 * IP d'un poste change ; son adresse matérielle non. Chercher par IP
 * seule créerait un nouvel équipement à chaque renouvellement de bail, et
 * l'inventaire compterait trois fois la même machine.
 *
 * LA CRÉATION EST LÉGITIME ICI, contrairement au scan. Un agent qui parle
 * avec le jeton du site EST une preuve d'existence : il tourne sur une
 * machine réelle, allumée, qui a exécuté du code. C'est même la preuve la
 * plus forte dont dispose la plateforme — plus qu'un ping.
 */
async function trouverOuCreerEquipement(idSite, { adresse_ip, adresse_mac, nom_machine, systeme }) {
  if (adresse_mac) {
    const [parMac] = await db.query(
      "SELECT id_equipement FROM EQUIPEMENT WHERE id_site = ? AND adresse_mac = ? LIMIT 1",
      [idSite, adresse_mac]
    );
    if (parMac.length > 0) return parMac[0].id_equipement;
  }

  const [parIp] = await db.query(
    "SELECT id_equipement FROM EQUIPEMENT WHERE id_site = ? AND adresse_ip = ? LIMIT 1",
    [idSite, adresse_ip]
  );
  if (parIp.length > 0) return parIp[0].id_equipement;

  const [r] = await db.query(
    `INSERT INTO EQUIPEMENT
       (id_site, nom, adresse_ip, adresse_mac, os_detecte, statut,
        derniere_decouverte, preuve_existence, preuve_detail, date_preuve)
     VALUES (?, ?, ?, ?, ?, 'up', NOW(), 'agent_poste', ?, NOW())
     ON DUPLICATE KEY UPDATE
       adresse_mac = COALESCE(VALUES(adresse_mac), adresse_mac),
       statut = 'up', derniere_decouverte = NOW()`,
    [
      idSite,
      nom_machine || null,
      adresse_ip,
      adresse_mac || null,
      systeme || null,
      `un agent installé sur cette machine a transmis son inventaire`,
    ]
  );

  if (r.insertId) return r.insertId;
  const [apres] = await db.query(
    "SELECT id_equipement FROM EQUIPEMENT WHERE id_site = ? AND adresse_ip = ? LIMIT 1",
    [idSite, adresse_ip]
  );
  return apres[0]?.id_equipement ?? null;
}

/** Écrit les logiciels par lots : un poste en porte couramment deux cents. */
async function enregistrerLogiciels(idEquipement, logiciels) {
  if (!Array.isArray(logiciels) || logiciels.length === 0) return 0;

  const TAILLE_LOT = 100;
  let ecrits = 0;

  for (let i = 0; i < logiciels.length; i += TAILLE_LOT) {
    const lot = logiciels.slice(i, i + TAILLE_LOT);
    const valeurs = lot.flatMap((l) => [
      idEquipement,
      String(l.nom).slice(0, 200),
      l.version ? String(l.version).slice(0, 80) : null,
      l.editeur ? String(l.editeur).slice(0, 150) : null,
      l.date_installation || null,
    ]);
    // `derniere_vue = NOW()` mais `premiere_vue` intacte : c'est ce couple
    // qui répond à « depuis quand ce logiciel est-il là ? ».
    const [r] = await db.query(
      `INSERT INTO LOGICIEL_INSTALLE
         (id_equipement, nom, version, editeur, date_installation)
       VALUES ${lot.map(() => "(?, ?, ?, ?, ?)").join(", ")}
       ON DUPLICATE KEY UPDATE
         editeur = COALESCE(VALUES(editeur), editeur),
         date_installation = COALESCE(VALUES(date_installation), date_installation),
         derniere_vue = NOW()`,
      valeurs
    );
    ecrits += r.affectedRows;
  }
  return nombreReel(ecrits, logiciels.length);
}

/**
 * MySQL compte 2 pour une mise à jour et 1 pour une insertion dans
 * `affectedRows`. Le chiffre rendu à l'agent doit être le nombre de
 * logiciels, pas une statistique interne qui ferait croire à un doublement.
 */
function nombreReel(affectees, envoyes) {
  return Math.min(envoyes, affectees);
}

/**
 * Remplace la photographie des processus.
 *
 * En une transaction : un effacement suivi d'une écriture qui échoue
 * laisserait la machine sans aucun processus, ce qui se lirait comme
 * « rien ne tourne » — une affirmation fausse produite par une panne.
 */
async function remplacerProcessus(idEquipement, processus) {
  if (!Array.isArray(processus)) return 0;

  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    await cx.query("DELETE FROM PROCESSUS_OBSERVE WHERE id_equipement = ?", [idEquipement]);

    if (processus.length > 0) {
      const TAILLE_LOT = 150;
      for (let i = 0; i < processus.length; i += TAILLE_LOT) {
        const lot = processus.slice(i, i + TAILLE_LOT);
        await cx.query(
          `INSERT INTO PROCESSUS_OBSERVE
             (id_equipement, nom, occurrences, memoire_ko, utilisateur, date_releve)
           VALUES ${lot.map(() => "(?, ?, ?, ?, ?, NOW())").join(", ")}
           ON DUPLICATE KEY UPDATE
             occurrences = VALUES(occurrences),
             memoire_ko = VALUES(memoire_ko),
             utilisateur = VALUES(utilisateur),
             date_releve = NOW()`,
          lot.flatMap((p) => [
            idEquipement,
            String(p.nom).slice(0, 200),
            Number(p.occurrences) || 1,
            Number.isFinite(Number(p.memoire_ko)) ? Number(p.memoire_ko) : null,
            p.utilisateur ? String(p.utilisateur).slice(0, 120) : null,
          ])
        );
      }
    }

    await cx.commit();
    return processus.length;
  } catch (err) {
    await cx.rollback().catch(() => {});
    throw err;
  } finally {
    cx.release();
  }
}

/**
 * Traite un envoi complet d'agent de poste.
 * @returns {Promise<{id_equipement:number, logiciels:number, processus:number}>}
 */
/* ═══════════════════════════════════════════════════════════════════════
   LE POSTE DEVIENT UNE SOURCE DE MESURE

   ── LE PROBLÈME QUE ÇA RÈGLE ──

   Le débit se lit dans des compteurs SNMP. Or les postes Windows n'ont
   plus de service SNMP depuis des années : la page Bande passante
   n'affichait donc que les imprimantes et les commutateurs — les seuls
   appareils du parc qui acceptent de dire ce qu'ils consomment.

   L'agent, lui, est DANS la machine. Sa carte réseau compte ses propres
   octets, et le processeur donne sa charge sans que personne n'ait à
   l'interroger de l'extérieur.

   ── ON RÉUTILISE LE CALCUL DU SNMP, ON N'EN ÉCRIT PAS UN DEUXIÈME ──

   `calculerDebitsEquipement` fait déjà la différence entre deux relevés,
   écarte la boucle locale sur son nom, et refuse un delta négatif —
   débordement de compteur ou redémarrage. Réécrire ça ici aurait produit
   une deuxième version, qui aurait dérivé de la première au premier
   correctif appliqué d'un seul côté.

   L'agent envoie donc des COMPTEURS, comme SNMP. Le serveur calcule.

   ── LE PREMIER ENVOI NE DONNE AUCUN DÉBIT, ET C'EST NORMAL ──

   Une différence demande deux points. Le premier relevé d'une machine
   écrit donc la charge processeur et la mémoire, mais laisse le débit à
   `null` — jamais à zéro, qui se lirait « cette machine ne consomme
   rien ».
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Pourcentage de mémoire UTILISÉE, à partir de ce que le poste a envoyé.
 *
 * Le script transmet le total et le libre, pas un pourcentage : deux
 * nombres bruts se vérifient, un pourcentage déjà calculé ne se vérifie
 * plus. La conversion a lieu ici, au même endroit que pour le SNMP.
 */
function ramPourcent(sante) {
  /* `Number(null)` vaut 0, et `Number.isFinite(0)` vaut true.
     Un champ absent serait donc devenu « 0 Mo libre », c'est-à-dire
     « mémoire pleine à 100 % » — une alerte inventée à partir de rien.
     On écarte donc null et undefined AVANT de convertir. */
  if (sante?.memoire_totale_mo === null || sante?.memoire_totale_mo === undefined) return null;
  if (sante?.memoire_libre_mo === null || sante?.memoire_libre_mo === undefined) return null;

  const total = Number(sante.memoire_totale_mo);
  const libre = Number(sante.memoire_libre_mo);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(libre) || libre < 0) return null;
  const utilisee = Math.min(total, Math.max(0, total - libre));
  return Math.round((utilisee / total) * 1000) / 10;
}

/**
 * Écrit un relevé à partir de ce qu'un agent de poste vient d'envoyer.
 *
 * @returns {{ecrit: boolean, cpu: number|null, ram: number|null,
 *            entrant: number|null, sortant: number|null}}
 */
async function enregistrerRelevePoste(idEquipement, corps, maintenant = Date.now()) {
  /* Même piège que pour la mémoire : `Number(null)` vaut 0, et une
     charge processeur non collectée serait devenue « 0 % », c'est-à-dire
     une machine au repos. On écarte l'absence avant de convertir. */
  const brutCpu = corps?.processeur_pourcent;
  const cpu =
    brutCpu === null || brutCpu === undefined || !Number.isFinite(Number(brutCpu))
      ? null
      : Number(brutCpu);

  const ram = ramPourcent(corps?.sante);

  let entrant = null;
  let sortant = null;

  if (Array.isArray(corps?.reseau) && corps.reseau.length > 0) {
    /* La clé du cache de `traficService` est `${identifiant}:${index}`.
       On passe l'identifiant d'équipement, comme le cycle central : deux
       postes différents ne peuvent donc pas se mélanger les compteurs,
       même s'ils ont tous les deux une carte d'index 12. */
    const debits = calculerDebitsEquipement(
      idEquipement,
      corps.reseau.map((carte) => ({
        index: carte.index,
        nom: carte.nom,
        inOctets: carte.in_octets,
        outOctets: carte.out_octets,
        vitesseMbps: carte.vitesse_mbps,
      })),
      maintenant
    );
    entrant = debits.total.entrant;
    sortant = debits.total.sortant;
  }

  /* RIEN À ÉCRIRE, ON N'ÉCRIT PAS. Une ligne de relevé dont les quatre
     colonnes sont nulles n'apprend rien et alourdit une table qui compte
     déjà en millions de lignes. */
  if (cpu === null && ram === null && entrant === null && sortant === null) {
    return { ecrit: false, cpu, ram, entrant, sortant };
  }

  await db.query(
    `INSERT INTO RELEVE (id_equipement, cpu_pourcent, ram_pourcent,
                         trafic_entrant_kbps, trafic_sortant_kbps)
     VALUES (?, ?, ?, ?, ?)`,
    [idEquipement, cpu, ram, entrant, sortant]
  );

  return { ecrit: true, cpu, ram, entrant, sortant };
}

async function recevoirInventaire(idSite, corps) {
  const idEquipement = await trouverOuCreerEquipement(idSite, corps);
  if (!idEquipement) {
    throw new Error("Équipement introuvable et non créable pour cet inventaire");
  }

  // `null` = collecte échouée : on ne touche à rien plutôt que d'effacer.
  const nbLogiciels =
    corps.logiciels === null ? null : await enregistrerLogiciels(idEquipement, corps.logiciels);
  const nbProcessus =
    corps.processus === null ? null : await remplacerProcessus(idEquipement, corps.processus);

  await db.query(
    /* LA PREUVE EST POSÉE AUSSI SUR UN ÉQUIPEMENT DÉJÀ CONNU.

       Elle ne l'était qu'à la création. Un poste inscrit par un ancien
       scan, puis équipé d'un agent, gardait donc une preuve vide — et
       redevenait effaçable par le nettoyage automatique dès qu'il
       s'éteignait assez longtemps.

       Un agent qui parle est la preuve la plus forte dont dispose la
       plateforme : il a fallu qu'une machine réelle exécute du code.
       Elle remplace donc franchement une preuve plus faible, au lieu
       d'être conservée par COALESCE comme le fait le scan. */
    `UPDATE EQUIPEMENT
        SET dernier_inventaire_poste = NOW(),
            agent_poste_version = ?,
            nom = COALESCE(nom, ?),
            os_detecte = COALESCE(?, os_detecte),
            statut = 'up',
            echecs_consecutifs = 0,
            preuve_existence = 'agent_poste',
            preuve_detail = 'un agent installé sur cette machine transmet son inventaire',
            date_preuve = NOW()
      WHERE id_equipement = ?`,
    [
      corps.agent_version ? String(corps.agent_version).slice(0, 20) : null,
      corps.nom_machine || null,
      corps.systeme || null,
      idEquipement,
    ]
  );

  /* LA SANTÉ ARRIVE PAR LE MÊME ENVOI, quand la source sait la lire.

     Le script PowerShell la collecte sur la machine elle-même : il n'a
     besoin d'aucun droit d'administration pour connaître la mémoire, les
     disques, l'heure du dernier démarrage et l'état des services de
     protection. Un envoi sans ce volet ne touche à rien — même règle que
     partout : `null` veut dire « je n'ai pas regardé ». */
  const santeEcrite = corps.sante
    ? await enregistrerSantePoste(idEquipement, corps.sante, "agent").catch(() => false)
    : false;

  /* LE RELEVÉ NE DOIT JAMAIS FAIRE ÉCHOUER L'INVENTAIRE.

     Ce sont deux choses différentes arrivées dans le même envoi. Une
     base sans la colonne `cpu_pourcent`, un compteur illisible — rien de
     tout ça ne justifie de perdre la liste des logiciels et des
     processus, qui a coûté une collecte complète sur le poste. */
  const releve = await enregistrerRelevePoste(idEquipement, corps).catch((err) => {
    console.error("Relevé de poste non enregistré:", err.message);
    return { ecrit: false };
  });

  /* LA TOPOLOGIE SUIT LA MÊME RÈGLE, POUR LA MÊME RAISON.

     Les agents déjà déployés enverront ce volet dès leur mise à jour,
     alors que le serveur peut encore tourner sur une base où les tables
     du 2 octobre 2026 n'ont pas été créées. Si cet échec remontait,
     une migration oubliée ferait perdre l'inventaire de tout le parc —
     pour une carte qui n'est qu'un agrément. */
  const topologie = await enregistrerTopologiePoste(idEquipement, corps.topologie).catch((err) => {
    console.error("Topologie de poste non enregistrée:", err.message);
    return { ecrit: false };
  });

  return {
    id_equipement: idEquipement,
    logiciels: nbLogiciels,
    processus: nbProcessus,
    sante: santeEcrite,
    releve,
    topologie,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   LA DEUXIÈME SOURCE : SNMP, SANS AGENT

   Le scan sait désormais lire les programmes en cours et les logiciels
   installés directement par SNMP (HOST-RESOURCES-MIB, voir
   discoveryService.snmpInventaireLogiciel). Cette source-là ne demande
   RIEN à installer sur la machine.

   ELLE SE RANGE DANS LES MÊMES TABLES, et c'est délibéré : LOGICIEL_
   INSTALLE et PROCESSUS_OBSERVE décrivent l'intérieur d'une machine, pas
   la façon dont on l'a appris. Deux tables parallèles auraient obligé
   chaque écran, chaque rapport et chaque futur module à savoir laquelle
   interroger — et à se tromper un jour.

   COMMENT ON SAIT LAQUELLE A PARLÉ. La colonne `agent_poste_version`
   porte déjà « quel collecteur a transmis » : elle vaut le numéro de
   version pour un agent, et la valeur littérale `snmp` pour cette
   source. Aucune migration n'est donc nécessaire — ce qui compte ici :
   la fonction doit marcher au redémarrage, sans commande à taper.

   ═══════════════════════════════════════════════════════════════════════
   L'AGENT L'EMPORTE TOUJOURS SUR SNMP, ET CE N'EST PAS NÉGOCIABLE

   Un agent installé sait strictement plus : la version et l'éditeur de
   chaque logiciel, et surtout SOUS QUEL COMPTE tourne chaque programme —
   trois informations que SNMP ne donne jamais.

   Si un scan écrasait l'inventaire d'un agent par le sien, la fiche
   perdrait ces colonnes à chaque passage du scan, pour les retrouver au
   prochain envoi de l'agent. Elles clignoteraient. Pire : personne ne
   comprendrait pourquoi, puisque les deux sources sont justes.

   Une machine équipée d'un agent est donc laissée tranquille.
   ═══════════════════════════════════════════════════════════════════════ */

/** Le collecteur inscrit dans `agent_poste_version` pour la voie SNMP. */
const SOURCE_SNMP = "snmp";
/** Idem pour la voie WMI — les postes Windows, sans agent. */
const SOURCE_WMI = "wmi";

/**
 * QUI L'EMPORTE SUR QUI, ET POURQUOI CET ORDRE-LÀ.
 *
 * Trois sources peuvent décrire l'intérieur d'une même machine. Elles ne
 * savent pas la même chose, et laisser la dernière arrivée écraser les
 * autres ferait clignoter la fiche au rythme des scans.
 *
 *   agent (3) — le seul à savoir SOUS QUEL COMPTE tourne chaque
 *               programme, et à donner version et éditeur exacts. Il est
 *               installé sur la machine : rien ne voit mieux.
 *   wmi   (2) — donne les programmes, et les logiciels avec leur version
 *               et leur éditeur quand WinRM répond. Ne dit pas le compte.
 *   snmp  (1) — donne les programmes et le nom des logiciels, sans
 *               version, sans éditeur, sans compte.
 *
 * Une source ne remplace donc que ce qui en sait autant ou moins
 * qu'elle. Une machine équipée d'un agent est laissée tranquille par les
 * deux autres ; une machine lue par WMI n'est pas dégradée par SNMP au
 * scan suivant.
 */
const RANGS = { [SOURCE_SNMP]: 1, [SOURCE_WMI]: 2 };
function rangSource(source) {
  // Tout ce qui n'est ni « snmp » ni « wmi » est un numéro de version
  // d'agent : c'est donc un agent, et il l'emporte sur tout.
  if (!source) return 0;
  return RANGS[source] ?? 3;
}

/**
 * Écrit les logiciels vus à distance — par SNMP ou par WMI.
 *
 * POURQUOI CETTE FONCTION N'EST PAS `enregistrerLogiciels`.
 *
 * L'écriture de l'agent s'appuie sur la clé unique
 * (id_equipement, nom, version) pour ne pas créer de doublon. Mais en
 * MySQL, une clé UNIQUE dont une colonne vaut NULL n'empêche PAS les
 * doublons : deux lignes (« Firefox », NULL) sont tenues pour
 * distinctes. Or SNMP ne donne JAMAIS de version, et WMI n'en donne pas
 * toujours.
 *
 * Passer par l'écriture de l'agent aurait donc ajouté la liste complète
 * des logiciels À CHAQUE SCAN, et la fiche aurait montré le même
 * logiciel dix fois au bout d'une semaine — sans qu'aucune erreur ne
 * soit levée nulle part.
 *
 * On lit donc ce qui est déjà là, et on n'insère que ce qui manque. Deux
 * requêtes de plus, payées uniquement sur les machines qui répondent.
 */
async function enregistrerLogicielsSnmp(idEquipement, logiciels) {
  if (!Array.isArray(logiciels) || logiciels.length === 0) return 0;

  const [existants] = await db.query(
    "SELECT nom, version FROM LOGICIEL_INSTALLE WHERE id_equipement = ?",
    [idEquipement]
  );

  /* La comparaison porte sur le COUPLE nom + version, pas sur le nom
     seul : un logiciel mis à jour est une ligne nouvelle, et c'est ce
     qui permet de lire « Firefox 128 vu en août, Firefox 133 depuis
     septembre ». Comparer sur le nom seul aurait figé la version du
     premier relevé pour toujours. */
  const cle = (l) => `${String(l.nom).toLowerCase()} ${l.version ?? ""}`;
  const deja = new Set(existants.map(cle));

  const nouveaux = [];
  const revus = [];
  for (const l of logiciels) {
    if (!l?.nom) continue;
    (deja.has(cle(l)) ? revus : nouveaux).push(l);
  }

  if (nouveaux.length > 0) {
    const TAILLE_LOT = 100;
    for (let i = 0; i < nouveaux.length; i += TAILLE_LOT) {
      const lot = nouveaux.slice(i, i + TAILLE_LOT);
      await db.query(
        `INSERT INTO LOGICIEL_INSTALLE (id_equipement, nom, version, editeur)
         VALUES ${lot.map(() => "(?, ?, ?, ?)").join(", ")}`,
        lot.flatMap((l) => [
          idEquipement,
          String(l.nom).slice(0, 200),
          l.version ? String(l.version).slice(0, 80) : null,
          l.editeur ? String(l.editeur).slice(0, 150) : null,
        ])
      );
    }
  }

  // Ceux qui existaient déjà ont été REVUS : c'est ce couple
  // premiere_vue / derniere_vue qui répond à « depuis quand ce logiciel
  // est-il là, et y est-il encore ? ».
  if (revus.length > 0) {
    const TAILLE_LOT = 200;
    for (let i = 0; i < revus.length; i += TAILLE_LOT) {
      const lot = revus.slice(i, i + TAILLE_LOT);
      await db.query(
        `UPDATE LOGICIEL_INSTALLE SET derniere_vue = NOW()
         WHERE id_equipement = ? AND nom IN (${lot.map(() => "?").join(",")})`,
        [idEquipement, ...lot.map((l) => String(l.nom).slice(0, 200))]
      );
    }
  }

  return logiciels.length;
}

/**
 * Enregistre ce qu'un relevé à distance a vu tourner sur une machine.
 *
 * @param {number} idEquipement
 * @param {{processus: Array|null, logiciels: Array|null}} releve
 * @param {string} [source] `snmp` ou `wmi` — voir RANGS
 * @returns {Promise<{ecrit: boolean, raison?: string, processus?: number, logiciels?: number}>}
 */
/* ═══════════════════════════════════════════════════════════════════════
   LA SANTÉ DU POSTE — CE QU'UN INVENTAIRE NE DIT PAS.

   Savoir quels logiciels sont installés ne dit pas si la machine va
   bien. Quatre chiffres le disent : la mémoire qui reste, l'espace
   disque qui reste, depuis quand la machine n'a pas redémarré, et l'état
   des trois services qui la protègent.

   LES CONCURRENTS OBTIENNENT ÇA EN INSTALLANT UN AGENT SUR CHAQUE POSTE.
   Ici, la même voie WMI qui lit déjà les programmes en cours les rapporte
   sans que rien ne soit installé ni ouvert sur les postes.

   UNE SEULE LIGNE PAR ÉQUIPEMENT, remplacée à chaque relevé. Ce n'est pas
   un historique : c'est un état, daté. L'historique de la charge existe
   déjà, dans RELEVE, et pour les machines qui l'exposent.

   TOUT VOLET ABSENT RESTE ABSENT. Un poste interrogé par DCOM peut donner
   sa mémoire sans donner ses disques : on écrit ce qu'on a et on laisse
   le reste à NULL, jamais à zéro — « 0 Go libres » serait une alerte, et
   une fausse.
   ═══════════════════════════════════════════════════════════════════════ */
async function enregistrerSantePoste(idEquipement, sante, source) {
  if (!sante) return false;

  const entier = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const liste = (v) => (Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null);

  try {
    await db.query(
      `INSERT INTO SANTE_POSTE
         (id_equipement, date_releve, source, memoire_totale_mo, memoire_libre_mo,
          dernier_demarrage, disques, services, antivirus)
       VALUES (?, NOW(), ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         date_releve       = VALUES(date_releve),
         source            = VALUES(source),
         memoire_totale_mo = COALESCE(VALUES(memoire_totale_mo), memoire_totale_mo),
         memoire_libre_mo  = COALESCE(VALUES(memoire_libre_mo),  memoire_libre_mo),
         dernier_demarrage = COALESCE(VALUES(dernier_demarrage), dernier_demarrage),
         disques           = COALESCE(VALUES(disques),   disques),
         services          = COALESCE(VALUES(services),  services),
         antivirus         = COALESCE(VALUES(antivirus), antivirus)`,
      [
        idEquipement,
        source,
        entier(sante.memoire_totale_mo),
        entier(sante.memoire_libre_mo),
        sante.dernier_demarrage || null,
        liste(sante.disques),
        liste(sante.services),
        liste(sante.antivirus),
      ]
    );
    return true;
  } catch (err) {
    /* LA TABLE PEUT NE PAS EXISTER, et ce n'est pas une panne : une base
       qui n'a pas encore reçu la migration du 25/09 doit continuer à
       scanner et à inventorier normalement. On le dit une fois, au lieu
       de faire échouer la lecture du poste. */
    if (!santeAbsenteSignalee) {
      santeAbsenteSignalee = true;
      console.warn(
        "Santé des postes non enregistrée : " +
          err.message +
          "\n   Si la table SANTE_POSTE manque, appliquez la migration " +
          "2026-09-25-sante-poste.sql (node tools/appliquer-migrations.js)."
      );
    }
    return false;
  }
}

/** L'avertissement ci-dessus ne part qu'une fois par démarrage. */
let santeAbsenteSignalee = false;

async function enregistrerInventaireSnmp(idEquipement, releve, source = SOURCE_SNMP) {
  const { processus, logiciels } = releve || {};

  // Ni l'un ni l'autre : cette machine n'a rien dit. Rien à écrire, et
  // surtout rien à effacer — voir la note sur `null` dans
  // snmpInventaireLogiciel.
  const { sante } = releve || {};

  // Ni l'un ni l'autre : cette machine n'a rien dit. La santé compte
  // désormais comme une réponse à part entière — un poste peut donner sa
  // mémoire et ses disques sans qu'on ait pu lire ses logiciels.
  if (!processus && !logiciels && !sante) return { ecrit: false, raison: "aucune_reponse" };

  const [[etat]] = await db.query(
    "SELECT agent_poste_version FROM EQUIPEMENT WHERE id_equipement = ?",
    [idEquipement]
  );

  // Une source qui en sait plus est déjà passée : on ne la dégrade pas.
  // Voir RANGS pour l'ordre et sa justification.
  if (etat && rangSource(etat.agent_poste_version) > rangSource(source)) {
    return {
      ecrit: false,
      raison: rangSource(etat.agent_poste_version) === 3 ? "agent_prioritaire" : "source_meilleure",
    };
  }

  const nbProcessus = processus ? await remplacerProcessus(idEquipement, processus) : 0;

  /* Les logiciels passent par la même écriture prudente quelle que soit
     la source : WMI donne la version, SNMP non, et la clé unique de
     LOGICIEL_INSTALLE porte sur (équipement, nom, version). En MySQL,
     une clé unique dont une colonne vaut NULL n'empêche PAS les
     doublons — sans cette précaution, la liste doublerait à chaque scan
     sur les machines lues en SNMP. */
  const nbLogiciels = logiciels ? await enregistrerLogicielsSnmp(idEquipement, logiciels) : 0;

  const santeEcrite = sante ? await enregistrerSantePoste(idEquipement, sante, source) : false;

  await db.query(
    `UPDATE EQUIPEMENT
        SET dernier_inventaire_poste = NOW(),
            agent_poste_version = ?
      WHERE id_equipement = ?`,
    [source, idEquipement]
  );

  /* CE QU'ON NE FAIT PAS ICI, ET POURQUOI.

     `recevoirInventaire` pose une preuve d'existence « agent_poste » :
     il a fallu qu'une machine réelle exécute du code, c'est la preuve la
     plus forte dont dispose la plateforme.

     Une réponse SNMP n'est pas de cette nature, et le scan a DÉJÀ posé
     la preuve qui convient (« réponse SNMP ») quelques lignes plus tôt.
     La réécrire ici ne ferait que la dupliquer, et prétendre qu'un agent
     est installé là où il n'y en a pas. */

  return { ecrit: true, processus: nbProcessus, logiciels: nbLogiciels, sante: santeEcrite };
}

/** Ce qu'on sait de l'intérieur d'une machine, et depuis quand. */
async function inventaireDeLEquipement(idEquipement) {
  const [[equipement]] = await db.query(
    `SELECT dernier_inventaire_poste, agent_poste_version
     FROM EQUIPEMENT WHERE id_equipement = ?`,
    [idEquipement]
  );

  /* Rien du tout : on le DIT. Une fiche vide sans ce message se lirait
     comme « cette machine ne fait tourner aucun logiciel ».

     L'EXPLICATION A ÉTÉ CORRIGÉE, ET C'ÉTAIT NÉCESSAIRE. Elle affirmait
     que l'intérieur d'une machine « n'est pas observable depuis le
     réseau, quel que soit l'outil ». C'était faux depuis toujours :
     HOST-RESOURCES-MIB expose les programmes en cours, et le scan lisait
     déjà cette MIB pour la mémoire. Une plateforme vendue ne doit pas
     affirmer une impossibilité qu'elle-même dément. */
  if (!equipement || !equipement.dernier_inventaire_poste) {
    return {
      observe: false,
      source: null,
      agent_installe: false,
      explication:
        "cette machine n'a rien remonté de son intérieur. Le scan interroge " +
        "pourtant trois portes sans rien installer : SNMP, puis WMI sur les " +
        "postes Windows, et enfin l'agent s'il est présent. Aucune n'a répondu — " +
        "soit la machine était éteinte au dernier scan, soit ces trois portes " +
        "sont fermées sur elle",
      logiciels: [],
      processus: [],
    };
  }

  const [logiciels] = await db.query(
    `SELECT nom, version, editeur, date_installation, premiere_vue, derniere_vue
     FROM LOGICIEL_INSTALLE WHERE id_equipement = ? ORDER BY nom`,
    [idEquipement]
  );
  const [processus] = await db.query(
    `SELECT nom, occurrences, memoire_ko, utilisateur, date_releve
     FROM PROCESSUS_OBSERVE WHERE id_equipement = ?
     ORDER BY memoire_ko DESC, nom`,
    [idEquipement]
  );

  /* Lue à part, et sans jamais faire échouer la fiche : une base sans la
     table rend simplement `null`, que l'interface traite comme « pas
     encore relevé ». */
  let sante = null;
  try {
    const [[ligne]] = await db.query(
      `SELECT date_releve, source, memoire_totale_mo, memoire_libre_mo,
              dernier_demarrage, disques, services, antivirus
         FROM SANTE_POSTE WHERE id_equipement = ?`,
      [idEquipement]
    );
    if (ligne) {
      /* Selon la version de MySQL et du pilote, une colonne JSON revient
         déjà analysée ou sous forme de texte. On accepte les deux. */
      const lire = (v) => {
        if (!v) return null;
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      };
      sante = {
        ...ligne,
        disques: lire(ligne.disques),
        services: lire(ligne.services),
        antivirus: lire(ligne.antivirus),
      };
    }
  } catch {
    sante = null; // table absente : voir enregistrerSantePoste
  }

  const collecteur = equipement.agent_poste_version;
  const source =
    collecteur === SOURCE_SNMP ? "snmp" : collecteur === SOURCE_WMI ? "wmi" : "agent";

  /* CE QUE CHAQUE SOURCE NE SAIT PAS, dit par le serveur et non recopié
     dans l'interface : la règle vit là où elle est appliquée, sinon les
     deux finissent par se contredire.

     Ce n'est pas une précaution de façade. Deux machines lues
     différemment affichent des colonnes différemment remplies, et sans
     cette mention un client comparant les deux fiches conclurait à une
     incohérence du produit — alors que les deux relevés sont justes. */
  const LIMITES = {
    snmp: [
      "relevé par SNMP, sans rien installer sur la machine",
      "SNMP ne donne ni la version ni l'éditeur des logiciels",
      "SNMP ne dit pas sous quel compte tourne un programme",
    ],
    wmi: [
      "relevé par WMI, sans rien installer sur la machine",
      "WMI ne dit pas sous quel compte tourne un programme",
      "les logiciels installés ne remontent que par WinRM, pas par DCOM",
    ],
    agent: null,
  };

  return {
    observe: true,
    source,
    // `agent_installe` garde son sens D'ORIGINE — un agent est réellement
    // installé — et ne devient pas « on sait des choses ». Un écran qui
    // proposerait d'installer l'agent là où il tourne déjà serait une
    // régression, et c'est ce que valait le raccourci inverse.
    agent_installe: source === "agent",
    dernier_inventaire: equipement.dernier_inventaire_poste,
    agent_version: source === "agent" ? collecteur : null,
    limites: LIMITES[source],
    sante,
    logiciels,
    processus,
  };
}

module.exports = {
  enregistrerRelevePoste,
  recevoirInventaire,
  inventaireDeLEquipement,
  trouverOuCreerEquipement,
  enregistrerLogiciels,
  remplacerProcessus,
  // Relevés à distance — sans agent. Voir l'en-tête du bloc correspondant.
  enregistrerInventaireSnmp,
  enregistrerLogicielsSnmp,
  enregistrerSantePoste,
  SOURCE_SNMP,
  SOURCE_WMI,
  rangSource,
};
