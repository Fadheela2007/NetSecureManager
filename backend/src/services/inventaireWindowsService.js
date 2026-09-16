/**
 * services/inventaireWindowsService.js
 * Ce qui tourne sur un poste Windows, sans rien installer dessus.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI CETTE VOIE EXISTE
 *
 * Mesuré sur un parc réel de 105 équipements : 7 répondent en SNMP, et
 * ce sont sept imprimantes. Les 98 autres sont des postes Windows, qui
 * n'activent pas le service SNMP — ils n'ont donc rien dit de leur
 * intérieur, et aucun réglage n'y changera rien.
 *
 * WMI est la porte de ces 98 machines. C'est celle qu'utilisent toutes
 * les plateformes qui annoncent une « supervision Windows sans agent » :
 * le serveur interroge le poste, le poste répond, rien n'est installé.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LES TROIS CONDITIONS, ET CE QUI SE PASSE QUAND L'UNE MANQUE
 *
 *   1. Le serveur tourne sous Windows — PowerShell est le seul client
 *      WMI vraiment fiable. Sous Linux, ce module se déclare
 *      indisponible et le scan continue exactement comme avant.
 *   2. `WINDOWS_INVENTAIRE=1` dans backend/.env. Une seule ligne : le
 *      compte utilisé est par défaut celui sous lequel ce serveur
 *      tourne — voir estDisponible().
 *   3. WinRM ou DCOM joignable sur le poste. Le script PowerShell essaie
 *      les deux et dit laquelle a marché ; si aucune ne répond, la
 *      machine est simplement notée comme n'ayant rien dit.
 *
 * Aucune de ces trois absences ne fait échouer un scan. C'est la règle
 * de tout ce projet : une fonction qui ne peut pas s'exercer se tait,
 * elle ne casse pas ce qui marchait.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * S'IL Y A UN MOT DE PASSE, IL NE PASSE JAMAIS PAR LA LIGNE DE COMMANDE
 *
 * Le cas ordinaire n'en demande aucun. Mais quand un compte dédié est
 * configuré, `powershell -File script.ps1 -MotDePasse "..."` inscrirait
 * ce mot de passe dans la table des processus, lisible par n'importe
 * quel programme tournant sur le serveur, et dans les journaux d'audit
 * de Windows.
 *
 * Il est donc écrit sur l'ENTRÉE STANDARD du processus, qui n'est
 * visible de personne d'autre. C'est deux lignes de code de plus, et
 * c'est la différence entre un secret gardé et un secret affiché.
 *
 * Et il vit dans `backend/.env`, jamais en base : la table CONFIGURATION
 * est lisible par tout compte authentifié (ses valeurs sensibles sont
 * masquées par motif, mais un secret qu'on n'écrit pas est plus sûr
 * qu'un secret qu'on masque).
 */
const { execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "inventaire-windows.ps1");

/**
 * Délai maximal pour une machine.
 *
 * Une machine éteinte ou pare-feutée fait attendre la pile réseau : le
 * script PowerShell borne déjà ses propres appels à 12 secondes par
 * voie, et il en essaie deux. 40 secondes laissent donc la place aux
 * deux tentatives plus le démarrage de PowerShell, sans qu'un poste
 * récalcitrant puisse immobiliser le scan.
 */
const DELAI_MS = 40_000;

/** Taille maximale de la réponse JSON — un parc bavard reste borné. */
const MAX_SORTIE = 8 * 1024 * 1024;

let indisponibiliteSignalee = false;

/**
 * La lecture Windows peut-elle s'exercer ici ?
 *
 * ─────────────────────────────────────────────────────────────────────
 * LE MEILLEUR MOT DE PASSE EST CELUI QU'ON N'ÉCRIT NULLE PART
 *
 * Une première version exigeait un compte et un mot de passe dans le
 * `.env`. C'était une erreur de conception, pour une raison qu'un
 * exploitant voit tout de suite et qu'un développeur oublie : le serveur
 * de supervision tourne DÉJÀ sous un compte du domaine, celui de la
 * personne qui l'a démarré. Windows sait s'en servir pour ouvrir une
 * session sur un autre poste — c'est même son fonctionnement normal.
 *
 * Demander de recopier ce compte et son mot de passe dans un fichier,
 * c'est donc réclamer un secret pour refaire ce qui marche déjà, et
 * créer au passage un mot de passe de plus à protéger, à faire tourner
 * et à ne pas commiter par accident.
 *
 * `WINDOWS_INVENTAIRE=1` suffit donc. Les deux lignes d'identifiants
 * restent possibles — pour un serveur démarré en service sous un compte
 * local, ou pour utiliser un compte dédié plutôt que celui de
 * l'exploitant — mais elles ne sont plus la condition d'entrée.
 *
 * POURQUOI CE N'EST PAS ACTIF PAR DÉFAUT. Interroger cent postes est un
 * acte visible sur le réseau d'un client, et il figure dans les journaux
 * d'audit de chaque machine. Il doit être demandé, pas subi.
 */
function estDisponible() {
  if (process.platform !== "win32") return false;
  if (process.env.WINDOWS_INVENTAIRE === "0") return false;

  // Activée explicitement, OU par la simple présence d'identifiants —
  // personne ne renseigne un compte pour ensuite ne pas s'en servir.
  return (
    process.env.WINDOWS_INVENTAIRE === "1" ||
    Boolean(process.env.WINDOWS_UTILISATEUR && process.env.WINDOWS_MOT_DE_PASSE)
  );
}

/** Dit UNE fois pourquoi la fonction ne s'exerce pas. */
function signalerIndisponibilite() {
  if (indisponibiliteSignalee) return;
  indisponibiliteSignalee = true;

  if (process.platform !== "win32") {
    console.log(
      "Lecture Windows (WMI) inactive : ce serveur ne tourne pas sous Windows."
    );
    return;
  }
  if (process.env.WINDOWS_INVENTAIRE === "0") {
    console.log("Lecture Windows (WMI) désactivée par WINDOWS_INVENTAIRE=0.");
    return;
  }
  console.log(
    "\n  Lecture Windows (WMI) inactive : les postes Windows ne diront pas ce qui\n" +
      "  y tourne. Pour l'activer, une seule ligne dans backend/.env :\n\n" +
      "      WINDOWS_INVENTAIRE=1\n\n" +
      "  La plateforme utilisera alors le compte Windows sous lequel ce serveur\n" +
      "  a été démarré. Aucun mot de passe à écrire nulle part.\n"
  );
}

/**
 * Le compte à utiliser, ou `null` pour « celui de ce serveur ».
 *
 * Renvoyer deux lignes vides au script PowerShell n'est pas un défaut de
 * remplissage : c'est l'instruction « ouvre la session avec mes propres
 * droits », que PowerShell comprend parce qu'on ne lui passe alors aucun
 * paramètre `-Credential`.
 */
function identifiants() {
  const utilisateur = process.env.WINDOWS_UTILISATEUR || "";
  const motDePasse = process.env.WINDOWS_MOT_DE_PASSE || "";
  return utilisateur && motDePasse ? { utilisateur, motDePasse } : null;
}

/**
 * Interroge une machine.
 *
 * NE LÈVE JAMAIS. Un poste éteint, un refus d'accès ou un PowerShell en
 * erreur rendent un objet qui DIT ce qui s'est passé — jamais une
 * exception qui remonterait jusqu'au scan.
 *
 * @param {string} ip
 * @returns {Promise<{ok:boolean, raison?:string, voie?:string, systeme?:string,
 *                    processus?:Array|null, logiciels?:Array|null}>}
 */
function lireMachine(ip) {
  return new Promise((resolve) => {
    if (!estDisponible()) {
      signalerIndisponibilite();
      return resolve({ ok: false, raison: "non_configure" });
    }

    const enfant = execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT,
        "-Machine",
        ip,
      ],
      { timeout: DELAI_MS, maxBuffer: MAX_SORTIE, windowsHide: true },
      (erreur, sortie) => {
        if (!sortie) {
          // Délai dépassé, PowerShell absent, script introuvable : on le
          // dit sans distinguer, ces cas se corrigent tous au même
          // endroit et aucun ne doit interrompre le scan.
          return resolve({
            ok: false,
            raison: erreur?.killed ? "delai_depasse" : "powershell_indisponible",
          });
        }

        try {
          const objet = JSON.parse(String(sortie).trim());

          /* `processus` et `logiciels` peuvent valoir null, et c'est
             VOULU — voir la note sur null dans snmpInventaireLogiciel.
             `null` veut dire « je n'ai pas regardé » et ne touche à
             rien ; `[]` voudrait dire « j'ai regardé, il n'y a rien » et
             effacerait ce qu'une autre source a trouvé. PowerShell rend
             parfois un objet seul au lieu d'un tableau à un élément :
             on normalise ici. */
          const enTableau = (v) => (v === null || v === undefined ? null : [].concat(v));

          return resolve({
            ...objet,
            processus: enTableau(objet.processus),
            logiciels: enTableau(objet.logiciels),
          });
        } catch {
          // Le script a écrit autre chose que du JSON : une erreur
          // PowerShell non rattrapée. On garde le début du message, il
          // dit presque toujours ce qui manque.
          return resolve({
            ok: false,
            raison: "reponse_illisible",
            detail: String(sortie).slice(0, 200),
          });
        }
      }
    );

    /* Les identifiants, sur l'entrée standard, une ligne chacun.
       Deux lignes VIDES quand aucun compte n'est configuré : le script
       PowerShell y lit « sers-toi de tes propres droits ».

       `enfant.stdin` peut avoir déjà été fermé si PowerShell n'a pas
       démarré : on avale l'erreur, le rappel ci-dessus répondra. */
    const compte = identifiants();
    try {
      enfant.stdin.write(`${compte ? compte.utilisateur : ""}\n`);
      enfant.stdin.write(`${compte ? compte.motDePasse : ""}\n`);
      enfant.stdin.end();
    } catch {
      /* rien : le rappel d'execFile tranchera */
    }
  });
}

module.exports = { estDisponible, lireMachine, identifiants, DELAI_MS };
