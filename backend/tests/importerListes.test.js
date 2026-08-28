/**
 * tests/importerListes.test.js
 *
 * Reproduit la panne observée en production :
 *
 *   95000 domaine(s) importé(s)...
 *   Import interrompu : readline was closed
 *
 * L'import s'arrêtait au milieu — APRÈS avoir vidé la catégorie. La
 * conséquence est pire que l'erreur elle-même : la plateforme se
 * retrouvait avec une liste tronquée, et rien ne l'indiquait. L'écran
 * aurait affiché « 95 000 domaines » avec l'air d'aller bien.
 *
 * Cause : chaque paquet de 1 000 domaines déclenche une insertion en
 * base, donc une attente. Sur une lecture longue avec un consommateur
 * lent, readline ferme son interface pendant qu'on attend encore.
 *
 * Ces tests vérifient la lecture ligne à ligne sur un VRAI fichier de
 * 180 000 lignes, avec des insertions volontairement lentes — les deux
 * conditions qui déclenchaient la panne.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normaliserDomaine } = require("../src/services/politiqueWebService");

/**
 * Reprise exacte de la lecture de l'outil : découpage manuel des lignes
 * sur le flux brut, sans readline.
 *
 * Le test porte sur CETTE mécanique — celle qui cassait — et non sur
 * l'outil complet, qui exige une base de données.
 */
async function lireParLignes(chemin, traiter) {
  const flux = fs.createReadStream(chemin, { encoding: "utf8" });
  let reste = "";

  for await (const morceau of flux) {
    const lignes = (reste + morceau).split("\n");
    reste = lignes.pop();
    for (const ligne of lignes) await traiter(ligne);
  }
  if (reste) await traiter(reste);
}

/** Fichier temporaire au format hosts, supprimé après le test. */
function fichierTemporaire(contenu) {
  const chemin = path.join(os.tmpdir(), `nsm-test-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

// ─────────────────────────────────────────────────────────────────────
test("180 000 lignes avec des insertions lentes : aucune interruption", async () => {
  // Le scénario exact de la panne. 180 lots de 1 000, chacun suivi d'une
  // attente — c'est cette attente répétée qui fermait readline.
  const lignes = [];
  for (let i = 0; i < 180_000; i++) lignes.push(`0.0.0.0 pub-${i}.exemple-${i % 900}.com`);
  const chemin = fichierTemporaire(lignes.join("\n") + "\n");

  let retenues = 0;
  let tampon = 0;

  try {
    await lireParLignes(chemin, async (ligne) => {
      const d = normaliserDomaine(ligne);
      if (!d) return;
      retenues++;
      if (++tampon >= 1000) {
        tampon = 0;
        // Insertion simulée : une attente réelle, pas un Promise.resolve
        // immédiat qui ne reproduirait rien.
        await new Promise((r) => setTimeout(r, 1));
      }
    });
  } finally {
    fs.unlinkSync(chemin);
  }

  assert.strictEqual(retenues, 180_000, "toutes les lignes doivent être lues");
});

test("une ligne coupée entre deux morceaux du flux est recollée", async () => {
  // C'est le piège de la lecture manuelle : le flux découpe par blocs de
  // 64 Ko, pas par lignes. Sans recollage, un domaine serait tronqué tous
  // les 64 Ko et rejeté comme invalide — une perte silencieuse que
  // personne ne remarquerait sur 180 000 entrées.
  const lignes = [];
  for (let i = 0; i < 20_000; i++) {
    lignes.push(`0.0.0.0 domaine-tres-long-pour-traverser-les-blocs-${i}.exemple.com`);
  }
  const chemin = fichierTemporaire(lignes.join("\n") + "\n");

  const vus = [];
  try {
    await lireParLignes(chemin, async (ligne) => {
      const d = normaliserDomaine(ligne);
      if (d) vus.push(d);
    });
  } finally {
    fs.unlinkSync(chemin);
  }

  assert.strictEqual(vus.length, 20_000, "aucune ligne perdue ni coupée");
  assert.strictEqual(vus[0], "domaine-tres-long-pour-traverser-les-blocs-0.exemple.com");
  assert.strictEqual(
    vus[19_999],
    "domaine-tres-long-pour-traverser-les-blocs-19999.exemple.com"
  );
});

test("la dernière ligne est lue même sans saut de ligne final", async () => {
  // Un fichier enregistré depuis un navigateur se termine souvent sans
  // saut de ligne. Le dernier domaine serait perdu.
  const chemin = fichierTemporaire("0.0.0.0 premier.com\n0.0.0.0 dernier.com");

  const vus = [];
  try {
    await lireParLignes(chemin, async (l) => {
      const d = normaliserDomaine(l);
      if (d) vus.push(d);
    });
  } finally {
    fs.unlinkSync(chemin);
  }

  assert.deepStrictEqual(vus, ["premier.com", "dernier.com"]);
});

test("les fins de ligne Windows (CRLF) ne laissent pas de retour chariot", async () => {
  // Un fichier téléchargé sous Windows arrive en \r\n. Sans traitement,
  // le domaine deviendrait « exemple.com\r » — invalide, donc rejeté.
  const chemin = fichierTemporaire("0.0.0.0 exemple.com\r\n0.0.0.0 autre.com\r\n");

  const vus = [];
  try {
    await lireParLignes(chemin, async (l) => {
      const d = normaliserDomaine(l);
      if (d) vus.push(d);
    });
  } finally {
    fs.unlinkSync(chemin);
  }

  assert.deepStrictEqual(vus, ["exemple.com", "autre.com"]);
});

test("un fichier vide ne plante pas", async () => {
  const chemin = fichierTemporaire("");
  let appels = 0;
  try {
    await lireParLignes(chemin, async () => {
      appels++;
    });
  } finally {
    fs.unlinkSync(chemin);
  }
  assert.strictEqual(appels, 0);
});

// ─────────────────────────────────────────────────────────────────────
test("le format hosts réel de StevenBlack est correctement interprété", async () => {
  // Extrait fidèle : en-tête de commentaires, entrées 0.0.0.0, lignes
  // vides, et les redirections locales qu'il ne faut PAS importer comme
  // domaines à bloquer.
  const contenu = [
    "# Title: StevenBlack/hosts",
    "# This hosts file is a merged collection",
    "",
    "127.0.0.1 localhost",
    "::1 localhost",
    "0.0.0.0 0.0.0.0",
    "",
    "# Start of publicite",
    "0.0.0.0 pub.exemple.com",
    "0.0.0.0 traceur.net # régie",
    "0.0.0.0 ads.exemple.org",
  ].join("\n");

  const chemin = fichierTemporaire(contenu);
  const vus = [];
  try {
    await lireParLignes(chemin, async (l) => {
      const t = l.trim();
      if (!t || t.startsWith("#") || t.startsWith("!")) return;
      const d = normaliserDomaine(t);
      if (d) vus.push(d);
    });
  } finally {
    fs.unlinkSync(chemin);
  }

  assert.deepStrictEqual(vus, ["pub.exemple.com", "traceur.net", "ads.exemple.org"]);

  // « localhost » et « 0.0.0.0 » ne sont pas des domaines bloquables :
  // les importer créerait des règles qui ne correspondent à rien.
  assert.ok(!vus.includes("localhost"));
  assert.ok(!vus.includes("0.0.0.0"));
});
