/**
 * routes/utilisateurs.js
 * Gestion des comptes de la plateforme.
 *
 * GARDE-FOUS — chacun évite une situation dont on ne se relève pas depuis
 * l'interface :
 *
 *   1. `mot_de_passe_hash` n'apparaît dans AUCUNE projection de ce fichier.
 *   2. On ne peut pas supprimer son propre compte (déconnexion définitive).
 *   3. Il doit toujours rester au moins un administrateur GLOBAL
 *      (role = 'admin' ET id_site IS NULL). Sans lui, plus personne ne peut
 *      administrer la plateforme : c'est un verrouillage irréversible qui
 *      obligerait à repasser par SQL. Protégé contre la suppression ET contre
 *      la rétrogradation (changement de rôle ou rattachement à un site).
 *   4. Cloisonnement : un admin rattaché à un site ne gère que les comptes de
 *      son site et ne peut pas créer de compte global.
 *
 * Le garde-fou 3 s'exécute dans une TRANSACTION avec SELECT ... FOR UPDATE :
 * sans cela, deux requêtes simultanées pourraient chacune constater qu'il
 * reste deux admins globaux et les supprimer tous les deux.
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const db = require("../db");
const { requireRole } = require("../middleware/requireRole");
const { porteeDe } = require("../middleware/porteeSite");

const ROLES = ["admin", "operateur", "lecteur"];
const LONGUEUR_MIN_MOT_DE_PASSE = 8;
const COUT_BCRYPT = 10; // identique au reste du projet (routes/auth.js)

// Validation volontairement permissive : le but est d'attraper les fautes de
// frappe évidentes, pas de réimplémenter la RFC 5322.
const MOTIF_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Le numéro WhatsApp attendu par l'API Meta : international, sans "+". */
const MOTIF_WHATSAPP = /^\d{8,15}$/;

/** Normalise id_site : "", undefined et null valent tous « compte global ». */
function normaliserIdSite(valeur) {
  if (valeur === undefined || valeur === null || valeur === "") return null;
  const n = Number(valeur);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Un admin rattaché ne gère que les comptes de son site.
 * Un admin global gère tout le monde.
 */
function peutGerer(req, compte) {
  const portee = porteeDe(req);
  if (portee === null) return true;
  return compte.id_site === portee;
}

/**
 * Vérifie qu'après l'opération il restera au moins un administrateur global.
 * À appeler DANS une transaction, avec la connexion correspondante.
 *
 * @param {*} cx           connexion de la transaction
 * @param {number} idCible compte modifié ou supprimé
 * @param {boolean} resteGlobal true si le compte reste admin global après l'opération
 */
async function resteraUnAdminGlobal(cx, idCible, resteGlobal) {
  if (resteGlobal) return true;

  const [rows] = await cx.query(
    `SELECT id_utilisateur FROM UTILISATEUR
     WHERE role = 'admin' AND id_site IS NULL AND id_utilisateur <> ?
     FOR UPDATE`,
    [idCible]
  );
  return rows.length > 0;
}

/**
 * GET /api/utilisateurs
 *
 * Sert deux usages : la page de gestion, et le menu d'assignation des
 * incidents (IncidentsPage). Le périmètre est donc identique à celui d'avant
 * le déplacement de cette route : comptes du site + comptes globaux, ces
 * derniers pouvant intervenir partout.
 *
 * Chaque ligne porte un booléen `gerable` calculé côté serveur : le frontend
 * n'a pas à réimplémenter la règle de cloisonnement pour masquer ses boutons.
 */
router.get("/utilisateurs", requireRole("admin", "operateur"), async (req, res) => {
  const portee = porteeDe(req);
  const [rows] = await db.query(
    `SELECT u.id_utilisateur, u.nom, u.email, u.role, u.id_site,
            u.telephone_whatsapp, u.date_creation,
            s.nom AS site_nom
     FROM UTILISATEUR u
     LEFT JOIN SITE s ON s.id_site = u.id_site
     WHERE (? IS NULL OR u.id_site = ? OR u.id_site IS NULL)
     ORDER BY u.nom`,
    [portee, portee]
  );

  // ── COORDONNÉES RÉSERVÉES AUX ADMINISTRATEURS ──
  //
  // La route était déjà fermée aux lecteurs, mais un opérateur y voyait
  // l'adresse e-mail et le numéro WhatsApp de tous ses collègues.
  //
  // Un opérateur a besoin de la LISTE des personnes — pour assigner un
  // incident, il faut bien choisir un nom. Il n'a pas besoin de leurs
  // coordonnées personnelles, qui ne servent qu'à la configuration des
  // notifications, une tâche d'administrateur.
  //
  // Le principe : chaque rôle voit ce dont il a besoin pour agir, et
  // rien de plus. C'est aussi ce qu'un acheteur vérifie en premier sur
  // une plateforme qui manipule des données de salariés.
  const estAdmin = req.user?.role === "admin";

  res.json(
    rows.map((u) => {
      const base = { ...u, gerable: peutGerer(req, u) };
      if (estAdmin) return base;
      // On retire la donnée plutôt que de la vider : une chaîne vide
      // laisserait croire que le champ n'est pas renseigné, et un
      // administrateur pourrait le ressaisir par-dessus.
      delete base.email;
      delete base.telephone_whatsapp;
      return base;
    })
  );
});

/**
 * POST /api/utilisateurs — création d'un compte.
 */
router.post("/utilisateurs", requireRole("admin"), async (req, res) => {
  const { nom, email, mot_de_passe, role, telephone_whatsapp } = req.body;
  const portee = porteeDe(req);

  if (!nom || !email || !mot_de_passe) {
    return res.status(400).json({ error: "nom, email et mot_de_passe sont requis" });
  }
  if (!MOTIF_EMAIL.test(String(email).trim())) {
    return res.status(400).json({ error: "Format d'e-mail invalide" });
  }
  if (String(mot_de_passe).length < LONGUEUR_MIN_MOT_DE_PASSE) {
    return res.status(400).json({
      error: `Le mot de passe doit contenir au moins ${LONGUEUR_MIN_MOT_DE_PASSE} caractères`,
    });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `Rôle invalide (attendu : ${ROLES.join(", ")})` });
  }

  const idSite = normaliserIdSite(req.body.id_site);
  if (Number.isNaN(idSite)) {
    return res.status(400).json({ error: "id_site invalide" });
  }

  if (telephone_whatsapp && !MOTIF_WHATSAPP.test(String(telephone_whatsapp).trim())) {
    return res.status(400).json({
      error: "Numéro WhatsApp invalide : format international sans le « + » (ex. 237XXXXXXXXX)",
    });
  }

  // Cloisonnement : un admin rattaché ne crée que dans son propre site.
  if (portee !== null) {
    if (idSite === null) {
      return res.status(403).json({
        error: "Seul un administrateur global peut créer un compte global (sans site)",
      });
    }
    if (idSite !== portee) {
      return res.status(403).json({ error: "Vous ne pouvez créer un compte que sur votre site" });
    }
  }

  try {
    const hash = await bcrypt.hash(String(mot_de_passe), COUT_BCRYPT);
    const [result] = await db.query(
      `INSERT INTO UTILISATEUR (nom, email, mot_de_passe_hash, role, id_site, telephone_whatsapp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(nom).trim(),
        String(email).trim(),
        hash,
        role,
        idSite,
        telephone_whatsapp ? String(telephone_whatsapp).trim() : null,
      ]
    );

    // Relecture par projection explicite : le hash ne peut pas fuiter.
    const [rows] = await db.query(
      `SELECT id_utilisateur, nom, email, role, id_site, telephone_whatsapp, date_creation
       FROM UTILISATEUR WHERE id_utilisateur = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cet e-mail est déjà utilisé par un autre compte" });
    }
    console.error("Erreur création utilisateur:", err);
    res.status(500).json({ error: "Erreur lors de la création du compte" });
  }
});

/**
 * PATCH /api/utilisateurs/:id — modification.
 * Le mot de passe n'est changé que s'il est explicitement fourni et non vide :
 * un champ laissé vide dans le formulaire ne doit jamais l'effacer.
 */
router.patch("/utilisateurs/:id", requireRole("admin"), async (req, res) => {
  const idCible = Number(req.params.id);
  if (!Number.isInteger(idCible)) {
    return res.status(400).json({ error: "Identifiant invalide" });
  }

  const { nom, email, mot_de_passe, role, telephone_whatsapp } = req.body;
  const portee = porteeDe(req);
  const idSiteFourni = Object.prototype.hasOwnProperty.call(req.body, "id_site");
  const idSite = idSiteFourni ? normaliserIdSite(req.body.id_site) : undefined;

  if (idSiteFourni && Number.isNaN(idSite)) {
    return res.status(400).json({ error: "id_site invalide" });
  }
  if (email !== undefined && !MOTIF_EMAIL.test(String(email).trim())) {
    return res.status(400).json({ error: "Format d'e-mail invalide" });
  }
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `Rôle invalide (attendu : ${ROLES.join(", ")})` });
  }
  if (mot_de_passe && String(mot_de_passe).length < LONGUEUR_MIN_MOT_DE_PASSE) {
    return res.status(400).json({
      error: `Le mot de passe doit contenir au moins ${LONGUEUR_MIN_MOT_DE_PASSE} caractères`,
    });
  }
  if (
    telephone_whatsapp !== undefined &&
    telephone_whatsapp !== null &&
    String(telephone_whatsapp).trim() !== "" &&
    !MOTIF_WHATSAPP.test(String(telephone_whatsapp).trim())
  ) {
    return res.status(400).json({
      error: "Numéro WhatsApp invalide : format international sans le « + » (ex. 237XXXXXXXXX)",
    });
  }

  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();

    const [existants] = await cx.query(
      `SELECT id_utilisateur, nom, email, role, id_site, telephone_whatsapp
       FROM UTILISATEUR WHERE id_utilisateur = ? FOR UPDATE`,
      [idCible]
    );
    if (existants.length === 0) {
      await cx.rollback();
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    const cible = existants[0];

    // 404 et non 403 hors périmètre : ne pas confirmer l'existence du compte.
    if (!peutGerer(req, cible)) {
      await cx.rollback();
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const nouveauRole = role !== undefined ? role : cible.role;
    const nouveauSite = idSiteFourni ? idSite : cible.id_site;

    // Un admin rattaché ne peut pas « promouvoir » un compte hors de son site.
    if (portee !== null && nouveauSite !== portee) {
      await cx.rollback();
      return res.status(403).json({
        error: "Vous ne pouvez pas rattacher ce compte à un autre site que le vôtre",
      });
    }

    // Garde-fou : ne pas rétrograder le dernier administrateur global.
    const etaitAdminGlobal = cible.role === "admin" && cible.id_site === null;
    const resteAdminGlobal = nouveauRole === "admin" && nouveauSite === null;
    if (etaitAdminGlobal && !(await resteraUnAdminGlobal(cx, idCible, resteAdminGlobal))) {
      await cx.rollback();
      return res.status(409).json({
        error:
          "Impossible : ce compte est le dernier administrateur global. " +
          "Créez ou promouvez un autre administrateur global avant de le modifier.",
      });
    }

    const champs = [];
    const valeurs = [];
    if (nom !== undefined) { champs.push("nom = ?"); valeurs.push(String(nom).trim()); }
    if (email !== undefined) { champs.push("email = ?"); valeurs.push(String(email).trim()); }
    if (role !== undefined) { champs.push("role = ?"); valeurs.push(role); }
    if (idSiteFourni) { champs.push("id_site = ?"); valeurs.push(idSite); }
    if (telephone_whatsapp !== undefined) {
      const tel = telephone_whatsapp ? String(telephone_whatsapp).trim() : "";
      champs.push("telephone_whatsapp = ?");
      valeurs.push(tel === "" ? null : tel);
    }
    // Mot de passe : uniquement s'il est fourni ET non vide.
    if (mot_de_passe) {
      champs.push("mot_de_passe_hash = ?");
      valeurs.push(await bcrypt.hash(String(mot_de_passe), COUT_BCRYPT));
    }

    if (champs.length === 0) {
      await cx.rollback();
      return res.status(400).json({ error: "Aucune modification fournie" });
    }

    valeurs.push(idCible);
    await cx.query(`UPDATE UTILISATEUR SET ${champs.join(", ")} WHERE id_utilisateur = ?`, valeurs);

    const [rows] = await cx.query(
      `SELECT id_utilisateur, nom, email, role, id_site, telephone_whatsapp, date_creation
       FROM UTILISATEUR WHERE id_utilisateur = ?`,
      [idCible]
    );

    await cx.commit();
    res.json(rows[0]);
  } catch (err) {
    await cx.rollback().catch(() => {});
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cet e-mail est déjà utilisé par un autre compte" });
    }
    console.error("Erreur modification utilisateur:", err);
    res.status(500).json({ error: "Erreur lors de la modification du compte" });
  } finally {
    cx.release();
  }
});

/**
 * DELETE /api/utilisateurs/:id — suppression.
 */
router.delete("/utilisateurs/:id", requireRole("admin"), async (req, res) => {
  const idCible = Number(req.params.id);
  if (!Number.isInteger(idCible)) {
    return res.status(400).json({ error: "Identifiant invalide" });
  }

  // Se supprimer soi-même = déconnexion définitive, sans retour possible.
  if (Number(req.user?.id) === idCible) {
    return res.status(400).json({
      error: "Vous ne pouvez pas supprimer votre propre compte",
    });
  }

  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();

    const [existants] = await cx.query(
      "SELECT id_utilisateur, nom, role, id_site FROM UTILISATEUR WHERE id_utilisateur = ? FOR UPDATE",
      [idCible]
    );
    if (existants.length === 0) {
      await cx.rollback();
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    const cible = existants[0];

    if (!peutGerer(req, cible)) {
      await cx.rollback();
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const etaitAdminGlobal = cible.role === "admin" && cible.id_site === null;
    if (etaitAdminGlobal && !(await resteraUnAdminGlobal(cx, idCible, false))) {
      await cx.rollback();
      return res.status(409).json({
        error:
          "Impossible : ce compte est le dernier administrateur global. " +
          "Sans lui, plus personne ne pourrait administrer la plateforme.",
      });
    }

    await cx.query("DELETE FROM UTILISATEUR WHERE id_utilisateur = ?", [idCible]);
    await cx.commit();
    res.json({ message: `Compte « ${cible.nom} » supprimé` });
  } catch (err) {
    await cx.rollback().catch(() => {});
    console.error("Erreur suppression utilisateur:", err);
    res.status(500).json({ error: "Erreur lors de la suppression du compte" });
  } finally {
    cx.release();
  }
});

module.exports = router;
