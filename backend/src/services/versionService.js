/**
 * services/versionService.js
 * Quel logiciel écoute derrière un port ouvert, et dans quelle version.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QUE ÇA CHANGE, ET POURQUOI C'EST LE CHAÎNON QUI MANQUAIT
 *
 * La migration du 7 septembre a refusé, à raison, d'inscrire des numéros
 * de CVE dans ce produit : « Un scan de ports ne voit pas la version : il
 * voit qu'un port répond. Associer CVE-2021-… à “le port 445 est ouvert”
 * serait une affirmation fausse. »
 *
 * C'était vrai tant que la plateforme ne lisait que des numéros de port.
 * Ce fichier lève exactement cette limite : il obtient le PRODUIT et sa
 * VERSION. « OpenSSH 7.4 » n'est plus « le port 22 est ouvert » — c'est
 * une version précise d'un logiciel précis, la seule chose à laquelle une
 * faille connue puisse honnêtement être rattachée.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ON ÉCOUTE, ON NE DEMANDE RIEN
 *
 * La plupart des services parlent les premiers. On ouvre une connexion —
 * la même que le scan de ports vient déjà d'ouvrir — et on lit ce que la
 * machine annonce d'elle-même :
 *
 *   SSH    « SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5 »
 *   FTP    « 220 ProFTPD 1.3.5 Server ready »
 *   SMTP   « 220 mail.exemple.fr ESMTP Postfix (Ubuntu) »
 *   POP3   « +OK Dovecot ready »
 *   MySQL  poignée de main binaire, où la version est en clair
 *
 * Aucune sonde d'attaque, aucune charge utile, aucune tentative
 * d'authentification : on se connecte et on écoute. C'est la différence
 * entre lire l'enseigne d'un magasin et essayer d'ouvrir sa porte.
 *
 * POURQUOI PAS `nmap -sV`. Il est meilleur — il envoie des sondes ciblées
 * et reconnaît des milliers de signatures. Il est aussi beaucoup plus
 * bavard sur le réseau, et ce parc est scanné avec une concurrence de 3
 * précisément pour rester discret. Le compromis retenu : la déclaration
 * spontanée, gratuite en trafic, qui couvre les services où la version
 * compte le plus. `nmap -sV` reste ajoutable derrière un réglage le jour
 * où un client accepte le bruit.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CE QU'ON N'AFFIRME PAS
 *
 * Une bannière peut être personnalisée, masquée ou mensongère — c'est
 * même une pratique d'administration courante. La bannière BRUTE est donc
 * conservée à côté de la version extraite : une version contestée se
 * vérifie en lisant ce que la machine a réellement envoyé, au lieu de se
 * discuter. Même principe que `type_source` et `preuve_existence`.
 */
const net = require("node:net");
const { lireBanniere, PORTS_HTTP } = require("./banniereWebService");

/** Ports dont le service se présente de lui-même à la connexion. */
const PORTS_BAVARDS = {
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  110: "pop3",
  143: "imap",
  587: "smtp",
  3306: "mysql",
};

/**
 * Attente maximale de la première réponse.
 *
 * Un service qui se présente le fait immédiatement — quelques
 * millisecondes. Ce délai n'est donc payé QUE par un port qui accepte la
 * connexion sans rien dire ; il est court pour cette raison.
 */
const ATTENTE_MS = 1200;

/** Bornes de lecture : une bannière tient en quelques centaines d'octets. */
const OCTETS_MAX = 2048;
const LONGUEUR_STOCKEE = 190;

/**
 * Ouvre une connexion, lit ce qui vient, referme. N'envoie jamais rien.
 * @returns {Promise<string|null>} le texte reçu, ou null
 */
function lireAnnonce(ip, port, attenteMs = ATTENTE_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let recu = Buffer.alloc(0);
    let fini = false;

    const terminer = (valeur) => {
      if (fini) return;
      fini = true;
      socket.destroy();
      resolve(valeur);
    };

    socket.setTimeout(attenteMs);
    socket.once("timeout", () => terminer(recu.length > 0 ? recu.toString("latin1") : null));
    socket.once("error", () => terminer(null));
    socket.once("close", () => terminer(recu.length > 0 ? recu.toString("latin1") : null));

    socket.on("data", (bloc) => {
      recu = Buffer.concat([recu, bloc]);
      // Une bannière tient sur une ligne : dès qu'elle est complète, on
      // rend la main sans attendre le délai. C'est ce qui rend la lecture
      // gratuite en pratique.
      if (recu.length >= OCTETS_MAX || recu.includes(0x0a)) {
        terminer(recu.toString("latin1"));
      }
    });

    socket.connect(port, ip);
  });
}

/** Ne garde que ce qui est lisible : une poignée de main binaire en est pleine. */
function nettoyer(texte) {
  return String(texte || "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Sépare un produit de sa version dans une chaîne libre.
 * « Apache/2.4.41 (Ubuntu) » → { produit: "Apache", version: "2.4.41" }
 * « OpenSSH_8.2p1 »          → { produit: "OpenSSH", version: "8.2p1" }
 */
/** Mots qui ne désignent jamais un logiciel. */
const MOTS_SANS_VALEUR =
  /^(ready|version|server|serveur|service|ok|esmtp|smtp|ftp|http|https|port|welcome|bienvenue|login|and|the|de|du)$/i;

function separerProduitVersion(texte) {
  const propre = nettoyer(texte);
  if (!propre) return null;

  // Produit, puis un séparateur, puis un numéro qui commence par un
  // chiffre. Le `\d` initial de la version évite de prendre « Server
  // ready » pour un numéro.
  //
  // Le séparateur accepte jusqu'à trois caractères : « HP LaserJet
  // M428fdw - 2.4.1 » sépare par « espace tiret espace », et un
  // séparateur d'un seul caractère laissait passer à côté de tout le
  // micrologiciel des imprimantes — la moitié de ce parc.
  const m = propre.match(
    /([A-Za-z][A-Za-z0-9+\-.]{1,29})[\s/_-]{1,3}v?(\d+(?:\.\d+){1,3}[A-Za-z0-9.\-_+]*)/
  );
  // Un mot de liaison n'est pas un nom de produit. Sans ce filtre,
  // « ... ready - 2.4 » donnerait le produit « ready » : une valeur
  // plausible et fausse, le pire résultat possible ici.
  if (m && !MOTS_SANS_VALEUR.test(m[1])) {
    return { produit: m[1].replace(/[-_.]+$/, ""), version: m[2].replace(/[.,;)]+$/, "") };
  }

  // Un produit nommé sans version reste une information utile : « Dovecot »
  // sans numéro vaut mieux que « port 110 ouvert ».
  const seul = propre.match(/\b(OpenSSH|Dropbear|ProFTPD|vsftpd|Pure-FTPd|FileZilla|Postfix|Exim|Sendmail|Dovecot|Courier|MySQL|MariaDB|Microsoft|Apache|nginx|lighttpd|IIS)\b/i);
  if (seul) return { produit: seul[1], version: null };

  return null;
}

/** SSH : « SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5 » */
function lireSsh(annonce) {
  const m = nettoyer(annonce).match(/^SSH-\d+(?:\.\d+)?-(\S+)/);
  if (!m) return null;
  return separerProduitVersion(m[1].replace(/_/g, " ")) || { produit: m[1], version: null };
}

/** FTP, SMTP, POP3, IMAP : une ligne de bienvenue, code numérique en tête. */
function lireLigneAccueil(annonce) {
  const propre = nettoyer(annonce);
  // On retire le code de réponse (« 220 », « +OK », « * OK ») et le nom
  // d'hôte, qui n'apprennent rien sur le logiciel.
  const sansCode = propre.replace(/^(\d{3}[- ]|\+OK\s*|\* OK\s*)/, "");
  return separerProduitVersion(sansCode);
}

/**
 * MySQL/MariaDB : la poignée de main initiale porte la version en clair,
 * juste après un octet de protocole. On ne lit que ça.
 */
function lireMysql(annonce) {
  const propre = nettoyer(annonce);
  const m = propre.match(/(\d+\.\d+\.\d+[A-Za-z0-9.\-_+]*)/);
  if (!m) return null;
  const version = m[1].replace(/-$/, "");
  return { produit: /maria/i.test(propre) ? "MariaDB" : "MySQL", version };
}

/** L'en-tête `Server` d'une page web : « Apache/2.4.41 (Ubuntu) ». */
function lireEnteteServeur(serveur) {
  return separerProduitVersion(serveur);
}

function analyser(protocole, annonce) {
  switch (protocole) {
    case "ssh":
      return lireSsh(annonce);
    case "mysql":
      return lireMysql(annonce);
    case "ftp":
    case "smtp":
    case "pop3":
    case "imap":
    case "telnet":
      return lireLigneAccueil(annonce);
    default:
      return separerProduitVersion(annonce);
  }
}

/**
 * Complète une liste de services ouverts avec le produit et sa version.
 *
 * @param {string} ip
 * @param {Array<{port:number, nom_service:string}>} services
 * @param {{serveur?:string}|null} banniereWeb  en-tête `Server` déjà lu
 * @returns {Promise<Array>} les mêmes services, enrichis
 */
async function identifierVersions(ip, services, banniereWeb = null) {
  if (!Array.isArray(services) || services.length === 0) return services || [];

  /* L'en-tête `Server` d'une page web est lu ailleurs — mais seulement
     quand l'appareil est inconnu et muet en SNMP, car il ne sert là qu'à
     déduire un FABRICANT, qui ne change jamais.

     Une version, elle, change à chaque mise à jour : c'est justement ce
     qu'on veut suivre. Quand la bannière n'a pas déjà été lue, on la lit
     ici — et uniquement si un port web est ouvert, donc à coût nul sur
     tout le reste du parc. */
  let web = banniereWeb;
  if (!web?.serveur && services.some((s) => PORTS_HTTP.includes(s.port))) {
    web = await lireBanniere(ip, services).catch(() => null);
  }

  return Promise.all(
    services.map(async (s) => {
      // Le web est déjà lu ailleurs : le relire ouvrirait une connexion
      // pour une information qu'on a en main.
      if (PORTS_HTTP.includes(s.port) && web?.serveur) {
        const trouve = lireEnteteServeur(web.serveur);
        return trouve
          ? {
              ...s,
              produit: trouve.produit,
              version: trouve.version,
              version_source: "entete_http",
              banniere: nettoyer(web.serveur).slice(0, LONGUEUR_STOCKEE),
            }
          : s;
      }

      const protocole = PORTS_BAVARDS[s.port];
      if (!protocole) return s;

      const annonce = await lireAnnonce(ip, s.port).catch(() => null);
      if (!annonce) return s;

      const trouve = analyser(protocole, annonce);
      if (!trouve) return s;

      return {
        ...s,
        produit: trouve.produit,
        version: trouve.version,
        version_source: "banniere",
        // La bannière brute, gardée à côté de ce qu'on en a extrait : une
        // version contestée se vérifie, elle ne se discute pas.
        banniere: nettoyer(annonce).slice(0, LONGUEUR_STOCKEE),
      };
    })
  );
}

module.exports = {
  identifierVersions,
  separerProduitVersion,
  lireSsh,
  lireLigneAccueil,
  lireMysql,
  lireEnteteServeur,
  analyser,
  nettoyer,
  PORTS_BAVARDS,
};
