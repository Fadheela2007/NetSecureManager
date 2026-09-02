/**
 * tools/verifier-protections.js
 * La plateforme refuse-t-elle ce qu'elle doit refuser ?
 *
 *   node tools\verifier-protections.js
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CET OUTIL
 *
 * Le protocole demandait de taper une commande curl dans PowerShell :
 *
 *   curl.exe -X POST ... -d "{\"email\":\"pirate@test.fr\", ...}"
 *
 * PowerShell réinterprète les guillemets échappés. Le serveur a reçu du
 * JSON tronqué et répondu « Requête invalide » — un refus, mais pas
 * CELUI qu'on voulait vérifier. Le test paraissait concluant alors qu'il
 * n'avait rien testé : c'est exactement le piège qu'on traque depuis
 * deux jours.
 *
 * Ici, le corps de la requête est construit par le code. Aucun
 * échappement, aucune interprétation par le terminal.
 *
 * CE QUI EST VÉRIFIÉ, ET CE QUI NE PEUT PAS L'ÊTRE
 *
 * Les refus sont testables sans risque : on demande quelque chose
 * d'interdit et on regarde la réponse. Rien n'est créé ni modifié — et
 * si quelque chose l'était, ce serait précisément le défaut recherché.
 *
 * La limitation des tentatives de connexion (T18b) n'est PAS incluse :
 * la déclencher bloquerait votre poste quinze minutes, et le point qui
 * compte — « le compte reste joignable depuis ailleurs » — exige un
 * second appareil. Il reste manuel, à raison.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";
const BASE = process.env.URL_API_LOCALE || "http://localhost:5000/api";

async function appeler(chemin, options = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: options.methode || "GET",
    headers: {
      ...(options.corps ? { "Content-Type": "application/json" } : {}),
      ...(options.jeton ? { Authorization: `Bearer ${options.jeton}` } : {}),
    },
    body: options.corps ? JSON.stringify(options.corps) : undefined,
  });
  const texte = await r.text();
  let data = null;
  try {
    data = JSON.parse(texte);
  } catch {
    /* réponse non JSON : on garde le texte brut */
  }
  return { statut: r.status, data, texte };
}

/**
 * Un contrôle réussit quand le serveur REFUSE avec le bon code.
 *
 * On distingue trois issues et non deux. « Refusé pour la mauvaise
 * raison » n'est pas un succès : un 400 dû à un corps malformé ne prouve
 * pas que la route est fermée, il prouve qu'on l'a mal appelée.
 */
function juger(nom, resultat, attendus, explication) {
  const ok = attendus.includes(resultat.statut);
  const detail =
    resultat.data?.error || String(resultat.texte || "").slice(0, 70) || "(vide)";
  console.log(
    `  ${ok ? V + "✓" : R + "✗"}${F} ${nom.padEnd(46)} HTTP ${resultat.statut} ${G}${detail}${F}`
  );
  if (!ok) console.log(`      ${R}${explication}${F}`);
  return ok ? 0 : 1;
}

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CE QUE LA PLATEFORME DOIT REFUSER");
  console.log("═══════════════════════════════════════════════════════\n");

  let echecs = 0;

  /* ── T18 : la création de compte est fermée ──────────────────────── */
  console.log(`  ${G}Création de compte sans être connecté${F}`);

  // LE CORPS DOIT ÊTRE COMPLET, SINON ON NE TESTE RIEN.
  //
  // La première version omettait `nom`. La route valide les champs AVANT
  // de vérifier si la création est fermée : elle répondait donc 400
  // « nom, email et mot_de_passe sont requis » — un refus, mais pas celui
  // qu'on cherchait. Deux « échecs » annoncés qui n'en étaient pas.
  //
  // Même piège que le curl de PowerShell une heure plus tôt : un refus
  // n'est une preuve que si l'on sait POURQUOI il a été prononcé.
  echecs += juger(
    "création d'un compte administrateur",
    await appeler("/auth/register", {
      methode: "POST",
      corps: {
        nom: "Pirate",
        email: "pirate@test.fr",
        mot_de_passe: "motdepasse123",
        role: "admin",
      },
    }),
    [403, 404],
    "Route ouverte : n'importe qui sur le réseau peut se fabriquer un compte."
  );

  echecs += juger(
    "création d'un compte sans rôle demandé",
    await appeler("/auth/register", {
      methode: "POST",
      corps: { nom: "Pirate 2", email: "pirate2@test.fr", mot_de_passe: "motdepasse123" },
    }),
    [403, 404],
    "Route ouverte, même sans demander de rôle privilégié."
  );

  // Corps incomplet : on VÉRIFIE que le 400 arrive bien, et on note que
  // la validation passe avant l'autorisation. Ce n'est pas une faille,
  // mais l'ordre inverse serait meilleur : refuser d'abord, expliquer
  // ensuite. En l'état, un inconnu apprend les noms de champs attendus.
  echecs += juger(
    "corps incomplet (ordre validation/autorisation)",
    await appeler("/auth/register", {
      methode: "POST",
      corps: { email: "pirate3@test.fr" },
    }),
    [400, 403],
    "Ni validation ni refus : la route accepte n'importe quoi."
  );

  /* ── Accès sans jeton ────────────────────────────────────────────── */
  console.log(`\n  ${G}Lecture de données sans être connecté${F}`);
  for (const chemin of ["/equipements", "/sites", "/utilisateurs", "/configuration", "/logs"]) {
    echecs += juger(
      `GET ${chemin}`,
      await appeler(chemin),
      [401, 403],
      "Donnée servie sans authentification."
    );
  }

  /* ── Jeton fabriqué ──────────────────────────────────────────────── */
  console.log(`\n  ${G}Jeton inventé${F}`);
  echecs += juger(
    "GET /equipements avec un jeton bidon",
    await appeler("/equipements", { jeton: "ceci-nest-pas-un-jeton" }),
    [401, 403],
    "Un jeton non signé est accepté : la signature n'est pas vérifiée."
  );

  /* ── Écriture par un agent sans jeton valable ────────────────────── */
  console.log(`\n  ${G}Injection de faux équipements par un agent${F}`);
  echecs += juger(
    "POST /agent/push sans jeton",
    await appeler("/agent/push", {
      methode: "POST",
      corps: { id_site: 1, equipements: [{ adresse_ip: "10.0.0.1" }] },
    }),
    [401, 403],
    "Un inconnu peut injecter des équipements au nom d'un site."
  );

  echecs += juger(
    "POST /agent/push avec un jeton inventé",
    await appeler("/agent/push", {
      methode: "POST",
      jeton: "jeton-invente",
      corps: { id_site: 1, equipements: [{ adresse_ip: "10.0.0.2" }] },
    }),
    [401, 403],
    "Le jeton d'agent n'est pas vérifié."
  );

  /* ── Réinitialisation sans confirmation ──────────────────────────── */
  console.log(`\n  ${G}Réinitialisation${F}`);
  echecs += juger(
    "POST /reinitialisation sans être connecté",
    await appeler("/reinitialisation", {
      methode: "POST",
      corps: { confirmation: "REINITIALISER", cibles: ["equipements"] },
    }),
    [401, 403],
    "La fonction la plus destructrice est accessible sans authentification."
  );

  /* ── Verdict ─────────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if (echecs === 0) {
    console.log(`  ${V}Tous les refus attendus sont en place.${F}`);
  } else {
    console.log(`  ${R}${echecs} contrôle(s) en échec.${F}`);
    console.log("  Chacun est une porte ouverte : à fermer avant toute vente.");
  }
  console.log(`\n  ${G}Non couvert ici :${F} la limitation des tentatives de connexion`);
  console.log("  (T18b). La déclencher bloquerait ce poste quinze minutes, et");
  console.log("  sa vérification exige un second appareil.");
  console.log("───────────────────────────────────────────────────────\n");
  process.exitCode = echecs > 0 ? 1 : 0;
})().catch((err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}`);
  console.error(`${J}Le backend est-il démarré ?${F}\n`);
  process.exitCode = 1;
});
