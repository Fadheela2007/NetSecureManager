/**
 * agent-poste/collecteurs.js
 * Ce qu'une machine sait d'elle-même, et que le réseau ne peut pas voir.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SÉPARATION VOULUE : LIRE D'UN CÔTÉ, COMPRENDRE DE L'AUTRE
 *
 * Chaque source d'information est découpée en deux : une fonction qui
 * EXÉCUTE la commande du système, et une fonction pure qui ANALYSE son
 * texte. Seule la seconde contient de la logique, et c'est elle qui est
 * testée — sans Windows, sans PowerShell, sans machine réelle.
 *
 * Ce découpage n'est pas cosmétique. L'analyse d'un `tasklist` en CSV ou
 * d'un `dpkg -l` est exactement le genre de code qui marche sur l'exemple
 * du développeur et casse sur le poste du client : un nom avec une
 * virgule, un accent, une colonne vide. Le rendre testable sans machine
 * est la seule façon d'en fixer le comportement.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUI N'EST PAS COLLECTÉ, ET POURQUOI
 *
 * Pas de nom d'utilisateur par défaut. La liste des programmes qu'une
 * personne fait tourner dit beaucoup d'elle, et un outil de supervision
 * n'a pas besoin de le savoir pour faire son travail. La collecte du nom
 * d'utilisateur existe, mais elle est ÉTEINTE tant que l'exploitant ne
 * l'allume pas — un choix qu'un client doit poser consciemment.
 *
 * Pas de ligne de commande complète non plus : elle contient
 * régulièrement des mots de passe, des jetons et des chemins de fichiers
 * personnels. Le nom de l'exécutable suffit à répondre aux questions
 * qu'on pose à un inventaire.
 */
const { exec } = require("node:child_process");
const os = require("node:os");

const DELAI_COMMANDE_MS = 25_000;
const TAILLE_MAX_SORTIE = 8 * 1024 * 1024;

/** Exécute une commande et rend sa sortie, ou null si elle échoue. */
function lancer(commande, options = {}) {
  return new Promise((resolve) => {
    exec(
      commande,
      { timeout: DELAI_COMMANDE_MS, maxBuffer: TAILLE_MAX_SORTIE, windowsHide: true, ...options },
      (err, stdout) => {
        // Une commande absente ou refusée ne doit jamais arrêter l'agent :
        // un inventaire partiel vaut mieux qu'un agent mort, et le serveur
        // sait déjà distinguer « vide » de « pas reçu ».
        if (err && !stdout) return resolve(null);
        resolve(String(stdout || ""));
      }
    );
  });
}

/* ═══════════════════════════════════════════════════════════════════
   PROCESSUS
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Découpe une ligne CSV en respectant les guillemets.
 * « "chrome.exe","1234","Console","1","250 000 Ko" » — et le nom d'un
 * exécutable PEUT contenir une virgule. Un `split(",")` naïf décalerait
 * alors toutes les colonnes, et la mémoire d'un processus se retrouverait
 * dans son nom.
 */
function decouperCsv(ligne) {
  const champs = [];
  let courant = "";
  let dansGuillemets = false;

  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i];
    if (c === '"') {
      // Deux guillemets consécutifs à l'intérieur d'un champ = un
      // guillemet littéral.
      if (dansGuillemets && ligne[i + 1] === '"') {
        courant += '"';
        i++;
      } else {
        dansGuillemets = !dansGuillemets;
      }
    } else if (c === "," && !dansGuillemets) {
      champs.push(courant);
      courant = "";
    } else {
      courant += c;
    }
  }
  champs.push(courant);
  return champs;
}

/**
 * Convertit « 250 000 Ko », « 250,000 K », « 1 234 Ko » en nombre.
 * Windows sépare les milliers selon la langue du système : espace
 * insécable en français, virgule en anglais. Ignorer ce détail donnait
 * 250 au lieu de 250 000.
 */
function memoireEnKo(texte) {
  const chiffres = String(texte || "").replace(/[^\d]/g, "");
  return chiffres ? Number(chiffres) : null;
}

/**
 * Analyse la sortie de `tasklist /fo csv`.
 * Regroupe par nom : un navigateur ouvre vingt processus, et les lister
 * vingt fois ne dit rien de plus que « il tourne, en vingt exemplaires ».
 */
function analyserTasklist(sortie, avecUtilisateur = false) {
  const lignes = String(sortie || "").split(/\r?\n/).filter((l) => l.trim());
  const parNom = new Map();

  for (const ligne of lignes) {
    const champs = decouperCsv(ligne);
    const nom = (champs[0] || "").trim();
    // L'en-tête répète le libellé de colonne ; on l'écarte sans supposer
    // la langue du système, en testant la valeur et non sa position.
    if (!nom || /^nom de l|^image name$/i.test(nom)) continue;
    if (!/\.(exe|com|scr)$/i.test(nom) && !/^system|^registry$/i.test(nom)) continue;

    // Avec /v, l'utilisateur est en colonne 7 ; sans /v, il n'y est pas.
    const utilisateur = avecUtilisateur ? (champs[6] || "").trim() || null : null;
    const memoire = memoireEnKo(champs[4]);

    const existant = parNom.get(nom);
    if (existant) {
      existant.occurrences++;
      if (memoire) existant.memoire_ko = (existant.memoire_ko || 0) + memoire;
    } else {
      parNom.set(nom, { nom, occurrences: 1, memoire_ko: memoire, utilisateur });
    }
  }

  return [...parNom.values()];
}

/** Analyse la sortie de `ps -eo comm=,rss=` (Linux, macOS). */
function analyserPs(sortie) {
  const parNom = new Map();
  for (const ligne of String(sortie || "").split(/\r?\n/)) {
    const m = ligne.trim().match(/^(\S+)\s+(\d+)$/);
    if (!m) continue;
    const nom = m[1].split("/").pop();
    const memoire = Number(m[2]);
    const existant = parNom.get(nom);
    if (existant) {
      existant.occurrences++;
      existant.memoire_ko += memoire;
    } else {
      parNom.set(nom, { nom, occurrences: 1, memoire_ko: memoire, utilisateur: null });
    }
  }
  return [...parNom.values()];
}

async function collecterProcessus(avecUtilisateur = false) {
  if (process.platform === "win32") {
    const sortie = await lancer(`tasklist /fo csv${avecUtilisateur ? " /v" : ""}`);
    return sortie ? analyserTasklist(sortie, avecUtilisateur) : [];
  }
  const sortie = await lancer("ps -eo comm=,rss=");
  return sortie ? analyserPs(sortie) : [];
}

/* ═══════════════════════════════════════════════════════════════════
   LOGICIELS INSTALLÉS
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Registre Windows, les DEUX ruches.
 *
 * Un logiciel 32 bits installé sur un Windows 64 bits n'apparaît que sous
 * `WOW6432Node`. N'interroger que la ruche principale fait manquer une
 * bonne partie d'un parc bureautique — et cette moitié manquante ne se
 * voit pas : la liste a l'air complète.
 */
const COMMANDE_LOGICIELS_WINDOWS = [
  "powershell -NoProfile -NonInteractive -Command",
  '"Get-ItemProperty',
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*,",
  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "-ErrorAction SilentlyContinue |",
  "Where-Object { $_.DisplayName } |",
  "Select-Object DisplayName, DisplayVersion, Publisher, InstallDate |",
  'ConvertTo-Json -Compress"',
].join(" ");

/**
 * Analyse la réponse JSON de PowerShell.
 *
 * PIÈGE : `ConvertTo-Json` rend un OBJET quand il n'y a qu'un résultat,
 * et un TABLEAU au-delà. Un code qui suppose toujours un tableau perd
 * silencieusement le cas à un seul logiciel.
 */
function analyserLogicielsWindows(json) {
  let donnees;
  try {
    donnees = JSON.parse(String(json || "").trim() || "null");
  } catch {
    return [];
  }
  if (!donnees) return [];
  const liste = Array.isArray(donnees) ? donnees : [donnees];

  return liste
    .filter((l) => l && l.DisplayName)
    .map((l) => ({
      nom: String(l.DisplayName).trim().slice(0, 200),
      version: l.DisplayVersion ? String(l.DisplayVersion).trim().slice(0, 80) : null,
      editeur: l.Publisher ? String(l.Publisher).trim().slice(0, 150) : null,
      date_installation: dateInstallationWindows(l.InstallDate),
    }));
}

/** Le registre écrit la date en « AAAAMMJJ », sans séparateur. */
function dateInstallationWindows(brut) {
  const m = String(brut || "").match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, a, mo, j] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(j) < 1 || Number(j) > 31) return null;
  return `${a}-${mo}-${j}`;
}

/** Analyse `dpkg-query -W -f='${Package}\t${Version}\t${Maintainer}\n'`. */
function analyserDpkg(sortie) {
  return String(sortie || "")
    .split(/\r?\n/)
    .map((ligne) => ligne.split("\t"))
    .filter((c) => c[0] && c[0].trim())
    .map((c) => ({
      nom: c[0].trim().slice(0, 200),
      version: c[1] ? c[1].trim().slice(0, 80) : null,
      editeur: c[2] ? c[2].trim().slice(0, 150) : null,
      date_installation: null,
    }));
}

async function collecterLogiciels() {
  if (process.platform === "win32") {
    const sortie = await lancer(COMMANDE_LOGICIELS_WINDOWS);
    return sortie ? analyserLogicielsWindows(sortie) : [];
  }
  const sortie = await lancer(
    "dpkg-query -W -f='${Package}\\t${Version}\\t${Maintainer}\\n' 2>/dev/null"
  );
  return sortie ? analyserDpkg(sortie) : [];
}

/* ═══════════════════════════════════════════════════════════════════
   IDENTITÉ DE LA MACHINE
   ═══════════════════════════════════════════════════════════════════ */

/**
 * L'adresse à laquelle cette machine est connue du reste du réseau.
 *
 * Les interfaces internes (127.0.0.1) et les cartes virtuelles sont
 * écartées : une machine qui s'annoncerait en 127.0.0.1 ne pourrait être
 * rapprochée d'aucun équipement de l'inventaire, et l'agent semblerait ne
 * rien remonter.
 */
function identite(interfaces = os.networkInterfaces()) {
  for (const [nom, groupe] of Object.entries(interfaces || {})) {
    if (/^(lo|vEthernet|VirtualBox|VMware|Loopback|docker|br-|veth)/i.test(nom)) continue;
    for (const c of groupe || []) {
      if ((c.family === "IPv4" || c.family === 4) && !c.internal && c.address) {
        return { adresse_ip: c.address, adresse_mac: c.mac && c.mac !== "00:00:00:00:00:00" ? c.mac : null };
      }
    }
  }
  return { adresse_ip: null, adresse_mac: null };
}

function systeme() {
  return {
    nom_machine: os.hostname(),
    // « Windows_NT 10.0.19045 » : le type seul ne distingue pas Windows 10
    // de Windows 7, et c'est précisément ce qu'on veut savoir d'un parc.
    systeme: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
  };
}

module.exports = {
  collecterProcessus,
  collecterLogiciels,
  identite,
  systeme,
  // Exportées pour les tests : ce sont elles qui portent la logique.
  decouperCsv,
  memoireEnKo,
  analyserTasklist,
  analyserPs,
  analyserLogicielsWindows,
  analyserDpkg,
  dateInstallationWindows,
};
