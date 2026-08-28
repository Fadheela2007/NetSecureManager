/**
 * tools/importer-listes-web.js
 * Importe une liste de domaines dans une catégorie de blocage.
 *
 * USAGE
 *   node tools\importer-listes-web.js publicite --recommandee --remplacer
 *   node tools\importer-listes-web.js publicite C:\chemin\liste.txt --remplacer
 *   node tools\importer-listes-web.js publicite https://exemple.com/l.txt
 *
 * FORMATS ACCEPTÉS — sans conversion préalable, parce que les listes
 * publiques circulent dans trois formats et qu'obliger à les convertir
 * est le meilleur moyen que personne ne mette jamais les listes à jour :
 *   • un domaine par ligne            exemple.com
 *   • format hosts                    0.0.0.0 exemple.com
 *   • format AdBlock simplifié        ||exemple.com^
 * Les commentaires (# et !) sont ignorés.
 *
 * DEUX VOIES, ET LES DEUX SONT NÉCESSAIRES
 * `--recommandee` télécharge la liste de référence : c'est le cas
 * courant, en une commande. Mais la plateforme doit aussi fonctionner
 * sur un réseau sans accès Internet — d'où l'import depuis un fichier
 * local, qui reste la seule voie possible dans ce cas. Le registre OUI
 * suit exactement la même logique.
 *
 * Les listes publiques sont sous licences libres ; vérifiez celle qui
 * s'applique avant de les redistribuer avec le produit.
 */

// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const db = require("../src/db");
const { normaliserDomaine } = require("../src/services/politiqueWebService");

/**
 * Listes publiques de référence, une par catégorie.
 *
 * POURQUOI CES RACCOURCIS EXISTENT. La première version imposait de
 * télécharger le fichier soi-même, de le ranger quelque part, puis de
 * retaper le chemin exact dans la commande. Trois occasions de se
 * tromper pour une opération qu'on refait tous les six mois — et le
 * meilleur moyen que les listes ne soient jamais mises à jour.
 *
 * Le téléchargement automatique ne remplace PAS l'import depuis un
 * fichier : sur un réseau sans accès Internet, seul le fichier local
 * fonctionne. Les deux voies restent ouvertes.
 *
 * Ces listes sont sous licences libres. Vérifiez celle qui s'applique
 * avant de les redistribuer avec le produit — c'est une question à
 * régler avant la première vente, pas après.
 */
const LISTES_RECOMMANDEES = {
  publicite: {
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
    nom: "StevenBlack/hosts",
    taille: "environ 180 000 domaines, ~5 Mo",
  },
  malveillant: {
    url: "https://urlhaus.abuse.ch/downloads/hostfile/",
    nom: "URLhaus (abuse.ch)",
    taille: "quelques milliers de domaines",
  },
};

const [, , code, argument, ...options] = process.argv;
const remplacer = options.includes("--remplacer");
const recommandee = argument === "--recommandee" || options.includes("--recommandee");

const CATEGORIES = [
  "publicite",
  "reseaux_sociaux",
  "streaming",
  "adulte",
  "jeux",
  "malveillant",
  "contournement",
];

if (!code || (!argument && !recommandee)) {
  console.error(`
Usage :

  LE PLUS SIMPLE — téléchargement et import en une commande :
    node tools\\importer-listes-web.js publicite --recommandee --remplacer

  DEPUIS UN FICHIER que vous avez déjà (réseau sans Internet) :
    node tools\\importer-listes-web.js publicite C:\\chemin\\liste.txt --remplacer

  DEPUIS UNE ADRESSE de votre choix :
    node tools\\importer-listes-web.js publicite https://exemple.com/liste.txt --remplacer

Catégories : ${CATEGORIES.join(", ")}

Options :
  --recommandee  télécharge la liste de référence de la catégorie
  --remplacer    vide la catégorie avant d'importer (sinon, ajoute)

Listes de référence disponibles :
${Object.entries(LISTES_RECOMMANDEES)
  .map(([c, l]) => `  ${c.padEnd(14)} ${l.nom}  (${l.taille})`)
  .join("\n")}
`);
  process.exit(1);
}

/**
 * Télécharge une liste dans un fichier temporaire.
 *
 * Suit les redirections : les listes publiques sont souvent servies
 * derrière un raccourcisseur ou un miroir, et un 301 non suivi produit
 * un fichier de trois lignes de HTML — donc un import qui « réussit »
 * avec zéro domaine, ce qui est bien pire qu'une erreur franche.
 */
function telecharger(url, destination, redirections = 0) {
  return new Promise((resolve, reject) => {
    if (redirections > 5) return reject(new Error("Trop de redirections"));

    https
      .get(url, { headers: { "User-Agent": "NetSecureManager" } }, (reponse) => {
        if ([301, 302, 307, 308].includes(reponse.statusCode)) {
          reponse.resume();
          const suivante = new URL(reponse.headers.location, url).toString();
          return telecharger(suivante, destination, redirections + 1).then(resolve, reject);
        }
        if (reponse.statusCode !== 200) {
          reponse.resume();
          return reject(new Error(`Le serveur a répondu ${reponse.statusCode}`));
        }

        const total = Number(reponse.headers["content-length"]) || 0;
        let recus = 0;
        const sortie = fs.createWriteStream(destination);

        reponse.on("data", (morceau) => {
          recus += morceau.length;
          const pct = total ? ` (${Math.round((recus / total) * 100)} %)` : "";
          process.stdout.write(`\r  Téléchargement : ${(recus / 1048576).toFixed(1)} Mo${pct}   `);
        });

        reponse.pipe(sortie);
        sortie.on("finish", () => {
          process.stdout.write("\r" + " ".repeat(60) + "\r");
          sortie.close(() => resolve(recus));
        });
        sortie.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Extrait un domaine d'une ligne, quel que soit son format. */
function domaineDeLigne(ligne) {
  let l = ligne.trim();
  if (!l || l.startsWith("#") || l.startsWith("!")) return null;

  // Format AdBlock : ||exemple.com^
  const adblock = l.match(/^\|\|([^\^$/]+)\^?/);
  if (adblock) l = adblock[1];

  // normaliserDomaine gère déjà le format hosts, les URL et le reste.
  return normaliserDomaine(l);
}

/**
 * Détermine le fichier à lire : local, téléchargé depuis une adresse, ou
 * téléchargé depuis la liste de référence de la catégorie.
 *
 * @returns {{ chemin: string, temporaire: boolean, provenance: string }}
 */
async function obtenirFichier() {
  let url = null;

  if (recommandee) {
    const liste = LISTES_RECOMMANDEES[code];
    if (!liste) {
      console.error(`\nAucune liste de référence pour la catégorie « ${code} ».`);
      console.error(`Catégories avec liste de référence : ${Object.keys(LISTES_RECOMMANDEES).join(", ")}`);
      console.error("\nPour les autres, fournissez un fichier ou une adresse :");
      console.error(`  node tools\\importer-listes-web.js ${code} C:\\chemin\\liste.txt --remplacer\n`);
      process.exit(1);
    }
    url = liste.url;
    console.log(`\nListe de référence : ${liste.nom}`);
    console.log(`Taille attendue    : ${liste.taille}`);
  } else if (/^https?:\/\//i.test(argument)) {
    url = argument;
  }

  if (!url) {
    if (!fs.existsSync(argument)) {
      console.error(`\nFichier introuvable : ${argument}`);
      console.error("\nVérifiez le chemin. Astuce : dans l'explorateur Windows, clic droit");
      console.error("sur le fichier -> « Copier en tant que chemin d'accès ».");
      console.error("\nOu laissez l'outil le télécharger tout seul :");
      console.error(`  node tools\\importer-listes-web.js ${code} --recommandee --remplacer\n`);
      process.exit(1);
    }
    return { chemin: argument, temporaire: false, provenance: argument };
  }

  const destination = path.join(os.tmpdir(), `nsm-liste-${code}-${process.pid}.txt`);
  console.log(`\nSource : ${url}`);
  try {
    const octets = await telecharger(url, destination);
    console.log(`  ${(octets / 1048576).toFixed(1)} Mo téléchargés.`);
  } catch (err) {
    console.error(`\nTéléchargement impossible : ${err.message}`);
    console.error("\nCauses fréquentes :");
    console.error("  • pas d'accès Internet depuis cette machine ;");
    console.error("  • un proxy d'entreprise bloque la sortie ;");
    console.error("  • l'adresse a changé.");
    console.error("\nDans ce cas, téléchargez le fichier depuis un navigateur, puis :");
    console.error(`  node tools\\importer-listes-web.js ${code} C:\\chemin\\du\\fichier.txt --remplacer\n`);
    process.exit(1);
  }
  return { chemin: destination, temporaire: true, provenance: url };
}

(async () => {
  const source = await obtenirFichier();
  const fichier = source.chemin;

  const [[categorie]] = await db.query(
    "SELECT id_categorie, libelle FROM CATEGORIE_WEB WHERE code = ?",
    [code]
  );
  if (!categorie) {
    const [toutes] = await db.query("SELECT code FROM CATEGORIE_WEB ORDER BY code");
    console.error(`\nCatégorie inconnue : ${code}`);
    console.error(`Catégories disponibles : ${toutes.map((c) => c.code).join(", ")}\n`);
    console.error("Si la liste est vide, la migration 2026-08-19-controle-acces-web.sql");
    console.error("n'a pas été exécutée.\n");
    process.exit(1);
  }

  console.log(`\nCatégorie : ${categorie.libelle}`);
  console.log(`Mode      : ${remplacer ? "remplacement" : "ajout"}\n`);

  if (remplacer) {
    const [r] = await db.query("DELETE FROM DOMAINE_CATEGORIE WHERE id_categorie = ?", [
      categorie.id_categorie,
    ]);
    console.log(`  ${r.affectedRows} ancien(s) domaine(s) supprimé(s).`);

    // Le compteur est remis à zéro TOUT DE SUITE, et non seulement à la
    // fin. Si l'import s'interrompt en cours de route — coupure réseau,
    // machine éteinte — l'écran doit montrer une catégorie manifestement
    // incomplète plutôt qu'un décompte rassurant hérité de la veille.
    // Un chiffre faux se remarque moins qu'un zéro, donc se corrige plus
    // tard : c'est exactement ce qu'on veut éviter sur un blocage.
    await db.query(
      "UPDATE CATEGORIE_WEB SET nb_domaines = 0, date_import = NULL WHERE id_categorie = ?",
      [categorie.id_categorie]
    );
  }

  // ───────────────────────────────────────────────────────────────
  // LECTURE SANS `readline`.
  //
  // La version précédente utilisait readline.createInterface() puis
  // `for await (const ligne of flux)`. Elle échouait au bout de quelques
  // dizaines de milliers de lignes :
  //
  //   Import interrompu : readline was closed
  //
  // Cause : chaque paquet de 1 000 domaines déclenche une insertion en
  // base, donc une attente de plusieurs dizaines de millisecondes. Sur
  // une lecture longue avec un consommateur lent, readline ferme son
  // interface pendant qu'on attend encore, et l'itérateur rejette au
  // tour suivant. Le fichier n'y est pour rien — l'import s'arrêtait au
  // milieu, après avoir déjà vidé la catégorie.
  //
  // On découpe donc les lignes soi-même sur le flux brut. L'itération
  // d'un ReadStream se met en pause correctement pendant un `await`, ce
  // que readline ne garantit pas ici. Moins de dépendances, et le
  // comportement est celui qu'on attend.
  // ───────────────────────────────────────────────────────────────

  // Insertion par paquets : une requête par domaine mettrait des heures
  // sur une liste de 200 000 entrées, et saturerait le journal MySQL.
  const PAQUET = 1000;
  let tampon = [];
  let lues = 0;
  let retenues = 0;
  let ignorees = 0;

  async function vider() {
    if (tampon.length === 0) return;
    await db.query(
      `INSERT IGNORE INTO DOMAINE_CATEGORIE (id_categorie, domaine) VALUES ${tampon
        .map(() => "(?, ?)")
        .join(",")}`,
      tampon.flatMap((d) => [categorie.id_categorie, d])
    );
    tampon = [];
  }

  async function traiterLigne(ligne) {
    lues++;
    const d = domaineDeLigne(ligne);
    if (!d) {
      ignorees++;
      return;
    }
    tampon.push(d);
    retenues++;

    if (tampon.length >= PAQUET) {
      await vider();
      process.stdout.write(`\r  ${retenues} domaine(s) importé(s)...`);
    }
  }

  const flux = fs.createReadStream(fichier, { encoding: "utf8" });
  let reste = "";

  for await (const morceau of flux) {
    // La dernière ligne d'un morceau est presque toujours incomplète :
    // on la garde pour la recoller au morceau suivant. Sans cela, un
    // domaine serait coupé en deux tous les 64 Ko et rejeté comme
    // invalide — une perte silencieuse et difficile à remarquer.
    const lignes = (reste + morceau).split("\n");
    reste = lignes.pop();

    for (const ligne of lignes) {
      await traiterLigne(ligne);
    }
  }
  // La toute dernière ligne, si le fichier ne se termine pas par un saut.
  if (reste) await traiterLigne(reste);

  await vider();
  process.stdout.write("\r" + " ".repeat(50) + "\r");

  // Le décompte réel vient de la base, pas du compteur : INSERT IGNORE
  // écarte les doublons, et annoncer « 200 000 importés » quand la table
  // en contient 140 000 serait faux.
  const [[{ n }]] = await db.query(
    "SELECT COUNT(*) AS n FROM DOMAINE_CATEGORIE WHERE id_categorie = ?",
    [categorie.id_categorie]
  );

  await db.query(
    "UPDATE CATEGORIE_WEB SET nb_domaines = ?, date_import = NOW(), source = ? WHERE id_categorie = ?",
    // On enregistre la PROVENANCE (l'adresse ou le chemin d'origine), pas
    // le fichier temporaire : « C:\Temp\nsm-liste-publicite-8412.txt »
    // n'apprendrait rien à celui qui consultera l'écran dans six mois.
    [n, source.provenance.slice(0, 255), categorie.id_categorie]
  );

  console.log(`  Lignes lues        : ${lues}`);
  console.log(`  Lignes ignorées    : ${ignorees}  (commentaires, lignes vides, entrées invalides)`);
  console.log(`  Domaines retenus   : ${retenues}`);
  console.log(`  Total en catégorie : ${n}  (doublons écartés)\n`);

  if (n === 0) {
    console.log("  ⚠ Aucun domaine en base. Le fichier est-il au bon format ?");
    console.log("    Attendu : un domaine par ligne, ou format hosts, ou AdBlock.\n");
  } else {
    console.log("  ✓ Import terminé. La politique sera distribuée aux agents");
    console.log("    au prochain enregistrement depuis l'écran « Accès web ».\n");
  }

  // Ménage du fichier temporaire : sans cela, chaque import laisserait
  // 5 Mo derrière lui dans le dossier temporaire de Windows.
  if (source.temporaire) {
    try {
      fs.unlinkSync(fichier);
    } catch {
      /* le dossier temporaire sera nettoyé par Windows de toute façon */
    }
  }

  process.exit(0);
})().catch((err) => {
  console.error("\nImport interrompu :", err.message);
  if (err.code === "ER_NO_SUCH_TABLE") {
    console.error("\nLa migration 2026-08-19-controle-acces-web.sql n'a pas été exécutée.\n");
  }
  process.exit(1);
});
