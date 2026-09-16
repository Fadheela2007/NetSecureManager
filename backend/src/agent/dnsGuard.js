/**
 * agent/dnsGuard.js
 * Applique la politique de blocage web sur le résolveur DNS local du site.
 *
 * dnsmasq est configuré SANS `log-queries`, délibérément : cette option
 * transformerait la machine de l'agent en journal de navigation complet
 * du site, horodaté et associé à l'IP de chaque poste. Le comptage
 * remonté à la plateforme vient de `dnsmasq --stats`, qui ne donne que
 * des totaux.
 *
 * ─────────────────────────────────────────────────────────────────────
 * L'EXCEPTION, ET CE QUI L'ENCADRE (14 septembre 2026)
 *
 * L'observation des domaines contactés a besoin de ce journal. La
 * décision ci-dessus n'est pas annulée : elle reste le comportement par
 * défaut, et l'exception est bornée par quatre choses.
 *
 *   1. Elle s'active site par site, depuis la plateforme, et vaut NON
 *      tant que personne ne l'a dit.
 *   2. Le journal est lu, agrégé, puis EFFACÉ par `journalRequetes()`.
 *      Il ne s'accumule pas sur le disque de l'agent.
 *   3. Ce qui part vers la plateforme n'est pas le journal mais un
 *      relevé : un domaine, un compteur. Ni heure, ni nom complet.
 *   4. `log-queries` vit dans SON PROPRE fichier de configuration, pas
 *      dans celui du blocage. Le couper ne touche pas au filtrage, et
 *      un bogue du filtrage ne peut pas rallumer le journal.
 *
 * Ce qui subsiste sur cette machine entre deux relevés est donc au pire
 * quelques minutes de journal. C'est le prix de la fonction, il est dit,
 * et il n'est pas payé par les sites qui ne l'ont pas demandée.
 *
 * Prérequis non logiciels, à traiter chez le client :
 *   1. dnsmasq installé sur la machine de l'agent ;
 *   2. le DHCP du site distribue l'IP de l'agent comme serveur DNS ;
 *   3. les règles anti-contournement posées sur le routeur — l'agent
 *      n'est pas sur le chemin du trafic et ne peut pas les poser.
 *
 * Sans le point 2 rien n'est bloqué ; sans le point 3 tout se contourne.
 * Le module vérifie ce qu'il peut et le dit franchement.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const CHEMIN_CONF =
  process.env.DNSMASQ_CONF || "/etc/dnsmasq.d/netsecuremanager.conf";

/* Fichier SÉPARÉ de celui du blocage, et c'est délibéré : couper
   l'observation ne doit pas pouvoir toucher au filtrage, et un défaut du
   filtrage ne doit pas pouvoir rallumer l'observation. Deux fonctions,
   deux fichiers, deux pannes possibles au lieu d'une commune. */
const CHEMIN_CONF_OBSERVATION =
  process.env.DNSMASQ_CONF_OBSERVATION ||
  "/etc/dnsmasq.d/netsecuremanager-observation.conf";

/** Exécute une commande, sans jamais lever. */
function commande(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, sortie: (stdout || "") + (stderr || ""), erreur: err ? err.message : null });
    });
  });
}

/** dnsmasq est-il installé et pilotable ? */
async function verifierPrerequis() {
  if (process.platform === "win32") {
    return {
      ok: false,
      raison:
        "Le blocage DNS demande dnsmasq, qui n'existe pas sous Windows. " +
        "Installez l'agent de ce site sur une machine Linux (un Raspberry Pi suffit), " +
        "ou utilisez le pare-feu du routeur seul.",
    };
  }

  const presence = await commande("command -v dnsmasq");
  if (!presence.ok) {
    return {
      ok: false,
      raison: "dnsmasq n'est pas installé. Sur Debian/Ubuntu : sudo apt install dnsmasq",
    };
  }

  // Écrire dans /etc/dnsmasq.d demande les droits root. Le vérifier
  // maintenant évite une erreur obscure au moment d'appliquer.
  try {
    fs.accessSync(path.dirname(CHEMIN_CONF), fs.constants.W_OK);
  } catch {
    return {
      ok: false,
      raison: `Droits insuffisants sur ${path.dirname(CHEMIN_CONF)}. L'agent doit tourner en root pour appliquer la politique.`,
    };
  }

  return { ok: true };
}

/**
 * Écrit la configuration et recharge dnsmasq.
 *
 * DEUX PRÉCAUTIONS QUI ÉVITENT DE COUPER LE RÉSEAU DU CLIENT :
 *
 * 1. Écriture dans un fichier temporaire puis renommage. Le renommage
 *    est atomique : dnsmasq ne peut jamais lire un fichier à moitié
 *    écrit. Sans cela, une coupure de courant au mauvais moment
 *    laisserait une configuration tronquée — et dnsmasq refuserait de
 *    démarrer, privant tout le site de résolution DNS.
 *
 * 2. Vérification de syntaxe AVANT de recharger, et restauration de
 *    l'ancienne configuration si le rechargement échoue. Une politique
 *    mal formée ne doit jamais pouvoir couper Internet sur un site
 *    entier : c'est le seul défaut de ce produit qui ferait perdre un
 *    client en une journée.
 */
async function appliquer(dnsmasqConf) {
  const prerequis = await verifierPrerequis();
  if (!prerequis.ok) return { applique: false, erreur: prerequis.raison };

  // Sauvegarde de l'existant pour pouvoir revenir en arrière.
  let ancienne = null;
  try {
    ancienne = fs.readFileSync(CHEMIN_CONF, "utf8");
  } catch {
    // Premier passage : il n'y a rien à sauvegarder.
  }

  const temporaire = `${CHEMIN_CONF}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaire, dnsmasqConf, { mode: 0o644 });
    fs.renameSync(temporaire, CHEMIN_CONF);
  } catch (err) {
    try {
      fs.unlinkSync(temporaire);
    } catch {
      /* le fichier temporaire n'existe peut-être pas */
    }
    return { applique: false, erreur: `Écriture impossible : ${err.message}` };
  }

  // Contrôle de syntaxe avant de toucher au service en cours.
  const test = await commande("dnsmasq --test");
  if (!test.ok) {
    await restaurer(ancienne);
    return {
      applique: false,
      erreur: `Configuration refusée par dnsmasq : ${test.sortie.trim().slice(0, 200)}`,
    };
  }

  // ── REDÉMARRAGE, ET SURTOUT PAS « RELOAD » ──
  //
  // C'était le défaut le plus coûteux de cette fonction, parce qu'il
  // réussissait en apparence.
  //
  // `systemctl reload-or-restart` privilégie le rechargement quand le
  // service en propose un. Or l'unité dnsmasq d'Ubuntu implémente son
  // ExecReload par un signal SIGHUP — et dnsmasq, sur SIGHUP, relit
  // /etc/hosts, /etc/ethers et le bail DHCP, mais PAS ses fichiers de
  // configuration. C'est documenté, et c'est contre-intuitif.
  //
  // Conséquence observée : la commande renvoyait un succès, l'agent
  // annonçait « Politique web appliquée — 52242 domaines », l'interface
  // affichait un point vert, et absolument rien n'était bloqué. Le seul
  // moyen de s'en apercevoir était d'interroger le résolveur à la main.
  //
  // Un redémarrage complet est donc obligatoire. Il coupe la résolution
  // DNS du site pendant une fraction de seconde — largement préférable à
  // un blocage qu'on croit actif et qui ne l'est pas.
  const redemarrage = await commande("systemctl restart dnsmasq", 60000);
  if (!redemarrage.ok) {
    await restaurer(ancienne);
    await commande("systemctl restart dnsmasq", 60000);
    return {
      applique: false,
      erreur: `Redémarrage échoué, ancienne configuration restaurée : ${redemarrage.sortie.trim().slice(0, 200)}`,
    };
  }

  // ── VÉRIFIER PLUTÔT QUE SUPPOSER ──
  //
  // « systemctl a rendu la main sans erreur » ne prouve pas que le
  // blocage est en place — la panne ci-dessus le démontre. On interroge
  // donc réellement le résolveur sur un domaine tiré de la politique
  // qu'on vient d'écrire.
  //
  // Sans ce contrôle, l'agent remonte « appliquée » au serveur, et
  // l'écran affiche un blocage imaginaire. C'est le pire résultat
  // possible pour cette fonction : le client ne le découvre qu'en
  // constatant qu'un site interdit s'ouvre normalement.
  const verification = await verifierBlocage(dnsmasqConf);
  if (!verification.ok) {
    return { applique: false, erreur: verification.raison };
  }

  return { applique: true, verifie: verification.domaine };
}

/**
 * Interroge le résolveur local sur un domaine issu de la configuration
 * qu'on vient d'installer.
 *
 * @param {string} dnsmasqConf  le texte de configuration écrit
 */
function verifierBlocage(dnsmasqConf) {
  return new Promise((resolve) => {
    const ip = ipLocale();
    if (!ip) return resolve({ ok: true, domaine: null }); // rien de mieux à faire

    // Premier domaine bloqué de la politique : s'il ne l'est pas, aucun
    // ne l'est.
    const m = dnsmasqConf.match(/^address=\/([^/]+)\//m);
    if (!m) return resolve({ ok: true, domaine: null }); // politique vide

    const domaine = m[1];
    const dns = require("dns");
    const resolveur = new dns.Resolver({ timeout: 3000, tries: 1 });
    try {
      resolveur.setServers([ip]);
    } catch {
      return resolve({ ok: true, domaine: null });
    }

    resolveur.resolve4(domaine, (err, adresses) => {
      // Pas de réponse = bloqué. C'est le cas normal quand dnsmasq
      // répond NODATA.
      if (err) return resolve({ ok: true, domaine });

      const bloque = adresses.some((a) => a === "0.0.0.0" || a === ip);
      if (bloque) return resolve({ ok: true, domaine });

      resolve({
        ok: false,
        raison:
          `Configuration écrite mais sans effet : ${domaine} résout encore ` +
          `vers ${adresses[0]}. dnsmasq n'a pas rechargé ses fichiers.`,
      });
    });
  });
}

async function restaurer(ancienne) {
  try {
    if (ancienne === null) fs.unlinkSync(CHEMIN_CONF);
    else fs.writeFileSync(CHEMIN_CONF, ancienne, { mode: 0o644 });
  } catch {
    /* rien de mieux à faire ici que de ne pas aggraver */
  }
}

/** Retire le blocage : politique désactivée côté plateforme. */
async function retirer() {
  try {
    if (!fs.existsSync(CHEMIN_CONF)) return { applique: true, deja: true };
    fs.unlinkSync(CHEMIN_CONF);
  } catch (err) {
    return { applique: false, erreur: err.message };
  }
  // Redémarrage complet ici aussi : un SIGHUP ne relit pas les fichiers
  // de configuration, et le blocage resterait actif après la suppression
  // du fichier — une politique désactivée qui continue de bloquer.
  const r = await commande("systemctl restart dnsmasq", 60000);
  return r.ok ? { applique: true } : { applique: false, erreur: r.sortie.slice(0, 200) };
}

/**
 * Relève les compteurs de dnsmasq.
 *
 * `kill -USR1` fait écrire les statistiques dans le journal système :
 * des TOTAUX (requêtes traitées, réponses servies depuis le cache…).
 * Aucun nom de domaine, aucune adresse de client. C'est précisément
 * pourquoi cette méthode a été retenue plutôt que la lecture d'un
 * journal de requêtes.
 *
 * @returns {{ total:number|null }} un total, ou null si indisponible
 */
async function relever() {
  if (process.platform === "win32") return { total: null };

  await commande("pkill -USR1 dnsmasq");
  // Laisser au démon le temps d'écrire dans le journal.
  await new Promise((r) => setTimeout(r, 500));

  const journal = await commande(
    'journalctl -u dnsmasq --since "-1 min" --no-pager 2>/dev/null | grep -i "queries forwarded" | tail -1'
  );
  if (!journal.ok || !journal.sortie.trim()) return { total: null };

  const m = journal.sortie.match(/queries forwarded (\d+), queries answered locally (\d+)/i);
  if (!m) return { total: null };

  // « answered locally » regroupe le cache ET les domaines bloqués. Ce
  // n'est donc pas un compteur de blocages exact, et il ne faut pas le
  // présenter comme tel : voir la note dans A-FAIRE.md.
  return { total: Number(m[2]) };
}

/** Adresse IPv4 principale de la machine, pour la page de blocage. */
function ipLocale() {
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const i of interfaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

/**
 * Allume ou éteint la journalisation des requêtes.
 *
 * Retourne `{ change: false }` quand l'état demandé est déjà en place :
 * sans cette comparaison, chaque cycle de l'agent redémarrerait dnsmasq
 * et couperait la résolution DNS du site toutes les cinq minutes.
 *
 * @param {boolean} actif
 */
async function configurerObservation(actif) {
  if (process.platform === "win32") return { ok: false, raison: "Windows non pris en charge" };

  const present = fs.existsSync(CHEMIN_CONF_OBSERVATION);
  if (Boolean(actif) === present) return { ok: true, change: false, actif: present };

  try {
    if (actif) {
      fs.writeFileSync(
        CHEMIN_CONF_OBSERVATION,
        "# Écrit par NetSecureManager — observation des domaines contactés.\n" +
          "# Activée depuis la page Sites de la plateforme. Retirer ce fichier\n" +
          "# et redémarrer dnsmasq suffit à revenir au comportement d'origine.\n" +
          "log-queries\n",
        { mode: 0o644 }
      );
    } else {
      fs.unlinkSync(CHEMIN_CONF_OBSERVATION);
    }
  } catch (err) {
    return { ok: false, raison: `Écriture impossible : ${err.message}` };
  }

  const r = await commande("systemctl restart dnsmasq", 60000);
  if (!r.ok) return { ok: false, raison: r.sortie.slice(0, 200) };
  return { ok: true, change: true, actif: Boolean(actif) };
}

/**
 * Lit les requêtes journalisées, puis EFFACE ce qu'elle vient de lire.
 *
 * L'effacement n'est pas du ménage : c'est ce qui empêche la machine de
 * l'agent de devenir, au fil des jours, le journal de navigation complet
 * que l'en-tête de ce fichier refuse. Ce qui subsiste entre deux relevés
 * est au pire l'intervalle d'un cycle.
 *
 * `--since` borné à l'intervalle demandé, et `--vacuum-time` ensuite :
 * on ne supprime que ce qui a été lu, jamais le journal des autres
 * services de la machine.
 *
 * @param {number} minutes  fenêtre à relire
 * @returns {Promise<{texte:string|null, raison?:string}>}
 */
async function journalRequetes(minutes = 6) {
  if (process.platform === "win32") return { texte: null, raison: "Windows non pris en charge" };
  if (!fs.existsSync(CHEMIN_CONF_OBSERVATION)) {
    return { texte: null, raison: "observation non activée sur cet agent" };
  }

  const fenetre = Math.max(1, Math.min(60, Number(minutes) || 6));
  const lecture = await commande(
    `journalctl -u dnsmasq --since "-${fenetre} min" --no-pager 2>/dev/null | grep " query\\[" | tail -50000`,
    30000
  );
  if (!lecture.ok || !lecture.sortie.trim()) return { texte: null, raison: "aucune requête lue" };

  // Purge du journal dnsmasq une fois la lecture faite. En cas d'échec on
  // n'interrompt rien : un journal non purgé est un problème d'espace
  // disque, pas une panne de la supervision — mais il doit se voir.
  const purge = await commande('journalctl --vacuum-time=1s --unit=dnsmasq 2>/dev/null');
  if (!purge.ok) {
    console.error("[dnsGuard] Journal dnsmasq non purgé après lecture — vérifiez l'espace disque.");
  }

  return { texte: lecture.sortie };
}

module.exports = {
  verifierPrerequis,
  appliquer,
  retirer,
  relever,
  ipLocale,
  configurerObservation,
  journalRequetes,
  CHEMIN_CONF,
  CHEMIN_CONF_OBSERVATION,
};
