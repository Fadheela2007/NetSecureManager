/**
 * services/journal.js
 * Écriture d'une trace dans LOG_ACTIVITE.
 *
 * POURQUOI CE MODULE EXISTE.
 *
 * L'écriture du journal vivait dans une fonction locale à routes/scan.js,
 * recopiée à l'identique dans routes/sites.js et routes/reinitialisation.js.
 * Trois copies, et surtout : les fichiers qui ne l'avaient pas recopiée
 * n'écrivaient RIEN. Création, modification et suppression de comptes,
 * rotation d'un jeton d'agent, changement d'un seuil de supervision —
 * exactement les actions qu'un audit vient vérifier — ne laissaient aucune
 * trace, alors que la plateforme affiche un écran « Journal d'activité ».
 *
 * UNE TRACE NE DOIT JAMAIS FAIRE ÉCHOUER L'ACTION QU'ELLE DOCUMENTE.
 * Un journal indisponible est un problème d'exploitation ; refuser une
 * suppression de compte pour cette raison en serait un plus grave. Toute
 * erreur est donc journalisée en console et avalée.
 */
const db = require("../db");

/**
 * @param {object} req      requête Express (pour l'auteur et son adresse)
 * @param {string} action   verbe court et stable, ex. "utilisateur_cree"
 * @param {string} description phrase lisible par un humain
 */
async function tracer(req, action, description) {
  try {
    await db.query(
      `INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur)
       VALUES (?, ?, ?, ?)`,
      // `req.user.id` — le nom porté par le jeton. Écrire `req.utilisateur`
      // produirait une trace anonyme sans lever d'erreur : le pire des deux
      // mondes, et un défaut déjà rencontré sur ce projet.
      [req?.user?.id ?? null, action, String(description).slice(0, 60000), req?.ip ?? null]
    );
  } catch (err) {
    console.error(`Trace « ${action} » non écrite:`, err.message);
  }
}

module.exports = { tracer };
