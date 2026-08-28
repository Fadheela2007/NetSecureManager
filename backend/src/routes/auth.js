/**
 * routes/auth.js
 * Authentification par e-mail/mot de passe (JWT). Table UTILISATEUR (voir schema.sql).
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");
const limiteur = require("../services/limiteurConnexion");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET est absent de backend/.env — démarrage refusé.");
}
const JWT_EXPIRES_IN = "8h";

/**
 * Empreinte factice, comparée quand le compte n'existe pas.
 *
 * POURQUOI. La version précédente renvoyait immédiatement si l'e-mail
 * était inconnu, mais prenait ~100 ms à vérifier le mot de passe si le
 * compte existait. Cet écart est mesurable : en chronométrant les
 * réponses, on distingue un e-mail enregistré d'un e-mail inconnu, et on
 * peut ainsi dresser la liste des comptes réels avant même d'essayer un
 * seul mot de passe.
 *
 * Comparer contre une empreinte factice fait passer les deux chemins par
 * le même calcul coûteux. Le temps de réponse cesse de renseigner.
 */
const EMPREINTE_FACTICE = bcrypt.hashSync("empreinte-de-comparaison-constante", 10);

/** Attente non bloquante, pour le ralentissement progressif. */
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/auth/login
 * body: { email, mot_de_passe }
 */
router.post("/login", async (req, res) => {
  const { email, mot_de_passe } = req.body;
  if (!email || !mot_de_passe) {
    return res.status(400).json({ error: "Email et mot de passe requis" });
  }

  const limite = limiteur.verifier(req.ip, email);
  if (!limite.autorise) {
    const minutes = Math.ceil(limite.resteMs / 60000);
    // 429 et non 401 : le client doit pouvoir distinguer « mauvais mot de
    // passe » de « trop de tentatives », sinon l'utilisateur légitime
    // ressaisit indéfiniment un mot de passe pourtant correct.
    return res.status(429).json({
      error: `Trop de tentatives de connexion. Réessayez dans ${minutes} minute(s).`,
    });
  }

  // Ralentissement progressif après plusieurs échecs sur ce compte.
  if (limite.delaiMs > 0) await attendre(limite.delaiMs);

  try {
    const [rows] = await db.query("SELECT * FROM UTILISATEUR WHERE email = ?", [email]);
    const user = rows[0];

    // La comparaison a lieu DANS TOUS LES CAS, y compris quand le compte
    // n'existe pas : voir EMPREINTE_FACTICE ci-dessus.
    const valide = await bcrypt.compare(
      mot_de_passe,
      user ? user.mot_de_passe_hash : EMPREINTE_FACTICE
    );

    if (!user || !valide) {
      limiteur.enregistrerEchec(req.ip, email);

      // Journalisé, mais SANS le mot de passe essayé ni distinction
      // entre compte inconnu et mot de passe faux : un journal ne doit
      // pas devenir lui-même la source de la fuite qu'il documente.
      db.query(
        `INSERT INTO LOG_ACTIVITE (action, description, adresse_ip_utilisateur)
         VALUES ('connexion_echouee', ?, ?)`,
        [`Tentative de connexion échouée pour ${email}`, req.ip]
      ).catch(() => {});

      // Message identique dans les deux cas, pour la même raison que
      // l'empreinte factice : ne rien dire de l'existence du compte.
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    limiteur.enregistrerSucces(req.ip, email);

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
