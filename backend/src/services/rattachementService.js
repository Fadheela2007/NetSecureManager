/**
 * services/rattachementService.js
 *
 * RATTACHER UN POSTE SANS DIFFUSER LE SECRET DU SITE.
 *
 * Trois gestes, trois acteurs :
 *
 *   l'administrateur demande un code pour UN poste précis,
 *   la personne devant la machine lance l'installation avec ce code,
 *   la machine échange le code contre un jeton qui n'appartient qu'à elle.
 *
 * POURQUOI LE CODE EST COURT, ET POURQUOI CE N'EST PAS UNE FAIBLESSE.
 * Il est fait pour être lu à voix haute ou recopié à la main : c'est sa
 * raison d'être. Ce qui le protège n'est pas sa longueur, ce sont ses
 * trois limites — il vaut 30 minutes, il ne sert qu'UNE fois, et il ne
 * vaut que pour un seul poste. Un code volé après usage ne vaut rien, et
 * le jeton qu'il produit, lui, est long et aléatoire.
 *
 * L'alphabet exclut O, 0, I, 1 et L : ce sont les caractères que l'on
 * recopie de travers, et un code refusé pour cause de confusion visuelle
 * fait douter du produit, pas de la lecture.
 */

const crypto = require("crypto");
const db = require("../db");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DUREE_MINUTES = 30;

/** Code lisible : deux groupes de quatre, séparés par un tiret. */
function fabriquerCode() {
  let brut = "";
  for (let i = 0; i < 8; i += 1) {
    brut += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${brut.slice(0, 4)}-${brut.slice(4)}`;
}

/** Jeton du poste : long, aléatoire, jamais saisi à la main. */
function fabriquerJeton() {
  return crypto.randomBytes(32).toString("hex");
}

/* ── FREINER LES ESSAIS AU HASARD ─────────────────────────────────────
   Un code court se devine si on peut essayer sans fin. Le compteur vit
   en mémoire, par adresse : il ne survit pas à un redémarrage, et c'est
   assumé — comme pour la page de connexion, à l'échelle d'un serveur
   unique. Au-delà de dix échecs en dix minutes, l'adresse est écartée. */
const echecs = new Map();
const MAX_ECHECS = 10;
const FENETRE_MS = 10 * 60 * 1000;

function tropDEchecs(adresse) {
  const entree = echecs.get(adresse);
  if (!entree) return false;
  if (Date.now() - entree.depuis > FENETRE_MS) {
    echecs.delete(adresse);
    return false;
  }
  return entree.nombre >= MAX_ECHECS;
}

function noterEchec(adresse) {
  const entree = echecs.get(adresse);
  if (!entree || Date.now() - entree.depuis > FENETRE_MS) {
    echecs.set(adresse, { nombre: 1, depuis: Date.now() });
    return;
  }
  entree.nombre += 1;
}

/**
 * Crée — ou remplace — le code de rattachement d'un poste.
 *
 * REMPLACE, ET C'EST VOULU : un administrateur qui reclique a perdu le
 * code précédent ou l'a envoyé à la mauvaise personne. Le nouveau code
 * annule l'ancien, immédiatement.
 */
async function demanderCode(idEquipement, idUtilisateur) {
  const code = fabriquerCode();

  await db.query(
    `INSERT INTO RATTACHEMENT_POSTE
       (id_equipement, code, code_expire_le, demande_par, demande_le)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), ?, NOW())
     ON DUPLICATE KEY UPDATE
       code           = VALUES(code),
       code_expire_le = VALUES(code_expire_le),
       demande_par    = VALUES(demande_par),
       demande_le     = VALUES(demande_le)`,
    [idEquipement, code, DUREE_MINUTES, idUtilisateur || null]
  );

  return { code, duree_minutes: DUREE_MINUTES };
}

/** Annule le code en cours. Le poste déjà rattaché le reste. */
async function annulerCode(idEquipement) {
  await db.query(
    `UPDATE RATTACHEMENT_POSTE
        SET code = NULL, code_expire_le = NULL
      WHERE id_equipement = ?`,
    [idEquipement]
  );
}

/**
 * Détache un poste : son jeton cesse de valoir, et l'agent installé
 * dessus ne peut plus rien écrire. Ce que le poste a déjà remonté reste
 * en base — on retire un droit, on n'efface pas une observation.
 */
async function detacher(idEquipement) {
  await db.query(
    `UPDATE RATTACHEMENT_POSTE
        SET code = NULL, code_expire_le = NULL, jeton = NULL, rattache_le = NULL
      WHERE id_equipement = ?`,
    [idEquipement]
  );
}

/**
 * L'état lisible par l'interface. NE REND JAMAIS LE JETON : il ne
 * quitte le serveur qu'une fois, vers la machine qui a présenté le code.
 * Le code, lui, est rendu tant qu'il est valide — c'est son usage.
 */
async function etat(idEquipement) {
  const [[ligne]] = await db.query(
    `SELECT r.code, r.code_expire_le, r.demande_le, r.rattache_le,
            r.nom_declare, r.adresse_vue, r.dernier_envoi,
            u.nom AS demande_par_nom, u.email AS demande_par_email,
            (r.jeton IS NOT NULL) AS rattache
       FROM RATTACHEMENT_POSTE r
       LEFT JOIN UTILISATEUR u ON u.id_utilisateur = r.demande_par
      WHERE r.id_equipement = ?`,
    [idEquipement]
  );

  if (!ligne) {
    return { rattache: false, code: null, en_attente: false };
  }

  const expire = ligne.code_expire_le ? new Date(ligne.code_expire_le) : null;
  const codeValide = Boolean(ligne.code) && expire !== null && expire > new Date();

  return {
    rattache: Boolean(Number(ligne.rattache)),
    rattache_le: ligne.rattache_le,
    nom_declare: ligne.nom_declare,
    adresse_vue: ligne.adresse_vue,
    dernier_envoi: ligne.dernier_envoi,
    // « En attente » = un code est sorti et personne ne s'en est encore
    // servi. C'est ce que l'écran doit montrer, et c'est une information
    // différente de « pas rattaché ».
    en_attente: codeValide && !Number(ligne.rattache),
    code: codeValide ? ligne.code : null,
    code_expire_le: codeValide ? ligne.code_expire_le : null,
    demande_le: ligne.demande_le,
    demande_par: ligne.demande_par_nom || ligne.demande_par_email || null,
  };
}

/**
 * Échange un code contre le jeton du poste.
 *
 * NE DIT JAMAIS POURQUOI ÇA A ÉCHOUÉ, au-delà de « code invalide ou
 * expiré ». Distinguer « ce code n'existe pas » de « ce code est
 * expiré » apprendrait à celui qui essaie au hasard quand il a trouvé
 * un code ayant existé.
 *
 * @returns {Promise<{ok:true, jeton:string, id_site:number, id_equipement:number,
 *                     adresse_ip:string}|{ok:false, raison:string}>}
 */
async function echangerCode(code, { nomDeclare, adresseVue } = {}) {
  const propre = String(code || "").trim().toUpperCase();
  if (!propre) return { ok: false, raison: "code_absent" };

  if (adresseVue && tropDEchecs(adresseVue)) {
    return { ok: false, raison: "trop_d_essais" };
  }

  const [[ligne]] = await db.query(
    `SELECT r.id_equipement, e.id_site, e.adresse_ip
       FROM RATTACHEMENT_POSTE r
       JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
      WHERE r.code = ? AND r.code_expire_le > NOW()`,
    [propre]
  );

  if (!ligne) {
    if (adresseVue) noterEchec(adresseVue);
    return { ok: false, raison: "code_invalide" };
  }

  const jeton = fabriquerJeton();

  /* LE CODE EST BRÛLÉ DANS LA MÊME REQUÊTE QUI POSE LE JETON, et la
     condition `code = ?` y est répétée : deux machines qui présentent le
     même code à la même seconde ne peuvent pas être rattachées toutes
     les deux. La seconde verra son code déjà consommé. */
  const [res] = await db.query(
    `UPDATE RATTACHEMENT_POSTE
        SET jeton = ?, rattache_le = NOW(), code = NULL, code_expire_le = NULL,
            nom_declare = ?, adresse_vue = ?
      WHERE id_equipement = ? AND code = ?`,
    [jeton, nomDeclare || null, adresseVue || null, ligne.id_equipement, propre]
  );

  if (res.affectedRows === 0) {
    if (adresseVue) noterEchec(adresseVue);
    return { ok: false, raison: "code_invalide" };
  }

  return {
    ok: true,
    jeton,
    id_site: ligne.id_site,
    id_equipement: ligne.id_equipement,
    adresse_ip: ligne.adresse_ip,
  };
}

/**
 * À qui appartient ce jeton de poste ? Rend l'équipement et son site, ou
 * null. C'est ce qui remplace la comparaison avec le jeton du site pour
 * un agent de poste rattaché.
 */
async function posteDuJeton(jeton) {
  if (!jeton) return null;
  const [[ligne]] = await db.query(
    `SELECT r.id_equipement, e.id_site, e.adresse_ip
       FROM RATTACHEMENT_POSTE r
       JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
      WHERE r.jeton = ?`,
    [jeton]
  );
  if (!ligne) return null;

  // Date du dernier envoi : c'est ce qui permet de dire, sur la fiche,
  // « rattaché mais muet depuis trois jours » — un agent installé qui ne
  // parle plus est un agent qui ne sert plus.
  db.query("UPDATE RATTACHEMENT_POSTE SET dernier_envoi = NOW() WHERE id_equipement = ?", [
    ligne.id_equipement,
  ]).catch(() => {});

  return ligne;
}

module.exports = {
  demanderCode,
  annulerCode,
  detacher,
  etat,
  echangerCode,
  posteDuJeton,
  DUREE_MINUTES,
};
