/**
 * services/certificatService.js
 * La carte d'identité que présente un service chiffré.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE SONDE MÉRITE D'EXISTER
 *
 * Un certificat qui expire ne se dégrade pas : il coupe. Du jour au
 * lendemain, l'intranet devient inaccessible, le client de messagerie
 * refuse de se connecter, et l'écran d'erreur du navigateur accuse le
 * réseau. C'est une panne qu'on voit venir trente jours à l'avance — ou
 * jamais.
 *
 * Nagios, Zabbix et Centreon ne surveillent pas les certificats
 * nativement : il faut leur ajouter une sonde ou un modèle. Ici, la
 * plateforme découvre déjà les ports ouverts ; lire le certificat de
 * ceux qui sont chiffrés ne coûte qu'une poignée de main de plus.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ON LIT CE QUI EST PRÉSENTÉ, ON N'ATTAQUE RIEN
 *
 * Un serveur TLS envoie son certificat AVANT toute authentification :
 * c'est le principe même du protocole, et c'est ce que fait chaque
 * navigateur des milliers de fois par jour. On ouvre la connexion, on
 * lit la carte d'identité, on referme. Aucun identifiant n'est tenté,
 * aucune donnée n'est envoyée.
 *
 * ─────────────────────────────────────────────────────────────────────
 * UNE PREUVE POSITIVE, JAMAIS UN CERTIFICAT DE BONNE SANTÉ
 *
 * Le point délicat est la détection des vieilles versions de TLS. La
 * version NÉGOCIÉE ne dit rien de ce que le serveur accepterait : c'est
 * la meilleure que les deux savent parler. Un serveur qui accepte encore
 * TLS 1.0 négociera quand même TLS 1.3 avec nous.
 *
 * On teste donc explicitement une connexion ancienne. Et le résultat est
 * à TROIS états, jamais deux :
 *
 *   true   le serveur a accepté TLS 1.0 ou 1.1 — c'est une PREUVE
 *   false  il a refusé — mais notre propre bibliothèque a pu refuser
 *          avant lui : on ne peut PAS conclure qu'il est sûr
 *   null   le test n'a pas pu être mené
 *
 * `false` et `null` s'affichent donc pareil : « non déterminé ». Écrire
 * « n'accepte pas les anciennes versions » sur la foi d'un refus dont on
 * ignore l'origine serait une affirmation de sécurité non vérifiée — le
 * genre de phrase qui vaut un audit raté au client qui l'a crue.
 */
const tls = require("node:tls");

/**
 * Ports où l'on s'attend à trouver du TLS direct.
 *
 * 3389 (bureau à distance) en est ABSENT à dessein : il chiffre bien,
 * mais après une négociation qui lui est propre. Une poignée de main TLS
 * ordinaire y échoue, et l'échec serait rapporté comme un défaut du
 * service alors qu'il vient de notre sonde.
 */
const PORTS_TLS = [443, 465, 636, 990, 993, 995, 5986, 8443, 9443];

const DELAI_MS = 4000;

/** En dessous, une clé RSA n'est plus considérée comme sûre. */
const TAILLE_CLE_MINIMALE = 2048;

/** À partir de combien de jours restants on considère qu'il faut agir. */
const SEUIL_ALERTE_JOURS = 30;

/**
 * Ouvre une connexion TLS et rend ce que le serveur a présenté.
 * Ne lève jamais : un service qui refuse la connexion n'est pas une
 * erreur de la plateforme, c'est une observation.
 */
function lireCertificat(ip, port, options = {}) {
  return new Promise((resolve) => {
    let fini = false;
    const terminer = (valeur) => {
      if (fini) return;
      fini = true;
      try { socket.destroy(); } catch { /* déjà fermé */ }
      resolve(valeur);
    };

    const socket = tls.connect(
      {
        host: ip,
        port,
        // On veut LIRE le certificat, y compris — et surtout — quand il
        // est auto-signé ou expiré. Refuser la connexion sur ce motif
        // nous priverait précisément des cas qui nous intéressent.
        rejectUnauthorized: false,
        timeout: DELAI_MS,
        ...options,
      },
      () => {
        const brut = socket.getPeerCertificate(false);
        if (!brut || Object.keys(brut).length === 0) return terminer(null);
        terminer({
          brut,
          protocole: socket.getProtocol(),
          chiffrement: socket.getCipher() ? socket.getCipher().name : null,
        });
      }
    );

    socket.once("error", () => terminer(null));
    socket.once("timeout", () => terminer(null));
  });
}

/**
 * Le serveur accepte-t-il encore TLS 1.0 ou 1.1 ?
 * @returns {Promise<boolean|null>} true = prouvé ; false = refusé, sans
 *          qu'on puisse dire par qui ; null = test impossible.
 */
async function accepteTlsAncien(ip, port) {
  try {
    const r = await lireCertificat(ip, port, {
      minVersion: "TLSv1",
      maxVersion: "TLSv1.1",
      // OpenSSL 3 refuse par défaut les chiffrements de cette époque.
      // Sans cette ligne, notre propre bibliothèque coupe avant le
      // serveur et tout le parc paraîtrait moderne.
      ciphers: "DEFAULT@SECLEVEL=0",
    });
    if (!r) return false;
    return r.protocole === "TLSv1" || r.protocole === "TLSv1.1";
  } catch {
    return null;
  }
}

/** « Sep 10 12:00:00 2026 GMT » → Date, ou null si illisible. */
function versDate(texte) {
  if (!texte) return null;
  const d = new Date(texte);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Le nom courant d'un sujet ou d'un émetteur, à défaut l'organisation. */
function nomLisible(partie) {
  if (!partie) return null;
  return partie.CN || partie.O || partie.OU || null;
}

/**
 * Transforme ce qu'un serveur a présenté en constats vérifiables.
 * Fonction PURE : c'est elle qui porte la logique, et c'est elle qui est
 * testée — sans réseau, sans serveur, sans certificat réel.
 *
 * @param {object} lecture   résultat de lireCertificat
 * @param {boolean|null} ancien  résultat de accepteTlsAncien
 * @param {Date} maintenant  injectée pour que les tests ne dépendent pas
 *                           de la date du jour
 */
function analyserCertificat(lecture, ancien = null, maintenant = new Date()) {
  if (!lecture || !lecture.brut) return null;
  const c = lecture.brut;

  const debut = versDate(c.valid_from);
  const fin = versDate(c.valid_to);

  const joursRestants =
    fin === null ? null : Math.floor((fin.getTime() - maintenant.getTime()) / 86_400_000);

  const sujet = nomLisible(c.subject);
  const emetteur = nomLisible(c.issuer);

  /* AUTO-SIGNÉ : émetteur identique au sujet.
     Comparé sur le nom complet et non sur le seul CN — deux certificats
     différents partagent souvent un CN (« localhost », le nom du
     modèle d'imprimante), et les confondre classerait comme auto-signé
     un certificat émis par une autorité interne. */
  const autoSigne =
    Boolean(c.subject && c.issuer) &&
    JSON.stringify(c.subject) === JSON.stringify(c.issuer);

  // `bits` n'est renseigné que pour RSA et DSA. Une clé à courbe
  // elliptique n'a pas de « taille » comparable : l'absence de valeur
  // n'est donc PAS une clé faible, et ne doit rien déclencher.
  const tailleCle = Number.isFinite(Number(c.bits)) ? Number(c.bits) : null;
  const courbe = c.nistCurve || c.asn1Curve || null;

  const constats = [];
  if (joursRestants !== null && joursRestants < 0) {
    constats.push({
      code: "expire",
      gravite: "critique",
      texte: `certificat expiré depuis ${Math.abs(joursRestants)} jour(s)`,
    });
  } else if (joursRestants !== null && joursRestants <= SEUIL_ALERTE_JOURS) {
    constats.push({
      code: "expire_bientot",
      gravite: "avertissement",
      texte: `expire dans ${joursRestants} jour(s)`,
    });
  }

  if (debut && debut.getTime() > maintenant.getTime()) {
    // Cas rare mais réel : une horloge mal réglée sur l'équipement, ou un
    // certificat déployé en avance. Le service est inutilisable de la
    // même façon qu'avec un certificat expiré.
    constats.push({
      code: "pas_encore_valide",
      gravite: "critique",
      texte: `pas valide avant le ${debut.toISOString().slice(0, 10)}`,
    });
  }

  if (autoSigne) {
    constats.push({
      code: "auto_signe",
      gravite: "information",
      texte: "certificat auto-signé — courant sur un équipement interne, à vérifier sur un service exposé",
    });
  }

  if (tailleCle !== null && tailleCle < TAILLE_CLE_MINIMALE) {
    constats.push({
      code: "cle_faible",
      gravite: "avertissement",
      texte: `clé de ${tailleCle} bits, en dessous des ${TAILLE_CLE_MINIMALE} bits attendus`,
    });
  }

  if (ancien === true) {
    constats.push({
      code: "tls_ancien",
      gravite: "avertissement",
      texte: "accepte encore TLS 1.0 ou 1.1, retirés des navigateurs depuis 2020",
    });
  }

  return {
    sujet,
    emetteur,
    valide_du: debut ? debut.toISOString().slice(0, 19).replace("T", " ") : null,
    valide_au: fin ? fin.toISOString().slice(0, 19).replace("T", " ") : null,
    jours_restants: joursRestants,
    auto_signe: autoSigne,
    taille_cle: tailleCle,
    courbe,
    protocole: lecture.protocole || null,
    chiffrement: lecture.chiffrement || null,
    // Trois états conservés jusqu'en base : voir l'en-tête du fichier.
    tls_ancien_accepte: ancien === true ? 1 : ancien === false ? 0 : null,
    empreinte: c.fingerprint256 || null,
    noms_alternatifs: c.subjectaltname || null,
    constats,
  };
}

/**
 * Examine les ports chiffrés d'une machine.
 * @param {string} ip
 * @param {Array<{port:number}>} services  ports déjà trouvés ouverts
 * @returns {Promise<Array>} un enregistrement par port chiffré
 */
async function examinerCertificats(ip, services) {
  if (!Array.isArray(services) || services.length === 0) return [];

  const portsChiffres = services
    .map((s) => Number(s.port))
    .filter((p) => PORTS_TLS.includes(p));

  if (portsChiffres.length === 0) return [];

  const resultats = [];
  // Séquentiel, et non en parallèle : ces sondes s'ajoutent à un scan
  // dont la concurrence est déjà bornée à l'étage au-dessus. Ouvrir
  // plusieurs poignées de main TLS simultanées par machine contournerait
  // cette borne, qui n'a de sens que si personne ne la double.
  for (const port of portsChiffres) {
    const lecture = await lireCertificat(ip, port);
    if (!lecture) continue;
    const ancien = await accepteTlsAncien(ip, port);
    const analyse = analyserCertificat(lecture, ancien);
    if (analyse) resultats.push({ port, ...analyse });
  }
  return resultats;
}

module.exports = {
  examinerCertificats,
  lireCertificat,
  accepteTlsAncien,
  analyserCertificat,
  versDate,
  nomLisible,
  PORTS_TLS,
  SEUIL_ALERTE_JOURS,
  TAILLE_CLE_MINIMALE,
};
