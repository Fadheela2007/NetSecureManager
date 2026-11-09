/**
 * middleware/porteeSite.js
 *
 * Cloisonnement des données par site.
 *
 * CONVENTION (identique à celle de notificationService.getDestinataires) :
 *   - UTILISATEUR.id_site = NULL  -> utilisateur GLOBAL, voit tous les sites
 *   - UTILISATEUR.id_site = <n>   -> utilisateur RATTACHÉ, ne voit que le site n
 *
 * La portée vient du JWT (`req.user.id_site`), signé par le serveur : elle ne
 * peut pas être manipulée par le client. Tout le filtrage se fait donc côté
 * serveur, jamais côté frontend.
 *
 * Le rôle et la portée sont deux axes indépendants : un admin rattaché au
 * site 2 est administrateur DU SITE 2, pas de la plateforme. Pour un
 * administrateur de plateforme, laisser id_site à NULL.
 */

const db = require("../db");

/** Renvoie l'id_site auquel l'utilisateur est limité, ou null s'il est global. */
function porteeDe(req) {
  const valeur = req.user?.id_site;
  return valeur === undefined || valeur === null ? null : Number(valeur);
}

/**
 * Fragment SQL à injecter dans un WHERE, avec ses paramètres.
 *
 * Le motif `(? IS NULL OR colonne = ?)` évite de construire deux requêtes
 * distinctes : quand la portée est NULL (utilisateur global), la condition est
 * toujours vraie.
 *
 * @param {string} colonne - colonne qualifiée, ex. "e.id_site"
 * @returns {{ clause: string, params: [number|null, number|null] }}
 */
function clauseSite(req, colonne = "e.id_site") {
  const portee = porteeDe(req);
  return {
    clause: `(? IS NULL OR ${colonne} = ?)`,
    params: [portee, portee],
  };
}

/**
 * Le filtre complet : le PÉRIMÈTRE de l'utilisateur, ET le site qu'il a
 * choisi à l'écran.
 *
 * ── LE DÉFAUT QUE ÇA CORRIGE ──
 *
 * `clauseSite` ne lit que le jeton. Les routes qui s'en contentaient
 * ignoraient donc le `id_site` passé en paramètre : pour un administrateur
 * global, le tableau de bord affichait « 44 équipements » pour le site
 * choisi, et juste à côté les alertes et les courbes de TOUS les sites.
 * Le trait de référence « parc : 180 » surplombait une carte annonçant 44
 * équipements — deux chiffres contradictoires sur le même écran, sans un
 * mot pour dire qu'ils ne comptaient pas la même chose.
 *
 * ── LES DEUX CONDITIONS SE CUMULENT, ELLES NE SE REMPLACENT PAS ──
 *
 * Le périmètre du jeton reste appliqué en plus du site demandé. Un
 * utilisateur rattaché au site 2 qui réclame le site 1 obtient donc un
 * résultat VIDE, jamais les données du site 1 : le choix d'écran peut
 * seulement RESTREINDRE ce que le jeton autorise. C'est la règle qui
 * empêche un paramètre d'URL de devenir une élévation de privilège.
 *
 * @param {string} colonne - colonne qualifiée, ex. "e.id_site"
 */
function filtreSite(req, colonne = "e.id_site") {
  const portee = porteeDe(req);

  const demande = Number(req.query?.id_site);
  const choisi = Number.isInteger(demande) && demande > 0 ? demande : null;

  return {
    clause: `(? IS NULL OR ${colonne} = ?) AND (? IS NULL OR ${colonne} = ?)`,
    params: [portee, portee, choisi, choisi],
  };
}

/** L'utilisateur a-t-il le droit d'agir sur ce site ? */
function siteAutorise(req, idSite) {
  const portee = porteeDe(req);
  if (portee === null) return true;
  return Number(idSite) === portee;
}


/**
 * Vérifie qu'un équipement appartient au périmètre de l'utilisateur.
 * Renvoie { ok: true } ou { ok: false, statut, erreur }.
 *
 * On répond 404 et non 403 quand l'équipement existe mais hors périmètre :
 * un 403 confirmerait son existence à quelqu'un qui n'a pas à le savoir.
 */
async function verifierAccesEquipement(req, idEquipement) {
  const portee = porteeDe(req);
  const [rows] = await db.query(
    "SELECT id_site FROM EQUIPEMENT WHERE id_equipement = ?",
    [idEquipement]
  );
  if (rows.length === 0) {
    return { ok: false, statut: 404, erreur: "Équipement introuvable" };
  }
  if (portee !== null && rows[0].id_site !== portee) {
    return { ok: false, statut: 404, erreur: "Équipement introuvable" };
  }
  return { ok: true, idSite: rows[0].id_site };
}

/**
 * Vérifie qu'une alerte est dans le périmètre.
 * Une alerte peut être rattachée à un équipement OU directement à un site
 * (alertes d'agent muet) : on retient le premier des deux renseigné.
 */
async function verifierAccesAlerte(req, idAlerte) {
  const portee = porteeDe(req);
  const [rows] = await db.query(
    `SELECT COALESCE(a.id_site, e.id_site) AS id_site
     FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE a.id_alerte = ?`,
    [idAlerte]
  );
  if (rows.length === 0) {
    return { ok: false, statut: 404, erreur: "Alerte introuvable" };
  }
  if (portee !== null && rows[0].id_site !== portee) {
    return { ok: false, statut: 404, erreur: "Alerte introuvable" };
  }
  return { ok: true };
}

/** Idem pour un incident, via l'alerte dont il découle. */
async function verifierAccesIncident(req, idIncident) {
  const portee = porteeDe(req);
  const [rows] = await db.query(
    `SELECT COALESCE(a.id_site, e.id_site) AS id_site
     FROM INCIDENT i
     JOIN ALERTE a ON a.id_alerte = i.id_alerte
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE i.id_incident = ?`,
    [idIncident]
  );
  if (rows.length === 0) {
    return { ok: false, statut: 404, erreur: "Incident introuvable" };
  }
  if (portee !== null && rows[0].id_site !== portee) {
    return { ok: false, statut: 404, erreur: "Incident introuvable" };
  }
  return { ok: true };
}

module.exports = {
  porteeDe,
  clauseSite,
  filtreSite,
  siteAutorise,
  verifierAccesEquipement,
  verifierAccesAlerte,
  verifierAccesIncident,
};
