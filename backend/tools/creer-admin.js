/**
 * tools/creer-admin.js
 * Crée un compte administrateur, ou redéfinit son mot de passe.
 *
 *   node tools\creer-admin.js                          (état des comptes)
 *   node tools\creer-admin.js <email> <mot-de-passe>   (crée ou réinitialise)
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * Deux situations bloquent complètement l'accès à la plateforme, et
 * aucune ne se résout depuis l'interface — puisqu'il faut être connecté
 * pour y faire quoi que ce soit :
 *
 *   1. La table UTILISATEUR est vide (base neuve, ou données de test
 *      effacées). Personne ne peut se connecter, donc personne ne peut
 *      créer de compte.
 *
 *   2. Le mot de passe est perdu. Il est stocké haché avec bcrypt : il
 *      n'est pas récupérable, seulement remplaçable.
 *
 * La route POST /api/auth/register traite le premier cas, mais UNIQUEMENT
 * sur une table vide — c'est le correctif de la faille qui permettait à
 * n'importe qui de se créer un compte administrateur. Elle ne peut donc
 * rien pour le second cas.
 *
 * Cet outil traite les deux. Il exige un accès au fichier .env et à la
 * base : quelqu'un qui l'a possède déjà les clés du serveur.
 * ─────────────────────────────────────────────────────────────────────
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const bcrypt = require("bcryptjs");
const db = require("../src/db");

const [, , email, motDePasse, ...reste] = process.argv;
const nom = reste.join(" ") || null;

(async () => {
  const [comptes] = await db.query(
    `SELECT id_utilisateur, nom, email, role, id_site
     FROM UTILISATEUR ORDER BY role, nom`
  );

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  COMPTES DE LA PLATEFORME");
  console.log("═══════════════════════════════════════════════════════\n");

  if (comptes.length === 0) {
    console.log("  \x1b[33mAucun compte.\x1b[0m Personne ne peut se connecter.\n");
  } else {
    for (const c of comptes) {
      const portee = c.id_site === null ? "tous les sites" : `site ${c.id_site}`;
      console.log(`  ${c.role.padEnd(10)} ${c.email.padEnd(32)} ${portee}`);
    }
    console.log("");
  }

  // ── Mode consultation ──
  if (!email || !motDePasse) {
    console.log("  Pour créer un compte administrateur ou changer un mot de passe :");
    console.log("    node tools\\creer-admin.js votre@email.com votre-mot-de-passe\n");
    if (comptes.length === 0) {
      console.log("  \x1b[33mC'est nécessaire ici : la table est vide.\x1b[0m\n");
    }
    process.exit(0);
  }

  // Contrôles minimaux. Ce compte est administrateur global et ne peut
  // pas être supprimé tant qu'il est le dernier : un mot de passe faible
  // s'y installe pour longtemps.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error(`  \x1b[31mAdresse e-mail invalide : ${email}\x1b[0m\n`);
    process.exit(1);
  }
  if (motDePasse.length < 8) {
    console.error("  \x1b[31mMot de passe trop court — 8 caractères au minimum.\x1b[0m\n");
    process.exit(1);
  }

  const hash = await bcrypt.hash(motDePasse, 10);
  const existant = comptes.find((c) => c.email.toLowerCase() === email.toLowerCase());

  if (existant) {
    // On ne touche QUE le mot de passe et le rôle. Le nom, le site et
    // l'historique du compte restent ceux d'origine : cet outil sert à
    // reprendre la main, pas à réécrire un compte.
    await db.query(
      "UPDATE UTILISATEUR SET mot_de_passe_hash = ?, role = 'admin', id_site = NULL WHERE id_utilisateur = ?",
      [hash, existant.id_utilisateur]
    );
    console.log(`  \x1b[32m✓\x1b[0m Mot de passe redéfini pour ${email}`);
    console.log("    Le compte est administrateur global.\n");
  } else {
    await db.query(
      `INSERT INTO UTILISATEUR (nom, email, mot_de_passe_hash, role, id_site)
       VALUES (?, ?, ?, 'admin', NULL)`,
      [nom || email.split("@")[0], email, hash]
    );
    console.log(`  \x1b[32m✓\x1b[0m Compte administrateur créé : ${email}\n`);
  }

  // Trace : la création ou la reprise en main d'un compte administrateur
  // est l'événement le plus sensible du cycle de vie de la plateforme.
  // Elle doit apparaître dans le journal même faite en ligne de commande.
  await db
    .query(
      `INSERT INTO LOG_ACTIVITE (action, description, adresse_ip_utilisateur)
       VALUES ('administration', ?, 'ligne de commande')`,
      [`${existant ? "Réinitialisation" : "Création"} du compte administrateur ${email}`]
    )
    .catch(() => {});

  console.log("  Connectez-vous sur l'interface avec cette adresse.\n");
  process.exit(0);
})().catch((err) => {
  console.error("\nOpération impossible :", err.message);
  if (/ECONNREFUSED/.test(err.message)) {
    console.error("MySQL ne répond pas. Le service est-il démarré ?\n");
  } else if (/Unknown column/.test(err.message)) {
    console.error("\nLa table UTILISATEUR n'a pas la structure attendue.");
    console.error("Lancez d'abord : node tools\\combler-colonnes.js --appliquer\n");
  }
  process.exit(2);
});
