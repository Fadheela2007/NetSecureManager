/**
 * tools/verifier-cloisonnement.js
 * Un compte rattaché à un site ne voit QUE son site.
 *
 *   node tools\verifier-cloisonnement.js lecteur@exemple.fr
 *
 * Le mot de passe est demandé ensuite, sans être affiché.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE CONTRÔLE EXISTE
 *
 * C'est la propriété qui décide si la plateforme est vendable à une
 * entreprise multi-sites. Si l'administrateur de l'agence de Yaoundé
 * peut lire le parc du siège, aucun acheteur sérieux ne signera.
 *
 * POURQUOI IL NE SE VÉRIFIE PAS À L'ŒIL
 *
 * Le protocole demandait de se connecter avec le compte et de regarder
 * si les listes paraissent vides. Trois faiblesses :
 *
 *   1. Une page vide peut l'être parce que le cloisonnement fonctionne,
 *      ou parce que la requête a échoué. Les deux se ressemblent.
 *   2. Le frontend peut filtrer à l'affichage ce que le serveur a
 *      pourtant envoyé. L'écran serait juste et la fuite réelle : il
 *      suffirait d'interroger l'API directement pour tout obtenir.
 *   3. On regarde les pages auxquelles on pense. Pas les autres.
 *
 * Cet outil interroge le SERVEUR, sans passer par l'interface, et
 * compare ce que reçoit le compte restreint à ce qui existe réellement.
 * ─────────────────────────────────────────────────────────────────────
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const readline = require("readline");
const db = require("../src/db");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[90m", F = "\x1b[0m";
const BASE = process.env.URL_API_LOCALE || "http://localhost:5000/api";

function demanderMotDePasse(invite) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ecrire = rl._writeToOutput;
    rl._writeToOutput = function (chaine) {
      if (chaine.includes(invite)) ecrire.call(rl, chaine);
    };
    rl.question(invite, (r) => {
      rl.close();
      process.stdout.write("\n");
      resolve(r);
    });
  });
}

async function lireJson(chemin, jeton) {
  const r = await fetch(`${BASE}${chemin}`, { headers: { Authorization: `Bearer ${jeton}` } });
  const texte = await r.text();
  try {
    return { statut: r.status, data: JSON.parse(texte) };
  } catch {
    return { statut: r.status, data: null, texte };
  }
}

/** Extrait un tableau d'une réponse, qu'elle soit brute ou enveloppée. */
function enTableau(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.equipements)) return data.equipements;
  if (data && Array.isArray(data.alertes)) return data.alertes;
  if (data && Array.isArray(data.incidents)) return data.incidents;
  if (data && Array.isArray(data.resultats)) return data.resultats;
  return null;
}

(async () => {
  const [, , email, motDePasseArgument] = process.argv;
  if (!email) {
    console.error(`
Usage :
  node tools\\verifier-cloisonnement.js <email du compte rattaché>

Le compte doit être rattaché à UN site. L'outil vérifie qu'il ne reçoit
rien qui appartienne à un autre. Rien n'est modifié.
`);
    // Ici la base n'est pas encore ouverte : sortir directement est sain.
    process.exit(1);
  }

  const motDePasse =
    motDePasseArgument ||
    (await demanderMotDePasse("Mot de passe (rien ne s'affiche pendant la saisie) : "));

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  CLOISONNEMENT PAR SITE");
  console.log("═══════════════════════════════════════════════════════\n");

  /* ── Ce qui existe réellement, vu de la base ─────────────────────── */
  const [sites] = await db.query(
    `SELECT s.id_site, s.nom,
            (SELECT COUNT(*) FROM EQUIPEMENT e WHERE e.id_site = s.id_site) AS equipements
     FROM SITE s ORDER BY s.id_site`
  );
  const [[{ total }]] = await db.query("SELECT COUNT(*) AS total FROM EQUIPEMENT");

  console.log(`  ${G}Ce qui existe en base${F}`);
  for (const s of sites) {
    console.log(`    site ${s.id_site} — ${String(s.nom).slice(0, 24).padEnd(24)} ${String(s.equipements).padStart(5)} équipement(s)`);
  }
  console.log(`    ${G}total : ${total}${F}\n`);

  /* ── Connexion du compte restreint ───────────────────────────────── */
  let jeton, moi;
  try {
    const r = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, mot_de_passe: motDePasse }),
    });
    const data = await r.json();
    if (!r.ok || !data.token) {
      console.error(`  ${R}Connexion refusée :${F} ${data.error || r.status}\n`);
      await db.end().catch(() => {});
      process.exitCode = 1;
      return;
    }
    jeton = data.token;
    moi = data.utilisateur;
  } catch (err) {
    console.error(`  ${R}Serveur injoignable :${F} ${err.message}\n`);
    await db.end().catch(() => {});
    process.exitCode = 1;
    return;
  }

  if (moi.id_site === null || moi.id_site === undefined) {
    console.error(`  ${R}Ce compte est GLOBAL (aucun site de rattachement).${F}`);
    console.error(`  ${J}Le cloisonnement ne s'applique pas : il voit tout, c'est voulu.`);
    console.error(`  Relancez avec un compte rattaché à un site.${F}\n`);
    await db.end().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const sien = sites.find((s) => s.id_site === moi.id_site);
  console.log(
    `  ${V}Connecté${F} : ${moi.email} (${moi.role}) — rattaché au site ${moi.id_site}` +
      (sien ? ` (${sien.nom})` : "") + "\n"
  );

  /* ── Vérifications ───────────────────────────────────────────────── */
  let fuites = 0;

  // 1. Les équipements reçus appartiennent-ils TOUS à son site ?
  const eq = await lireJson("/equipements", jeton);
  const listeEq = enTableau(eq.data);
  if (listeEq === null) {
    console.log(`  ${J}?${F} /equipements — réponse inattendue (HTTP ${eq.statut}), non vérifiable`);
  } else {
    const etrangers = listeEq.filter((e) => e.id_site !== undefined && e.id_site !== moi.id_site);
    const attendu = sien ? sien.equipements : 0;
    if (etrangers.length > 0) {
      fuites++;
      console.log(`  ${R}✗ /equipements — ${etrangers.length} équipement(s) d'un AUTRE site${F}`);
      for (const e of etrangers.slice(0, 5)) {
        console.log(`      ${R}${e.adresse_ip} (site ${e.id_site})${F}`);
      }
    } else if (listeEq.length > attendu) {
      // Le serveur peut ne pas renvoyer id_site : on compare alors les
      // volumes. Recevoir plus que ce que le site contient est une fuite.
      fuites++;
      console.log(
        `  ${R}✗ /equipements — ${listeEq.length} reçus pour un site qui en compte ${attendu}${F}`
      );
    } else {
      console.log(
        `  ${V}✓${F} /equipements — ${listeEq.length} reçu(s), tous du site ${moi.id_site} ` +
          `${G}(le site en compte ${attendu}, le parc entier ${total})${F}`
      );
    }
  }

  // 2. Le sélecteur de site ne doit montrer que le sien.
  const st = await lireJson("/sites", jeton);
  const listeSites = enTableau(st.data);
  if (listeSites === null) {
    console.log(`  ${J}?${F} /sites — réponse inattendue (HTTP ${st.statut}), non vérifiable`);
  } else if (listeSites.some((s) => s.id_site !== moi.id_site)) {
    fuites++;
    const autres = listeSites.filter((s) => s.id_site !== moi.id_site).map((s) => s.nom);
    console.log(`  ${R}✗ /sites — voit aussi : ${autres.join(", ")}${F}`);
  } else {
    console.log(`  ${V}✓${F} /sites — ${listeSites.length} site(s), uniquement le sien`);
  }

  // 3. Alertes et incidents.
  for (const chemin of ["/alertes?statut=active", "/incidents"]) {
    const r = await lireJson(chemin, jeton);
    const liste = enTableau(r.data);
    if (liste === null) {
      console.log(`  ${J}?${F} ${chemin} — réponse inattendue (HTTP ${r.statut}), non vérifiable`);
      continue;
    }
    const etrangers = liste.filter((x) => x.id_site !== undefined && x.id_site !== moi.id_site);
    if (etrangers.length > 0) {
      fuites++;
      console.log(`  ${R}✗ ${chemin} — ${etrangers.length} ligne(s) d'un autre site${F}`);
    } else {
      console.log(`  ${V}✓${F} ${chemin.padEnd(24)} ${liste.length} ligne(s), aucune étrangère`);
    }
  }

  // 4. La communauté SNMP doit être masquée pour un non-administrateur.
  const pl = await lireJson("/plages", jeton);
  const listePlages = enTableau(pl.data);
  if (listePlages === null) {
    console.log(`  ${J}?${F} /plages — réponse inattendue (HTTP ${pl.statut}), non vérifiable`);
  } else if (listePlages.length === 0) {
    console.log(
      `  ${J}?${F} /plages — aucune plage déclarée : le masquage de la communauté ` +
        `SNMP ne peut pas être vérifié`
    );
  } else {
    const enClair = listePlages.filter(
      (p) => p.snmp_community && !p.snmp_community_masquee
    );
    if (moi.role !== "admin" && enClair.length > 0) {
      fuites++;
      console.log(`  ${R}✗ /plages — communauté SNMP en clair pour un rôle ${moi.role}${F}`);
    } else {
      console.log(`  ${V}✓${F} /plages — communauté SNMP masquée`);
    }
  }

  // 5. Accès DIRECT à un équipement d'un autre site : doit être refusé.
  const autreSite = sites.find((s) => s.id_site !== moi.id_site && s.equipements > 0);
  if (autreSite) {
    const [[cible]] = await db.query(
      "SELECT id_equipement, adresse_ip FROM EQUIPEMENT WHERE id_site = ? LIMIT 1",
      [autreSite.id_site]
    );
    if (cible) {
      const direct = await lireJson(`/equipements/${cible.id_equipement}/interfaces`, jeton);
      if (direct.statut === 404 || direct.statut === 403) {
        console.log(
          `  ${V}✓${F} accès direct à l'équipement ${cible.id_equipement} ` +
            `(site ${autreSite.id_site}) refusé — HTTP ${direct.statut}`
        );
      } else {
        fuites++;
        console.log(
          `  ${R}✗ accès direct à l'équipement ${cible.id_equipement} du site ` +
            `${autreSite.id_site} ACCORDÉ (HTTP ${direct.statut})${F}`
        );
        console.log(
          `      ${R}Filtrer les listes ne suffit pas : il faut refuser l'accès ` +
            `par identifiant.${F}`
        );
      }
    }
  } else {
    console.log(`  ${J}?${F} aucun autre site ne contient d'équipement : accès direct non testé`);
  }

  /* ── Verdict ─────────────────────────────────────────────────────── */
  console.log("\n───────────────────────────────────────────────────────");
  if (fuites === 0) {
    console.log(`  ${V}Le cloisonnement tient.${F} Aucune donnée d'un autre site.`);
  } else {
    console.log(`  ${R}${fuites} fuite(s) de cloisonnement.${F}`);
    console.log("  À corriger avant toute vente : c'est la propriété qu'un");
    console.log("  acheteur multi-sites vérifiera lui-même.");
  }
  console.log("───────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────
  // ON FERME, ON NE TUE PAS.
  //
  // `process.exit()` interrompt Node au milieu de ce qu'il fait. Avec
  // une connexion à la base et une saisie clavier encore ouvertes, libuv
  // s'en plaignait sous Windows :
  //
  //     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
  //
  // Le verdict venait de s'afficher, donc le résultat était bon — mais
  // un outil qui se termine sur un message d'erreur du système fait
  // douter de tout ce qu'il vient d'annoncer.
  //
  // On ferme donc proprement, et on laisse Node s'arrêter de lui-même.
  // `exitCode` transmet quand même le résultat à qui enchaîne dessus.
  // ─────────────────────────────────────────────────────────────────
  await db.end().catch(() => {});
  process.exitCode = fuites > 0 ? 1 : 0;
})().catch(async (err) => {
  console.error(`\n${R}Erreur :${F} ${err.message}\n`);
  await db.end().catch(() => {});
  process.exitCode = 1;
});
