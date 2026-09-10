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
    `UPDATE EQUIPEMENT
        SET dernier_inventaire_poste = NOW(),
            agent_poste_version = ?,
            nom = COALESCE(nom, ?),
            os_detecte = COALESCE(?, os_detecte),
            statut = 'up',
            echecs_consecutifs = 0
      WHERE id_equipement = ?`,
    [
      corps.agent_version ? String(corps.agent_version).slice(0, 20) : null,
      corps.nom_machine || null,
      corps.systeme || null,
      idEquipement,
    ]
  );

  return { id_equipement: idEquipement, logiciels: nbLogiciels, processus: nbProcessus };
}

/** Ce qu'on sait de l'intérieur d'une machine, et depuis quand. */
async function inventaireDeLEquipement(idEquipement) {
  const [[equipement]] = await db.query(
    `SELECT dernier_inventaire_poste, agent_poste_version
     FROM EQUIPEMENT WHERE id_equipement = ?`,
    [idEquipement]
  );

  // Aucun agent : on le DIT. Une fiche vide sans ce message se lirait
  // comme « cette machine ne fait tourner aucun logiciel ».
  if (!equipement || !equipement.dernier_inventaire_poste) {
    return {
      agent_installe: false,
      explication:
        "aucun agent de poste n'est installé sur cette machine : son intérieur " +
        "n'est pas observable depuis le réseau, quel que soit l'outil",
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

  return {
    agent_installe: true,
    dernier_inventaire: equipement.dernier_inventaire_poste,
    agent_version: equipement.agent_poste_version,
    logiciels,
    processus,
  };
}

module.exports = {
  recevoirInventaire,
  inventaireDeLEquipement,
  trouverOuCreerEquipement,
  enregistrerLogiciels,
  remplacerProcessus,
};
