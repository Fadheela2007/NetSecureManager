/**
 * rapportPlanifieService.js
 * Envoi automatique du rapport PDF par e-mail, à fréquence configurable.
 *
 * Clés de CONFIGURATION :
 *   rapport_planifie_frequence  desactive | hebdomadaire | mensuel
 *   rapport_planifie_jour       1-7 (lundi=1) en hebdo, 1-28 en mensuel
 *   rapport_planifie_heure      0-23
 *   rapport_planifie_dernier_envoi   horodatage du dernier envoi (état)
 *
 * Défaut : `desactive`. On ne se met pas à écrire à des gens sans qu'ils
 * l'aient demandé.
 */

const db = require("../db");
const { envoyerRapport } = require("./notificationService");
const { collecterDonnees, genererPdfBuffer } = require("./rapportService");

/**
 * Taille maximale de la pièce jointe.
 *
 * 8 Mo : la plupart des serveurs SMTP plafonnent à 10 ou 25 Mo, et
 * l'encodage base64 des pièces jointes ajoute ~33 %. 8 Mo de PDF font donc
 * environ 10,7 Mo sur le fil — déjà à la limite de ce que certains
 * acceptent. Au-delà, on envoie le message SANS pièce jointe plutôt que de
 * provoquer un rejet : le destinataire est informé et peut télécharger le
 * rapport depuis l'interface.
 */
const TAILLE_MAX_PJ = 8 * 1024 * 1024;

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

let envoiEnCours = false;

async function lireConfig(cle, defaut) {
  const [rows] = await db.query("SELECT valeur FROM CONFIGURATION WHERE cle = ?", [cle]);
  return rows[0] ? String(rows[0].valeur) : defaut;
}

async function ecrireConfig(cle, valeur) {
  await db.query(
    `INSERT INTO CONFIGURATION (cle, valeur, description)
     VALUES (?, ?, 'Horodatage du dernier rapport planifié envoyé (géré par le serveur)')
     ON DUPLICATE KEY UPDATE valeur = VALUES(valeur)`,
    [cle, valeur]
  );
}

/**
 * Le moment présent correspond-il à la planification ?
 *
 * @param {Date} maintenant
 * @returns {Promise<{doitEnvoyer:boolean, raison:string}>}
 */
async function estLeMoment(maintenant = new Date()) {
  const frequence = (await lireConfig("rapport_planifie_frequence", "desactive")).toLowerCase();
  if (frequence === "desactive") {
    return { doitEnvoyer: false, raison: "planification désactivée" };
  }
  if (frequence !== "hebdomadaire" && frequence !== "mensuel") {
    return { doitEnvoyer: false, raison: `fréquence inconnue « ${frequence} »` };
  }

  const heureVoulue = Number(await lireConfig("rapport_planifie_heure", "8"));
  if (!Number.isInteger(heureVoulue) || heureVoulue < 0 || heureVoulue > 23) {
    return { doitEnvoyer: false, raison: "rapport_planifie_heure invalide" };
  }
  if (maintenant.getHours() !== heureVoulue) {
    return { doitEnvoyer: false, raison: "ce n'est pas l'heure" };
  }

  const jourVoulu = Number(await lireConfig("rapport_planifie_jour", "1"));

  if (frequence === "hebdomadaire") {
    // Convention ISO : lundi = 1, dimanche = 7. getDay() met dimanche à 0.
    const jourActuel = maintenant.getDay() === 0 ? 7 : maintenant.getDay();
    if (!Number.isInteger(jourVoulu) || jourVoulu < 1 || jourVoulu > 7) {
      return { doitEnvoyer: false, raison: "rapport_planifie_jour invalide (1-7 attendu)" };
    }
    if (jourActuel !== jourVoulu) return { doitEnvoyer: false, raison: "ce n'est pas le jour" };
  } else {
    // Mensuel : borné à 28 pour qu'un envoi prévu le 30 ne soit pas sauté
    // en février.
    if (!Number.isInteger(jourVoulu) || jourVoulu < 1 || jourVoulu > 28) {
      return { doitEnvoyer: false, raison: "rapport_planifie_jour invalide (1-28 attendu)" };
    }
    if (maintenant.getDate() !== jourVoulu) {
      return { doitEnvoyer: false, raison: "ce n'est pas le jour du mois" };
    }
  }

  // Idempotence : l'horodatage est en base et non en mémoire, sinon un
  // redémarrage du serveur pendant l'heure d'envoi provoquerait un doublon.
  const dernier = await lireConfig("rapport_planifie_dernier_envoi", "");
  if (dernier) {
    const d = new Date(dernier);
    if (!Number.isNaN(d.getTime()) && d.toDateString() === maintenant.toDateString()) {
      return { doitEnvoyer: false, raison: "déjà envoyé aujourd'hui" };
    }
  }

  return { doitEnvoyer: true, raison: "planification atteinte" };
}

/**
 * Regroupe les destinataires par PÉRIMÈTRE, pas par personne.
 *
 * Le rapport est coûteux à produire (plusieurs requêtes + génération PDF) :
 * on le génère une fois par périmètre et on l'envoie à tous ses
 * destinataires. Dix administrateurs globaux reçoivent le même document,
 * généré une seule fois.
 *
 * Convention identique à getDestinataires() : un utilisateur global
 * (id_site NULL) reçoit le rapport de tous les sites, un utilisateur
 * rattaché uniquement celui de son site.
 *
 * @returns {Promise<Map<number|null, Array>>} clé = portée (null = global)
 */
async function destinatairesParPerimetre() {
  const [rows] = await db.query(
    `SELECT id_utilisateur, nom, email, id_site
     FROM UTILISATEUR
     WHERE role IN ('admin','operateur')
       AND email IS NOT NULL AND email <> ''
     ORDER BY id_site, nom`
  );

  const groupes = new Map();
  for (const u of rows) {
    const cle = u.id_site === null || u.id_site === undefined ? null : Number(u.id_site);
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(u);
  }
  return groupes;
}

function libellePerimetre(portee, nomSite) {
  return portee === null ? "tous les sites" : nomSite || `site ${portee}`;
}

/**
 * Produit et envoie les rapports pour tous les périmètres ayant des
 * destinataires.
 *
 * @param {object} [options]
 * @param {boolean} [options.forcer=false] ignore la planification (test)
 * @returns {Promise<object>} bilan détaillé
 */
async function envoyerRapportsPlanifies({ forcer = false } = {}) {
  const bilan = { declenche: false, raison: "", perimetres: [], total_envoyes: 0 };

  if (!forcer) {
    const moment = await estLeMoment();
    bilan.raison = moment.raison;
    if (!moment.doitEnvoyer) return bilan;
  } else {
    bilan.raison = "envoi forcé";
  }
  bilan.declenche = true;

  const groupes = await destinatairesParPerimetre();
  const [sites] = await db.query("SELECT id_site, nom FROM SITE");
  const nomsSites = new Map(sites.map((s) => [Number(s.id_site), s.nom]));

  for (const [portee, destinataires] of groupes) {
    const etiquette = libellePerimetre(portee, nomsSites.get(portee));

    const donnees = await collecterDonnees({ portee });

    // RAPPORT VIDE — on n'envoie pas.
    //
    // Un rapport annonçant « 0 équipement supervisé » n'apporte aucune
    // information et apprend au destinataire à ignorer ces messages. Le jour
    // où le rapport contiendra quelque chose, il ne sera plus lu. Le cas se
    // présente pour un site créé mais pas encore scanné, ou un opérateur
    // rattaché à un site vide.
    if (donnees.equipements.length === 0) {
      bilan.perimetres.push({
        perimetre: etiquette,
        destinataires: destinataires.length,
        envoyes: 0,
        ignore: "aucun équipement — envoi inutile",
      });
      continue;
    }

    const pdf = await genererPdfBuffer(donnees, { titreSuffixe: etiquette });
    const tailleKo = Math.round(pdf.length / 1024);
    const tropVolumineux = pdf.length > TAILLE_MAX_PJ;

    const enLigne = donnees.equipements.filter((e) => e.statut === "up").length;
    const horsLigne = donnees.equipements.filter((e) => e.statut === "down").length;
    const actives = donnees.alertes.filter((a) => a.statut === "active").length;

    let corps =
      `Rapport de supervision NetSecureManager — ${etiquette}\n\n` +
      `Équipements supervisés : ${donnees.equipements.length}\n` +
      `En ligne : ${enLigne}   Hors ligne : ${horsLigne}\n` +
      `Alertes des 30 derniers jours : ${donnees.alertes.length} (dont ${actives} encore active(s))\n\n`;

    if (tropVolumineux) {
      corps +=
        `Le rapport détaillé pèse ${tailleKo} Ko, au-delà de la limite d'envoi. ` +
        `Il n'est pas joint à ce message : téléchargez-le depuis le tableau de bord ` +
        `de la plateforme (bouton « Export PDF »).\n`;
      console.warn(
        `Rapport planifié (${etiquette}) : ${tailleKo} Ko > limite, envoyé sans pièce jointe.`
      );
    } else {
      corps += `Le rapport complet est joint à ce message (PDF, ${tailleKo} Ko).\n`;
    }

    const resultat = await envoyerRapport({
      destinataires,
      sujet: `[NetSecureManager] Rapport de supervision — ${etiquette}`,
      corps,
      piecesJointe: tropVolumineux ? null : pdf,
      nomFichier: `rapport_netsecuremanager_${portee === null ? "global" : `site${portee}`}.pdf`,
    });

    bilan.total_envoyes += resultat.envoyes;
    bilan.perimetres.push({
      perimetre: etiquette,
      destinataires: destinataires.length,
      equipements: donnees.equipements.length,
      taille_ko: tailleKo,
      piece_jointe: !tropVolumineux,
      ...resultat,
    });
  }

  // Horodatage écrit même si rien n'a été envoyé : la planification a bien
  // été honorée pour aujourd'hui, il ne faut pas réessayer à chaque passage.
  if (!forcer) {
    await ecrireConfig("rapport_planifie_dernier_envoi", new Date().toISOString());
  }

  console.log(
    `Rapport planifié : ${bilan.total_envoyes} envoi(s) sur ${bilan.perimetres.length} périmètre(s).`
  );
  return bilan;
}

/** Passage horaire du planificateur, appelé par monitoringService.start(). */
async function passagePlanificateur() {
  if (envoiEnCours) return;
  envoiEnCours = true;
  try {
    await envoyerRapportsPlanifies();
  } catch (err) {
    console.error("Erreur du rapport planifié:", err.message);
  } finally {
    envoiEnCours = false;
  }
}

module.exports = {
  envoyerRapportsPlanifies,
  passagePlanificateur,
  estLeMoment,
  destinatairesParPerimetre,
  JOURS,
  TAILLE_MAX_PJ,
};
