/**
 * routes/auth.js
 * Authentification par e-mail/mot de passe (JWT). Table UTILISATEUR (voir schema.sql).
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
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
 * POST /api/auth/register — création du tout premier compte, et rien d'autre.
 * body: { nom, email, mot_de_passe }
 *
 * Cette route était accessible sans authentification — elle est montée
 * avant le requireAuth global, comme /login — et créait un compte de rôle
 * « admin », le rôle étant lu depuis le corps de la requête. N'importe qui
 * pouvant joindre le serveur obtenait donc un accès administrateur en une
 * requête, et avec lui la cartographie complète du réseau du client.
 * Corrigé le 21/08/2026.
 *
 * L'amorçage est conservé, car une installation neuve n'a aucun compte et
 * personne ne pourrait créer le premier. Mais la route ne répond que tant
 * que la table est vide ; ensuite elle refuse et renvoie vers l'écran
 * Utilisateurs. Le rôle n'est plus lu depuis la requête : le premier
 * compte est administrateur par construction.
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

/* ═══════════════════════════════════════════════════════════════════════
   DEMANDER UN ACCÈS

   Deux routes publiques, et elles sont publiques par nécessité : elles
   servent à quelqu'un qui n'a pas encore de compte. Tout ce qui suit
   existe pour qu'être public ne veuille pas dire être une porte ouverte.
   ═══════════════════════════════════════════════════════════════════════ */

const MOTIF_EMAIL_DEMANDE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LONGUEUR_MIN = 8;

/**
 * Limiteur propre aux demandes d'accès.
 *
 * SÉPARÉ DE CELUI DE LA CONNEXION, ET CE N'EST PAS UN OUBLI DE
 * FACTORISATION. Partager le compteur ferait qu'une rafale de demandes
 * bloquerait la CONNEXION des utilisateurs légitimes : la protection
 * deviendrait le moyen de fermer la plateforme.
 *
 * Le plafond d'entrées et la purge ne sont pas décoratifs non plus. Une
 * carte qui grandit à chaque adresse vue, sur une route que personne
 * n'authentifie, est exactement ce qu'il faut pour faire tomber un
 * serveur par la mémoire — le défaut que `limiteurConnexion` traite
 * explicitement, et qu'il ne faut pas réintroduire ici.
 */
const FENETRE_DEMANDES_MS = 60 * 60 * 1000;
const MAX_DEMANDES_PAR_ADRESSE = 3;
const MAX_ADRESSES_SUIVIES = 5000;
const demandesParAdresse = new Map();

function purgerCompteurs(maintenant) {
  for (const [adresse, entree] of demandesParAdresse) {
    if (maintenant - entree.depuis > FENETRE_DEMANDES_MS) demandesParAdresse.delete(adresse);
  }
  // Dernier recours si la purge par ancienneté n'a pas suffi : mieux vaut
  // perdre le comptage que la mémoire du processus.
  if (demandesParAdresse.size >= MAX_ADRESSES_SUIVIES) demandesParAdresse.clear();
}

function tropDeDemandes(adresse) {
  const maintenant = Date.now();
  purgerCompteurs(maintenant);

  const entree = demandesParAdresse.get(adresse);
  if (!entree || maintenant - entree.depuis > FENETRE_DEMANDES_MS) {
    demandesParAdresse.set(adresse, { nombre: 1, depuis: maintenant });
    return false;
  }
  entree.nombre += 1;
  return entree.nombre > MAX_DEMANDES_PAR_ADRESSE;
}

/**
 * POST /api/auth/inscription
 *
 * On remplit, on valide, on est dedans. Pas de demande, pas de
 * validation par un administrateur, pas d'attente.
 *
 * ── LE RÔLE DONNÉ ──
 *
 * « lecteur » : on consulte, on ne modifie rien. C'est le rôle le plus
 * bas de la plateforme, et c'est le seul qu'une page ouverte puisse
 * distribuer sans y réfléchir — la personne qui s'inscrit est inconnue.
 * Un administrateur la fait monter depuis la page Utilisateurs quand il
 * sait qui elle est.
 *
 * L'EXCEPTION : une base sans aucun compte. Le premier inscrit devient
 * administrateur, sinon l'installation resterait sans personne pour
 * donner le moindre droit à qui que ce soit — verrouillée dès la
 * première seconde. Ça remplace l'ancien écran d'amorçage : même règle,
 * un écran de moins.
 */
router.post("/inscription", async (req, res) => {
  const { nom, email, mot_de_passe } = req.body || {};

  if (!nom || !email || !mot_de_passe) {
    return res.status(400).json({ error: "Nom, e-mail et mot de passe sont requis" });
  }
  if (String(mot_de_passe).length < 8) {
    return res.status(400).json({
      error: "Mot de passe trop court",
      aide: "Huit caractères au minimum.",
    });
  }

  /* Le même compteur que « demander un accès » : trois par adresse IP.
     Une page ouverte sans aucune borne se remplit de comptes créés par
     un script, et c'est la base qu'on retrouve inutilisable. */
  if (tropDeDemandes(req.ip)) {
    return res.status(429).json({
      error: "Trop de créations de compte depuis cette adresse. Réessayez plus tard.",
    });
  }

  try {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM UTILISATEUR");
    const role = Number(n) === 0 ? "admin" : "lecteur";

    const hash = await bcrypt.hash(String(mot_de_passe), 10);
    const [resultat] = await db.query(
      "INSERT INTO UTILISATEUR (nom, email, mot_de_passe_hash, role, id_site) VALUES (?, ?, ?, ?, NULL)",
      [String(nom).trim(), String(email).trim(), hash, role]
    );

    await db
      .query(
        `INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur)
         VALUES (?, 'inscription', ?, ?)`,
        [resultat.insertId, `Inscription de ${email} (${role})`, req.ip || null]
      )
      .catch(() => {});

    /* Entrée immédiate : la personne vient de choisir son mot de passe,
       le lui redemander dans la seconde n'apprend rien à personne. */
    const token = jwt.sign(
      { id: resultat.insertId, role, id_site: null },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.status(201).json({
      token,
      utilisateur: {
        id: resultat.insertId,
        nom: String(nom).trim(),
        email: String(email).trim(),
        role,
        id_site: null,
      },
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Cette adresse a déjà un compte" });
    }
    console.error("Erreur inscription:", err);
    res.status(500).json({ error: "Création du compte impossible" });
  }
});

/**
 * GET /api/auth/amorcage
 *
 * « Cette installation a-t-elle son premier administrateur ? »
 *
 * La page de connexion a besoin de le savoir pour afficher, sur une base
 * vierge, le formulaire de création du compte initial plutôt qu'un
 * formulaire de connexion qui ne peut réussir pour personne. Sans cette
 * route, POST /auth/register existait sans qu'aucun écran ne puisse
 * l'appeler : l'installation d'un client exigeait Postman.
 *
 * CE QUE ÇA RÉVÈLE, ET POURQUOI C'EST ACCEPTABLE. La réponse dit
 * seulement si la base est vide. Sur une installation vierge il n'y a
 * rien à protéger ; sur une installation en service, la réponse est
 * toujours « non » et n'apprend rien — ni le nombre de comptes, ni leur
 * nom. C'est le strict minimum dont l'écran a besoin.
 */
router.get("/amorcage", async (req, res) => {
  try {
    const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM UTILISATEUR");
    res.json({ requis: Number(n) === 0 });
  } catch (err) {
    // Base injoignable : on ne propose surtout pas l'amorçage, qui
    // créerait un administrateur sur une base qu'on n'a pas su lire.
    console.error("Vérification d'amorçage impossible:", err.message);
    res.json({ requis: false });
  }
});

/**
 * POST /api/auth/demande-acces
 *
 * Enregistre une demande. Ne crée AUCUN compte et n'accorde AUCUN droit.
 *
 * ── LA RÉPONSE EST TOUJOURS LA MÊME ──
 *
 * Adresse déjà titulaire d'un compte, demande déjà déposée, ou première
 * venue : le message rendu est identique. Répondre « cette adresse a
 * déjà un compte » transformerait ce formulaire en annuaire — on y
 * essaierait les adresses de l'entreprise une par une pour dresser la
 * liste des employés qui ont accès à la supervision. C'est le même
 * raisonnement que l'empreinte factice de la connexion, appliqué à
 * l'autre porte.
 *
 * Les erreurs de FORME, elles, sont dites franchement : un e-mail mal
 * écrit ou un mot de passe trop court ne renseignent sur personne, et se
 * taire ferait échouer des demandes légitimes sans explication.
 */
router.post("/demande-acces", async (req, res) => {
  const { nom, email, mot_de_passe, motif } = req.body || {};

  if (!nom || !email || !mot_de_passe || !motif) {
    return res.status(400).json({
      error: "Tous les champs sont requis",
      aide: "Nom, e-mail, mot de passe et motif de la demande.",
    });
  }
  if (!MOTIF_EMAIL_DEMANDE.test(String(email).trim())) {
    return res.status(400).json({ error: "Format d'e-mail invalide" });
  }
  if (String(mot_de_passe).length < LONGUEUR_MIN) {
    return res.status(400).json({
      error: "Mot de passe trop court",
      aide: `Au moins ${LONGUEUR_MIN} caractères.`,
    });
  }

  if (tropDeDemandes(req.ip)) {
    return res.status(429).json({
      error: "Trop de demandes",
      aide: "Réessayez dans une heure, ou contactez directement votre administrateur.",
    });
  }

  const REPONSE = {
    enregistree: true,
    message:
      "Votre demande a été transmise. Un administrateur la traitera ; vous pourrez vous connecter une fois qu'elle aura été acceptée.",
  };

  try {
    const adresse = String(email).trim().toLowerCase();

    // Compte déjà existant, ou demande déjà en attente : on n'écrit rien
    // et on répond comme si de rien n'était. Voir l'en-tête.
    const [[compte]] = await db.query(
      "SELECT 1 AS n FROM UTILISATEUR WHERE email = ? LIMIT 1",
      [adresse]
    );
    if (compte) return res.json(REPONSE);

    const [[enAttente]] = await db.query(
      "SELECT 1 AS n FROM DEMANDE_ACCES WHERE email = ? AND statut = 'en_attente' LIMIT 1",
      [adresse]
    );
    if (enAttente) return res.json(REPONSE);

    const hash = await bcrypt.hash(String(mot_de_passe), 10);

    await db.query(
      `INSERT INTO DEMANDE_ACCES (nom, email, mot_de_passe_hash, motif, adresse_ip)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(nom).trim().slice(0, 120),
        adresse.slice(0, 190),
        hash,
        String(motif).trim().slice(0, 255),
        req.ip || null,
      ]
    );

    await db
      .query(
        `INSERT INTO LOG_ACTIVITE (action, description, adresse_ip_utilisateur)
         VALUES ('demande_acces', ?, ?)`,
        [`Demande d'accès déposée pour ${adresse}`, req.ip || null]
      )
      .catch(() => {
        /* Le journal est un confort ; son échec ne doit pas perdre la
           demande, qui est déjà écrite. */
      });

    res.json(REPONSE);
  } catch (err) {
    if (err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146)) {
      return res.status(503).json({
        error: "Les demandes d'accès ne sont pas disponibles sur cette installation",
        aide: "Appliquez backend/migrations/2026-09-28-demandes-acces.sql, puis redémarrez le serveur.",
      });
    }
    console.error("Demande d'accès impossible:", err.message);
    res.status(500).json({ error: "Demande impossible pour le moment" });
  }
});

module.exports = router;
