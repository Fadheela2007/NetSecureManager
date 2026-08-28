/**
 * notificationService.js
 * Envoi des alertes par e-mail (Nodemailer).
 *
 * Dépendances : npm install nodemailer axios
 * Variables d'environnement (.env) :
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, ALERT_EMAIL_FROM
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI PAS DE WHATSAPP
 *
 * Un envoi WhatsApp a existé ici, et a été retiré volontairement.
 *
 * Meta n'autorise le texte libre que pendant 24 heures après qu'une
 * personne a écrit au numéro de l'entreprise. Au-delà, tout message
 * émis par l'entreprise doit passer par un MODÈLE pré-approuvé.
 *
 * Or une alerte de supervision est exactement le cas interdit : elle
 * part à trois heures du matin, sans que personne n'ait rien écrit. Le
 * code fonctionnait en démonstration préparée et aurait été rejeté en
 * exploitation réelle — la pire des situations pour un outil vendu
 * comme dispositif d'alerte.
 *
 * Le rétablir demande : un compte Meta Business vérifié, un modèle de
 * catégorie Utility approuvé, et un jeton permanent d'utilisateur
 * système. C'est un travail de déploiement autant que de code, à mener
 * quand un client le demandera vraiment.
 * ─────────────────────────────────────────────────────────────────────
 *
 * IMPORTANT — ces fonctions ne doivent PAS être attendues (await) depuis le
 * cycle de supervision : un SMTP lent ou en échec ferait déborder le cycle
 * cron d'une minute. Utiliser notifierAlerte() en « fire and forget ».
 */

const nodemailer = require("nodemailer");
const axios = require("axios");
const db = require("../db");

// Sans ces timeouts, un SMTP injoignable peut bloquer jusqu'à 2 minutes
// (valeur par défaut de nodemailer) sur un seul envoi.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

/**
 * Journalisation limitée : un incident SMTP touche chaque destinataire de
 * chaque alerte, ce qui noie le journal sous des milliers de lignes
 * identiques. On n'écrit qu'une ligne par minute et par canal, en indiquant
 * combien d'occurrences ont été regroupées.
 */
const INTERVALLE_LOG_MS = 60000;
const dernierLog = new Map(); // canal -> { timestamp, supprimees, message }

function journaliserLimite(canal, message) {
  const maintenant = Date.now();
  const etat = dernierLog.get(canal);

  if (!etat || maintenant - etat.timestamp >= INTERVALLE_LOG_MS) {
    const suffixe =
      etat && etat.supprimees > 0
        ? ` (+${etat.supprimees} erreur(s) similaire(s) dans la minute précédente)`
        : "";
    console.error(`Erreur envoi ${canal}: ${message}${suffixe}`);
    dernierLog.set(canal, { timestamp: maintenant, supprimees: 0, message });
  } else {
    etat.supprimees++;
  }
}

/**
 * Trace chaque tentative d'envoi en base (table NOTIFICATION), qu'elle
 * réussisse ou échoue. Permet de savoir a posteriori quelles alertes ont
 * réellement été notifiées, à qui, et pourquoi un envoi a échoué
 * (quota dépassé, identifiants refusés, serveur injoignable...).
 *
 * N'échoue jamais : une erreur de traçage ne doit pas empêcher la notification.
 */
async function tracerNotification({ idAlerte, idUtilisateur, canal, destinataire, statut, erreur }) {
  try {
    await db.query(
      `INSERT INTO NOTIFICATION (id_alerte, id_utilisateur, canal, destinataire, statut, erreur)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [idAlerte || null, idUtilisateur || null, canal, destinataire || null, statut, erreur || null]
    );
  } catch (err) {
    console.error("Erreur de traçage de notification:", err.message);
  }
}

async function getDestinataires(idSite) {
  const [rows] = await db.query(
    `SELECT id_utilisateur, email FROM UTILISATEUR
     WHERE role IN ('admin','operateur') AND (id_site = ? OR id_site IS NULL)`,
    [idSite]
  );
  return rows;
}

async function envoyerEmails(equipement, message, destinataires, idAlerte) {
  // Rien à faire si le SMTP n'est pas configuré : inutile d'échouer 1 fois par
  // destinataire pour l'apprendre.
  if (!process.env.SMTP_HOST) return;

  for (const user of destinataires) {
    if (!user.email) continue;
    try {
      await transporter.sendMail({
        from: process.env.ALERT_EMAIL_FROM,
        to: user.email,
        subject: `[NetSecureManager] Alerte - ${equipement.nom || equipement.adresse_ip}`,
        text: message,
      });
      await tracerNotification({
        idAlerte,
        idUtilisateur: user.id_utilisateur,
        canal: "email",
        destinataire: user.email,
        statut: "envoye",
      });
    } catch (err) {
      journaliserLimite("e-mail", err.message);
      await tracerNotification({
        idAlerte,
        idUtilisateur: user.id_utilisateur,
        canal: "email",
        destinataire: user.email,
        statut: "echec",
        erreur: err.message,
      });
    }
  }
}


// =====================================================================
// File d'attente : regroupement + limitation de débit + coupe-circuit
//
// Lors des tests, une panne simultanée de plusieurs équipements a provoqué
// une rafale d'e-mails qui a fait bloquer un compte Gmail ("Too many login
// attempts") puis saturer Mailtrap ("Too many emails per second", puis quota
// mensuel épuisé). Trois protections répondent chacune à un aspect :
//
//   1. REGROUPEMENT — les alertes sont mises en file et envoyées par lot au
//      bout de FENETRE_GROUPEMENT_MS. Dix équipements qui tombent ensemble
//      produisent UN e-mail récapitulatif, pas dix.
//   2. DÉBIT — au plus MAX_ENVOIS_PAR_FENETRE messages par minute et par
//      canal, tous destinataires confondus.
//   3. COUPE-CIRCUIT — après ECHECS_AVANT_COUPURE échecs consécutifs sur un
//      canal, ce canal est suspendu pendant DUREE_COUPURE_MS. Inutile de
//      marteler un serveur qui refuse systématiquement : c'est précisément ce
//      qui a fait verrouiller le compte Gmail.
// =====================================================================

const FENETRE_GROUPEMENT_MS = 20000; // délai d'attente avant envoi groupé
const MAX_ENVOIS_PAR_FENETRE = 10;   // messages / minute / canal
const FENETRE_DEBIT_MS = 60000;
const ECHECS_AVANT_COUPURE = 5;
const DUREE_COUPURE_MS = 15 * 60000; // 15 minutes

// idSite -> { alertes: [...], minuteur }
const fileParSite = new Map();

// canal -> { envois: [timestamps], echecsConsecutifs, coupeJusqua }
const etatCanal = new Map();

function getEtatCanal(canal) {
  if (!etatCanal.has(canal)) {
    etatCanal.set(canal, { envois: [], echecsConsecutifs: 0, coupeJusqua: 0 });
  }
  return etatCanal.get(canal);
}

/** Le canal accepte-t-il un envoi maintenant ? */
function canalDisponible(canal) {
  const etat = getEtatCanal(canal);
  const maintenant = Date.now();

  if (etat.coupeJusqua > maintenant) return false;

  etat.envois = etat.envois.filter((t) => maintenant - t < FENETRE_DEBIT_MS);
  return etat.envois.length < MAX_ENVOIS_PAR_FENETRE;
}

function enregistrerEnvoi(canal, succes) {
  const etat = getEtatCanal(canal);
  etat.envois.push(Date.now());

  if (succes) {
    etat.echecsConsecutifs = 0;
    return;
  }

  etat.echecsConsecutifs++;
  if (etat.echecsConsecutifs >= ECHECS_AVANT_COUPURE) {
    etat.coupeJusqua = Date.now() + DUREE_COUPURE_MS;
    etat.echecsConsecutifs = 0;
    console.warn(
      `Canal ${canal} suspendu ${DUREE_COUPURE_MS / 60000} min après ` +
        `${ECHECS_AVANT_COUPURE} échecs consécutifs. Les alertes restent visibles dans l'interface.`
    );
  }
}

/** Compose le corps d'un récapitulatif à partir des alertes accumulées. */
function composerRecapitulatif(alertes) {
  if (alertes.length === 1) {
    return { sujet: alertes[0].titre, corps: alertes[0].message };
  }
  const lignes = alertes.map((a, i) => `${i + 1}. ${a.titre}\n   ${a.message}`);
  return {
    sujet: `${alertes.length} alertes en ${Math.round(FENETRE_GROUPEMENT_MS / 1000)} s`,
    corps:
      `${alertes.length} alertes ont été déclenchées sur ce site :\n\n` +
      lignes.join("\n\n") +
      `\n\nConsultez la plateforme pour le détail et les pistes de résolution.`,
  };
}

async function viderFile(idSite) {
  const entree = fileParSite.get(idSite);
  if (!entree || entree.alertes.length === 0) return;

  const alertes = entree.alertes.splice(0);
  fileParSite.delete(idSite);

  try {
    const destinataires = await getDestinataires(idSite);
    if (destinataires.length === 0) return;

    const { sujet, corps } = composerRecapitulatif(alertes);
    // Une trace par alerte serait redondante : on rattache le récapitulatif
    // à la première alerte du lot.
    const idAlerte = alertes[0].idAlerte;
    const pseudoEquipement = { id_site: idSite, nom: sujet, adresse_ip: "" };

    const taches = [];

    if (canalDisponible("email")) {
      taches.push(
        envoyerEmails(pseudoEquipement, corps, destinataires, idAlerte)
          .then(() => enregistrerEnvoi("email", true))
          .catch(() => enregistrerEnvoi("email", false))
      );
    } else {
      journaliserLimite("e-mail", `envoi différé/ignoré (débit ou coupe-circuit) — ${alertes.length} alerte(s)`);
    }

    await Promise.all(taches);
  } catch (err) {
    journaliserLimite("notification", err.message);
  }
}

/**
 * Met une alerte en file d'attente pour notification.
 *
 * À appeler SANS await depuis le cycle de supervision : la fonction ne rejette
 * jamais et rend la main immédiatement. L'envoi réel a lieu au plus tard
 * FENETRE_GROUPEMENT_MS plus tard, hors du cycle.
 *
 * idAlerte est optionnel mais recommandé : il relie la trace d'envoi à
 * l'alerte concernée dans la table NOTIFICATION.
 */
async function notifierAlerte(equipement, message, idAlerte = null) {
  try {
    const idSite = equipement.id_site ?? 0;

    if (!fileParSite.has(idSite)) {
      fileParSite.set(idSite, { alertes: [], minuteur: null });
    }
    const entree = fileParSite.get(idSite);

    entree.alertes.push({
      titre: equipement.nom || equipement.adresse_ip || "Alerte",
      message,
      idAlerte,
    });

    if (!entree.minuteur) {
      entree.minuteur = setTimeout(() => {
        viderFile(idSite).catch(() => {});
      }, FENETRE_GROUPEMENT_MS);
      // Ne pas retenir le processus Node en vie uniquement pour ce minuteur.
      if (entree.minuteur.unref) entree.minuteur.unref();
    }
  } catch (err) {
    journaliserLimite("notification", err.message);
  }
}

// Conservées pour compatibilité : elles lisent chacune les destinataires.
// Préférer notifierAlerte().
async function sendEmailAlert(equipement, message, idAlerte = null) {
  const destinataires = await getDestinataires(equipement.id_site);
  await envoyerEmails(equipement, message, destinataires, idAlerte);
}

// =====================================================================
// Envoi des rapports planifiés
//
// ARTICULATION AVEC LA LIMITATION DES ALERTES — point explicitement
// demandé, et c'est le cœur du sujet.
//
// Les rapports utilisent un canal LOGIQUE distinct : "rapport". Il a donc
// son propre compteur de débit et son propre coupe-circuit dans
// `etatCanal`, alors que le transport SMTP reste le même.
//
// Trois conséquences, toutes voulues :
//
//   1. Un rapport ne consomme pas le quota des alertes. Un envoi
//      hebdomadaire vers 8 destinataires n'empêche pas une alerte
//      critique de partir dans la même minute.
//   2. Un rapport en échec ne suspend pas les alertes. Si le serveur mail
//      refuse une pièce jointe de 8 Mo cinq fois de suite, c'est le canal
//      "rapport" qui est suspendu — les alertes continuent.
//   3. Réciproquement, un coupe-circuit déclenché par les alertes ne
//      bloque pas le rapport hebdomadaire.
//
// Le plafond du canal rapport est volontairement bas : un rapport n'est
// pas urgent, et rien ne justifie d'en envoyer des dizaines par minute.
// =====================================================================

const MAX_RAPPORTS_PAR_FENETRE = 20;

/**
 * Envoie un rapport en pièce jointe à une liste de destinataires.
 *
 * Ne rejette jamais. Chaque envoi est tracé dans NOTIFICATION.
 *
 * @param {object} options
 * @param {Array<{id_utilisateur:number,email:string}>} options.destinataires
 * @param {string} options.sujet
 * @param {string} options.corps
 * @param {Buffer|null} options.piecesJointe   PDF, ou null si trop volumineux
 * @param {string} options.nomFichier
 * @returns {Promise<{envoyes:number, echecs:number, ignores:number}>}
 */
async function envoyerRapport({ destinataires, sujet, corps, piecesJointe, nomFichier }) {
  const bilan = { envoyes: 0, echecs: 0, ignores: 0 };

  if (!process.env.SMTP_HOST) {
    console.warn("Rapport planifié : SMTP_HOST absent, envoi ignoré.");
    bilan.ignores = destinataires.length;
    return bilan;
  }

  const etat = getEtatCanal("rapport");

  for (const user of destinataires) {
    if (!user.email) {
      bilan.ignores++;
      continue;
    }

    // Débit et coupe-circuit propres au canal "rapport".
    const maintenant = Date.now();
    etat.envois = etat.envois.filter((t) => maintenant - t < FENETRE_DEBIT_MS);
    if (etat.coupeJusqua > maintenant || etat.envois.length >= MAX_RAPPORTS_PAR_FENETRE) {
      journaliserLimite("rapport", `envoi différé (débit ou coupe-circuit) pour ${user.email}`);
      bilan.ignores++;
      continue;
    }

    try {
      await transporter.sendMail({
        from: process.env.ALERT_EMAIL_FROM,
        to: user.email,
        subject: sujet,
        text: corps,
        attachments: piecesJointe
          ? [{ filename: nomFichier, content: piecesJointe, contentType: "application/pdf" }]
          : [],
      });
      enregistrerEnvoi("rapport", true);
      bilan.envoyes++;
      await tracerRapport(user, "envoye", null);
    } catch (err) {
      journaliserLimite("rapport", err.message);
      enregistrerEnvoi("rapport", false);
      bilan.echecs++;
      await tracerRapport(user, "echec", err.message);
    }
  }

  return bilan;
}

/**
 * Trace un envoi de rapport dans NOTIFICATION.
 *
 * Le canal 'rapport' suppose que l'ENUM a été étendu (voir la migration).
 * Si ce n'est pas le cas, MySQL refuse la valeur : on retombe alors sur
 * 'email' pour ne pas perdre la trace. `id_alerte` reste NULL, ce qui
 * distingue de toute façon un rapport d'une notification d'alerte.
 */
async function tracerRapport(user, statut, erreur) {
  try {
    await db.query(
      `INSERT INTO NOTIFICATION (id_alerte, id_utilisateur, canal, destinataire, statut, erreur)
       VALUES (NULL, ?, 'rapport', ?, ?, ?)`,
      [user.id_utilisateur || null, user.email, statut, erreur]
    );
  } catch {
    try {
      await db.query(
        `INSERT INTO NOTIFICATION (id_alerte, id_utilisateur, canal, destinataire, statut, erreur)
         VALUES (NULL, ?, 'email', ?, ?, ?)`,
        [user.id_utilisateur || null, user.email, statut, erreur]
      );
    } catch (err2) {
      console.error("Traçage du rapport impossible:", err2.message);
    }
  }
}

/** Vide immédiatement toutes les files (utile aux tests et à l'arrêt propre). */
async function viderToutesLesFiles() {
  const sites = [...fileParSite.keys()];
  for (const idSite of sites) {
    const entree = fileParSite.get(idSite);
    if (entree?.minuteur) clearTimeout(entree.minuteur);
    await viderFile(idSite);
  }
}

module.exports = {
  notifierAlerte,
  sendEmailAlert,
  envoyerRapport,
  viderToutesLesFiles,
  // Exportés pour les tests et le diagnostic.
  _canalDisponible: canalDisponible,
  _enregistrerEnvoi: enregistrerEnvoi,
};