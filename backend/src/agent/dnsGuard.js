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

module.exports = { verifierPrerequis, appliquer, retirer, relever, ipLocale, CHEMIN_CONF };
