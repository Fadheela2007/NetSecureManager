/**
 * routes/auth.js
 * Authentification par e-mail/mot de passe (JWT). Table UTILISATEUR (voir schema.sql).
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET est absent de backend/.env — démarrage refusé.");
}
const JWT_EXPIRES_IN = "8h";

/**
 * POST /api/auth/login
 * body: { email, mot_de_passe }
 */
router.post("/login", async (req, res) => {
  const { email, mot_de_passe } = req.body;
  if (!email || !mot_de_passe) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  try {
    const [rows] = await db.query("SELECT * FROM UTILISATEUR WHERE email = ?", [email]);
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const valide = await bcrypt.compare(mot_de_passe, user.mot_de_passe_hash);
    if (!valide) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const token = jwt.sign(
      { id: user.id_utilisateur, role: user.role, id_site: user.id_site },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // La journalisation ne doit jamais faire échouer une connexion valide.
    try {
      await db.query(
        "INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur) VALUES (?, 'connexion', ?, ?)",
        [user.id_utilisateur, `Connexion de ${user.email}`, req.ip]
      );
    } catch (errLog) {
      console.error("Erreur journalisation connexion:", errLog.message);
    }

    // id_site est nécessaire au frontend pour n'afficher que les options
    // cohérentes avec le périmètre de l'utilisateur (page Utilisateurs).
    // Ce n'est qu'un confort d'affichage : le serveur revalide tout.
    res.json({
      token,
      utilisateur: {
        id: user.id_utilisateur,
        nom: user.nom,
        email: user.email,
        role: user.role,
        id_site: user.id_site ?? null,
      },
    });
  } catch (err) {
    console.error("Erreur login:", err);
    res.status(500).json({ error: "Erreur serveur pendant la connexion" });
  }
});

/**
 * POST /api/auth/register
 * Création de compte. À utiliser pour créer le premier admin, puis à protéger
 * ou désactiver en production (voir note plus bas).
 * body: { nom, email, mot_de_passe, role }
 */
/**
 * POST /api/auth/register — création du TOUT PREMIER compte, et rien d'autre.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ⚠ CETTE ROUTE ÉTAIT UNE PORTE OUVERTE. Correction du 21/08/2026.
 *
 * Elle était accessible SANS authentification — elle est montée avant le
 * requireAuth global, comme /login — et créait un compte de rôle
 * « admin » par défaut, le rôle étant en plus lisible depuis le corps de
 * la requête.
 *
 * Conséquence : n'importe qui pouvant joindre le serveur obtenait un
 * compte administrateur en une requête. Pas de mot de passe à deviner,
 * pas de faille à exploiter — il suffisait de demander. C'est le défaut
 * le plus grave qu'une plateforme de supervision puisse avoir : elle
 * donne accès à la cartographie complète du réseau du client.
 *
 * Ce n'était pas visible à l'usage. L'interface ne propose nulle part
 * de « créer un compte », donc la route ne servait plus à rien depuis
 * que la page Utilisateurs existe — mais elle répondait toujours.
 *
 * CE QUI EST GARDÉ, ET POURQUOI. Une installation neuve n'a aucun
 * compte : sans cette route, personne ne pourrait se connecter pour
 * créer le premier. On conserve donc l'amorçage, mais UNIQUEMENT tant
 * que la table est vide. Dès qu'un compte existe, la route refuse et
 * renvoie vers l'écran Utilisateurs, réservé aux administrateurs.
 *
 * Le rôle n'est plus lu depuis la requête : le premier compte est
 * administrateur global par construction, sinon il ne pourrait pas
 * créer les suivants.
 * ─────────────────────────────────────────────────────────────────────
 */
router.post("/register", async (req, res) => {
  const { nom, email, mot_de_passe } = req.body;
  if (!nom || !email || !mot_de_passe) {
    return res.status(400).json({ error: "nom, email et mot_de_passe sont requis" });
  }

  try {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM UTILISATEUR");

    if (n > 0) {
      // On ne dit pas combien de comptes existent : ce serait renseigner
      // un attaquant sur la taille de l'installation.
      return res.status(403).json({
        error: "La création de compte est réservée aux administrateurs",
        aide: "Connectez-vous, puis utilisez l'écran Utilisateurs.",
      });
    }

    if (String(mot_de_passe).length < 8) {
      return res.status(400).json({
        error: "Mot de passe trop court",
        aide: "Le premier compte administrateur exige au moins 8 caractères.",
      });
    }

    const hash = await bcrypt.hash(mot_de_passe, 10);
    await db.query(
      "INSERT INTO UTILISATEUR (nom, email, mot_de_passe_hash, role, id_site) VALUES (?, ?, ?, 'admin', NULL)",
      [nom, email, hash]
    );

    // Trace explicite : la création du premier administrateur est
    // l'événement le plus sensible du cycle de vie de la plateforme.
    await db
      .query(
        `INSERT INTO LOG_ACTIVITE (action, description, adresse_ip_utilisateur)
         VALUES ('amorcage', ?, ?)`,
        [`Création du premier compte administrateur (${email})`, req.ip]
      )
      .catch(() => {});

    res.status(201).json({ message: "Premier compte administrateur créé" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cet e-mail est déjà utilisé" });
    }
    console.error("Erreur amorçage:", err);
    res.status(500).json({ error: "Erreur lors de la création du compte" });
  }
});

module.exports = router;
