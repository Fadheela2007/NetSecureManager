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

/* ═══════════════════════════════════════════════════════════════════════
   LA MESURE : PROCESSEUR, MÉMOIRE, COMPTEURS RÉSEAU

   ── POURQUOI L'AGENT DOIT S'EN CHARGER ──

   Le débit et la charge se lisent normalement en SNMP. Or les postes
   Windows n'ont plus de service SNMP : la page Bande passante ne montrait
   donc que les imprimantes et les commutateurs, seuls appareils d'un parc
   à accepter de dire ce qu'ils consomment.

   Cette machine, elle, se connaît. C'est la mesure la plus exacte qui
   soit — et la seule qui couvre le WiFi.

   ── ON ENVOIE DES COMPTEURS, PAS UN DÉBIT ──

   Le serveur fait la différence entre deux envois, avec la fonction qui
   traite déjà le SNMP. Calculer le débit ici aurait donné une deuxième
   implémentation du même calcul — débordement de compteur, redémarrage,
   boucle locale — qui aurait dérivé de la première au premier correctif
   appliqué d'un seul côté.
   ═══════════════════════════════════════════════════════════════════════ */

/** Somme des compteurs de temps d'un cœur. */
function ticksTotal(cpu) {
  const t = cpu.times || {};
  return (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
}

/**
 * Charge processeur, en pourcentage, à partir de DEUX échantillons.
 *
 * Fonction pure : elle ne lit rien elle-même. `os.cpus()` rend des
 * compteurs de temps CUMULÉS depuis le démarrage — un seul échantillon
 * donnerait la moyenne depuis l'allumage de la machine, c'est-à-dire un
 * chiffre qui ne bouge plus au bout de quelques jours.
 */
function chargeDepuisEchantillons(avant, apres) {
  if (!Array.isArray(avant) || !Array.isArray(apres)) return null;
  if (avant.length === 0 || avant.length !== apres.length) return null;

  let totalDelta = 0;
  let inactifDelta = 0;

  for (let i = 0; i < avant.length; i++) {
    totalDelta += ticksTotal(apres[i]) - ticksTotal(avant[i]);
    inactifDelta += (apres[i].times?.idle || 0) - (avant[i].times?.idle || 0);
  }

  // Aucun temps écoulé, ou compteurs remis à zéro : on ne sait pas.
  if (totalDelta <= 0 || inactifDelta < 0) return null;

  const pourcent = (1 - inactifDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, pourcent)) * 10) / 10;
}

/** Deux échantillons espacés d'une seconde, et la charge entre les deux. */
async function chargeProcesseur(delaiMs = 1000) {
  try {
    const avant = os.cpus();
    await new Promise((r) => setTimeout(r, delaiMs));
    return chargeDepuisEchantillons(avant, os.cpus());
  } catch {
    return null;
  }
}

/** Mémoire, telle que le système la rapporte. En Mo, comme le serveur l'attend. */
function memoire() {
  try {
    const total = os.totalmem();
    const libre = os.freemem();
    if (!total || total <= 0) return null;
    return {
      memoire_totale_mo: Math.round(total / 1024 / 1024),
      memoire_libre_mo: Math.round(libre / 1024 / 1024),
    };
  } catch {
    return null;
  }
}

/**
 * Analyse `/proc/net/dev` (Linux). Fonction pure, donc testable.
 *
 * Les colonnes ne sont pas alignées et leur nombre a changé selon les
 * versions du noyau : on découpe sur le « : » qui suit le nom, puis sur
 * les espaces. Les octets reçus sont la 1re valeur, les émis la 9e.
 */
function analyserProcNetDev(texte) {
  const cartes = [];
  let rang = 0;

  for (const ligne of String(texte || "").split("\n")) {
    const sep = ligne.indexOf(":");
    if (sep === -1) continue;

    const nom = ligne.slice(0, sep).trim();
    if (!nom || /^inter-|^ face/i.test(nom)) continue;

    const valeurs = ligne.slice(sep + 1).trim().split(/\s+/).map(Number);
    if (valeurs.length < 9 || !Number.isFinite(valeurs[0]) || !Number.isFinite(valeurs[8])) {
      continue;
    }

    rang++;
    cartes.push({
      index: rang,
      nom,
      in_octets: valeurs[0],
      out_octets: valeurs[8],
      vitesse_mbps: null,
    });
  }

  return cartes.length > 0 ? cartes : null;
}

/**
 * Analyse la sortie JSON de Get-NetAdapterStatistics (Windows).
 *
 * `ConvertTo-Json` rend un OBJET quand il n'y a qu'une carte, et un
 * TABLEAU au-delà. Une machine à une seule carte réseau — le cas d'un
 * portable — aurait donc planté un code qui suppose un tableau.
 */
function analyserCartesWindows(json) {
  let brut;
  try {
    brut = JSON.parse(String(json || ""));
  } catch {
    return null;
  }

  const liste = Array.isArray(brut) ? brut : [brut];
  const cartes = [];
  let rang = 0;

  for (const c of liste) {
    if (!c || !c.Name) continue;

    /* `Number(null)` vaut 0, et `Number.isFinite(0)` vaut true : une
       carte dont PowerShell n'a pas su lire les compteurs serait entrée
       dans la liste avec « 0 octet ». Au relevé suivant, la différence
       aurait produit un pic énorme sorti de nulle part. On écarte donc
       l'absence AVANT de convertir. */
    if (c.ReceivedBytes === null || c.ReceivedBytes === undefined) continue;
    if (c.SentBytes === null || c.SentBytes === undefined) continue;

    const entrant = Number(c.ReceivedBytes);
    const sortant = Number(c.SentBytes);
    if (!Number.isFinite(entrant) || !Number.isFinite(sortant)) continue;

    rang++;
    cartes.push({
      // ifIndex quand Windows le donne : c'est le même numéro d'un envoi
      // à l'autre, ce qui est tout ce qu'on demande à cette clé.
      index: Number.isFinite(Number(c.ifIndex)) && Number(c.ifIndex) > 0
        ? Number(c.ifIndex)
        : rang,
      nom: String(c.Name),
      in_octets: entrant,
      out_octets: sortant,
      vitesse_mbps: null,
    });
  }

  return cartes.length > 0 ? cartes : null;
}

/**
 * Les compteurs de toutes les cartes réseau de cette machine.
 *
 * `null` veut dire « je n'ai pas pu regarder » — jamais « zéro ». Sur un
 * Windows trop ancien pour Get-NetAdapterStatistics, le serveur
 * n'écrira simplement aucun débit, ce qui est la vérité.
 *
 * La boucle locale n'est PAS filtrée ici : le serveur l'écarte sur son
 * nom, avec le même filtre que pour le SNMP. Une seule règle, un seul
 * endroit — et la fiche de l'équipement peut malgré tout montrer cette
 * interface en la marquant « hors total ».
 */
async function compteursReseau() {
  if (process.platform === "win32") {
    const sortie = await lancer(
      "powershell -NoProfile -NonInteractive -Command " +
        "\"Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress\""
    );
    return sortie ? analyserCartesWindows(sortie) : null;
  }

  if (process.platform === "linux") {
    const sortie = await lancer("cat /proc/net/dev");
    return sortie ? analyserProcNetDev(sortie) : null;
  }

  // macOS et le reste : pas de source fiable et portable. On ne devine pas.
  return null;
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
  chargeProcesseur,
  memoire,
  compteursReseau,
  // Exportées pour les tests : l'analyse porte la logique, pas la commande.
  chargeDepuisEchantillons,
  analyserProcNetDev,
  analyserCartesWindows,
  // Exportées pour les tests : ce sont elles qui portent la logique.
  decouperCsv,
  memoireEnKo,
  analyserTasklist,
  analyserPs,
  analyserLogicielsWindows,
  analyserDpkg,
  dateInstallationWindows,
};
