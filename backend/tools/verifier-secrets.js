/**
 * tools/verifier-secrets.js
 * Vérifie qu'aucun secret ne sort du serveur vers le navigateur.
 *
 *   node tools\verifier-secrets.js admin@exemple.fr
 *
 * Le mot de passe est demandé à l'exécution, sans être affiché — il ne
 * doit jamais transiter par la ligne de commande, qui est historisée.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL REMPLACE LA VÉRIFICATION À LA MAIN
 *
 * Le protocole demandait d'ouvrir les outils du navigateur, d'aller dans
 * l'onglet Réseau, de recharger, de naviguer partout, puis de chercher
 * quatre termes dans les réponses.
 *
 * Trois problèmes, rencontrés en essayant :
 *
 *   1. Si la liste des requêtes est vide — panneau ouvert trop tard, page
 *      non rechargée — la recherche répond « rien trouvé ». Ce qui est
 *      vrai, et ne prouve RIEN. Le test réussit sans avoir rien testé.
 *
 *   2. En développement, le serveur de Vite sert le code source en clair.
 *      La recherche y trouve des correspondances qui ne sont pas des
 *      fuites, et on conclut à un défaut inexistant.
 *
 *   3. Le résultat dépend des pages qu'on a pensé à visiter. Rien ne dit
 *      lesquelles ont été couvertes.
 *
 * Cet outil interroge le serveur DIRECTEMENT, route par route, avec une
 * liste écrite noir sur blanc. Il dit ce qu'il a examiné, et il échoue si
 * une route n'a pas pu être atteinte — au lieu de compter cela comme un
 * succès.
 *
 * IL SE RELANCE AVANT CHAQUE DÉMONSTRATION. C'est le genre de contrôle
 * qui doit tenir en une commande, sinon il n'est jamais refait.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const readline = require("readline");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";

const BASE = process.env.URL_API_LOCALE || "http://localhost:5000/api";

/**
 * Ce qui ne doit JAMAIS apparaître dans une réponse.
 *
 * On cherche le NOM du champ et non sa valeur : une valeur peut être
 * quelconque, le nom du champ, lui, est stable. `mot_de_passe_hash`
 * présent dans une réponse est une fuite, quelle que soit sa valeur.
 */
const INTERDITS = [
  { motif: "mot_de_passe_hash", pourquoi: "empreinte du mot de passe" },
  { motif: "agent_token", pourquoi: "jeton d'agent — permet d'injecter de faux équipements" },
  { motif: "snmp_v3_auth_key", pourquoi: "clé d'authentification SNMPv3" },
  { motif: "snmp_v3_priv_key", pourquoi: "clé de chiffrement SNMPv3" },
  { motif: "jwt_secret", pourquoi: "clé de signature des sessions" },
  { motif: "smtp_pass", pourquoi: "mot de passe de messagerie" },
];

/**
 * Routes examinées. La liste est EXPLICITE : on doit pouvoir dire ce qui
 * a été vérifié, et voir d'un coup d'œil ce qui manque.
 */
const ROUTES = [
  "/sites",
  "/plages",
  "/configuration",
  "/utilisateurs",
  "/equipements",
  "/alertes?statut=active",
  "/alertes/resume",
  "/incidents",
  "/acces-web/politique",
  "/acces-web/categories",
  "/acces-web/apercu",
  "/bande-passante/classement?heures=24",
  "/recherche?q=a",
  "/reinitialisation/apercu",
  "/oui/etat",
  // « /logs » et non « /journal » : le nom de la route diffère du nom de
  // la page. Cette liste a d'ailleurs commencé par contenir « /journal »,
  // qui répondait 404 — et l'outil a eu raison de refuser de compter ce
  // 404 comme un succès. C'est exactement pour ça qu'il distingue « rien
  // trouvé » de « pas examiné ».
  "/logs",
  "/sites/1/agent",
];

/** Exception documentée : la seule route qui a le droit de servir le jeton. */
const EXCEPTIONS = {
  "/sites/:id/agent": "agent_token",
};

async function lire(chemin, jeton) {
  const reponse = await fetch(`${BASE}${chemin}`, {
    headers: jeton ? { Authorization: `Bearer ${jeton}` } : {},
  });
  const texte = await reponse.text();
  return { statut: reponse.status, texte };
}

/**
 * Demande le mot de passe sans l'afficher.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI IL N'EST PLUS PASSÉ EN ARGUMENT
 *
 * La première version s'appelait ainsi :
 *
 *     node tools\verifier-secrets.js admin@exemple.fr monmotdepasse
 *
 * Le mot de passe apparaissait alors dans l'invite de commandes, dans
 * l'historique du terminal (`Get-History`, `~/.bash_history`), et dans
 * toute capture d'écran de la session. Il a fini deux fois dans une
 * conversation, ce qui a obligé à le changer.
 *
 * Un outil dont l'usage NORMAL expose un secret est un outil mal conçu :
 * ce n'est pas à l'utilisateur de penser à s'en protéger. Le mot de
 * passe est donc demandé à l'exécution, sans écho.
 *
 * L'argument reste accepté pour l'automatisation (intégration continue),
 * mais il n'est plus le chemin par défaut.
 * ─────────────────────────────────────────────────────────────────────
 */
function demanderMotDePasse(invite) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // On coupe l'écho : rien ne s'affiche pendant la saisie. C'est
    // déroutant la première fois, d'où le rappel dans l'invite.
    const ecrire = rl._writeToOutput;
    rl._writeToOutput = function (chaine) {
      if (chaine.includes(invite)) ecrire.call(rl, chaine);
    };
    rl.question(invite, (reponse) => {
      rl.close();
      process.stdout.write("\n");
      resolve(reponse);
    });
  });
}

(async () => {
  const [, , email, motDePasseArgument] = process.argv;
  if (!email) {
    console.error(`
Usage :
  node tools\\verifier-secrets.js <email>

Le mot de passe est demandé ensuite, sans être affiché.

Le compte sert uniquement à obtenir une session : l'outil interroge
ensuite les routes et cherche des noms de champs sensibles dans les
réponses. Rien n'est modifié.
`);
    process.exit(1);
  }

  const motDePasse =
    motDePasseArgument ||
    (await demanderMotDePasse("Mot de passe (rien ne s'affiche pendant la saisie) : "));

  if (!motDePasse) {
    console.error("\nAucun mot de passe saisi.\n");
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  AUCUN SECRET NE SORT — CONTRÔLE DES RÉPONSES");
  console.log("═══════════════════════════════════════════════════════\n");

  /* ── Session ─────────────────────────────────────────────────────── */
  let jeton, role;
  try {
    const r = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, mot_de_passe: motDePasse }),
    });
    const data = await r.json();
    if (!r.ok || !data.token) {
      console.error(`  ${R}Connexion refusée :${F} ${data.error || r.status}`);
      console.error(`  ${J}Sans session, aucune route ne peut être examinée.${F}\n`);
      process.exit(1);
    }
    jeton = data.token;
    role = data.utilisateur?.role;
    console.log(`  ${V}Connecté${F} en tant que ${email} (${role})\n`);
  } catch (err) {
    console.error(`  ${R}Serveur injoignable :${F} ${err.message}`);
    console.error(`  ${J}Démarrez le backend (npm start), puis relancez.${F}\n`);
    process.exit(1);
  }

  /* ── Examen route par route ──────────────────────────────────────── */
  let fuites = 0;
  let inaccessibles = 0;

  for (const chemin of ROUTES) {
    let resultat;
    try {
      resultat = await lire(chemin, jeton);
    } catch (err) {
      console.log(`  ${J}?${F} ${chemin.padEnd(28)} injoignable : ${err.message}`);
      inaccessibles++;
      continue;
    }

    // UNE ROUTE QUI RÉPOND EN ERREUR N'EST PAS UNE ROUTE PROPRE : elle
    // n'a simplement pas été examinée. La compter comme réussie serait
    // exactement le défaut que cet outil existe pour éviter.
    if (resultat.statut >= 400) {
      console.log(
        `  ${J}?${F} ${chemin.padEnd(28)} HTTP ${resultat.statut} — non examinée`
      );
      inaccessibles++;
      continue;
    }

    // Exception : cette route sert le jeton d'agent volontairement, et
    // elle est réservée aux administrateurs. On le VÉRIFIE plutôt que de
    // l'ignorer — si le jeton n'y était pas, la mise en service d'un site
    // distant serait impossible.
    if (chemin.startsWith("/sites/") && chemin.endsWith("/agent")) {
      const sert = resultat.texte.includes("agent_token");
      console.log(
        `  ${sert ? V + "✓" : J + "?"}${F} ${chemin.padEnd(28)} ` +
          (sert
            ? `${G}sert le jeton — attendu, réservé aux administrateurs${F}`
            : `${J}ne sert PAS le jeton : la mise en service d'un site serait impossible${F}`)
      );
      continue;
    }

    const trouves = INTERDITS.filter((i) => resultat.texte.includes(i.motif));
    if (trouves.length === 0) {
      console.log(
        `  ${V}✓${F} ${chemin.padEnd(28)} ${G}${resultat.texte.length.toLocaleString("fr-FR")} octets examinés${F}`
      );
    } else {
      fuites += trouves.length;
      console.log(`  ${R}✗${F} ${chemin.padEnd(28)} ${R}FUITE${F}`);
      for (const t of trouves) {
        console.log(`      ${R}${t.motif}${F} — ${t.pourquoi}`);
      }
    }
  }

  /* ── Verdict ─────────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if (fuites > 0) {
    console.log(`  ${R}${fuites} fuite(s).${F} À corriger AVANT toute démonstration.`);
  } else if (inaccessibles > 0) {
    console.log(`  ${J}Aucune fuite parmi les routes examinées,${F}`);
    console.log(`  ${J}mais ${inaccessibles} route(s) n'ont pas pu être atteintes.${F}`);
    console.log("  Le contrôle est INCOMPLET : une route non examinée n'est");
    console.log("  pas une route propre.");
  } else {
    console.log(`  ${V}Aucun secret dans les ${ROUTES.length} routes examinées.${F}`);
  }

  console.log(`\n  ${G}Exception documentée :${F}`);
  for (const [route, champ] of Object.entries(EXCEPTIONS)) {
    console.log(`    ${route} sert ${champ} — réservé aux administrateurs.`);
  }
  console.log("───────────────────────────────────────────────────────\n");
  process.exit(fuites > 0 ? 1 : 0);
})();
