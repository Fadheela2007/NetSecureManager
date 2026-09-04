/**
 * banniereWebService.js
 * Ce qu'un équipement déclare sur sa propre page web.
 *
 * Beaucoup d'appareils muets en SNMP — imprimantes, caméras, NAS, points
 * d'accès — servent une interface d'administration sur le port 80. Le
 * titre de cette page et l'en-tête `Server` portent souvent la marque et
 * le modèle exacts. C'est une DÉCLARATION de l'équipement, au même titre
 * que le texte SNMP : on ne devine rien, on lit ce qu'il affiche.
 *
 * Cette source vient après SNMP et l'adresse matérielle, avant nmap :
 * elle est plus précise que l'empreinte TCP/IP (qui donne un système
 * d'exploitation, pas un modèle) mais moins fiable qu'un agent SNMP, un
 * titre de page pouvant avoir été personnalisé par l'exploitant.
 */

/** Longueur maximale lue. Une page d'admin tient largement dedans, et
 *  cette borne évite de télécharger un fichier de plusieurs mégaoctets
 *  servi par erreur sur le port 80. */
const OCTETS_MAX = 64 * 1024;

/** Ports en HTTP simple. Le 443 est volontairement exclu : les
 *  équipements utilisent des certificats auto-signés, la connexion
 *  échouerait sur la validation et on paierait le délai pour rien. */
const PORTS_HTTP = [80, 8080];

/**
 * Titres qui n'apprennent rien. Les retenir remplirait la fiche d'un
 * équipement avec « Login » ou « Index of / » — une case remplie qui ne
 * vaut pas mieux qu'une case vide, et qui, elle, donne l'illusion d'une
 * information.
 */
const TITRES_INUTILES =
  /^(login|log in|sign in|connexion|index|home|accueil|welcome|bienvenue|untitled|document|error|401|403|404|redirect|loading|)$/i;

/**
 * Titres qui commencent par une formule sans intérêt, quelle que soit la
 * suite : « Index of /var/www », « Login - » … Le test d'égalité stricte
 * ci-dessus ne les attrape pas, et c'est un défaut trouvé par les tests.
 */
const DEBUTS_INUTILES = /^(index of|login|sign in|connexion|error|welcome to)\b/i;

/**
 * Longueur maximale d'un titre retenu.
 *
 * Un nom de modèle dépasse rarement quarante caractères — « HP LaserJet
 * MFP M428fdw » en fait vingt-trois. Au-delà de quatre-vingts, on lit une
 * phrase d'accueil, pas une identité d'appareil. Le seuil était à 120 et
 * laissait passer « Bienvenue sur le portail interne de l'entreprise,
 * merci de vous identifier… », qui aurait atterri dans la fiche.
 */
const LONGUEUR_MAX_TITRE = 80;

/**
 * En-têtes `Server` génériques : ce sont des serveurs web, pas des
 * modèles d'équipement. « lighttpd » ne dit pas quel appareil c'est.
 */
const SERVEURS_GENERIQUES =
  /^(apache|nginx|lighttpd|micro_httpd|mini_httpd|httpd|boa|thttpd|goahead-webs|jetty|iis|microsoft-iis|werkzeug|node\.?js|express|kestrel)/i;

/** Retire les entités et espaces parasites d'un titre HTML. */
function nettoyerTitre(brut) {
  return String(brut)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrait ce qui est exploitable d'une réponse HTTP.
 *
 * Séparé de l'appel réseau pour être éprouvé sur des dizaines de pages
 * réelles sans ouvrir une seule connexion.
 *
 * @param {string} corps      le HTML reçu
 * @param {string|null} serveur  l'en-tête `Server`
 * @returns {{titre: string|null, serveur: string|null}}
 */
function extraireBanniere(corps, serveur) {
  let titre = null;

  const m = String(corps || "").match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (m) {
    const candidat = nettoyerTitre(m[1]);
    // Un titre trop long est une phrase, pas un nom d'appareil.
    if (
      candidat &&
      candidat.length <= LONGUEUR_MAX_TITRE &&
      !TITRES_INUTILES.test(candidat) &&
      !DEBUTS_INUTILES.test(candidat)
    ) {
      titre = candidat;
    }
  }

  let serveurUtile = null;
  if (serveur) {
    const s = String(serveur).trim();
    if (s && !SERVEURS_GENERIQUES.test(s) && s.length <= 80) {
      serveurUtile = s;
    }
  }

  return { titre, serveur: serveurUtile };
}

/**
 * Interroge la page web d'un équipement, si un port HTTP est ouvert.
 *
 * Ne lève jamais et n'attend jamais longtemps : c'est une source
 * d'appoint, elle ne doit pas peser sur la durée d'un scan ni faire
 * échouer l'analyse d'un hôte.
 *
 * @param {string} ip
 * @param {Array<{port:number}>} portsOuverts  résultat de scanPorts
 * @param {number} [delaiMs]
 * @returns {Promise<{titre: string|null, serveur: string|null, port: number}|null>}
 */
async function lireBanniere(ip, portsOuverts = [], delaiMs = 2000) {
  const port = PORTS_HTTP.find((p) => portsOuverts.some((s) => s.port === p));
  if (!port) return null;

  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delaiMs);

  try {
    const reponse = await fetch(`http://${ip}:${port}/`, {
      signal: controleur.signal,
      // Pas de redirection suivie : un équipement peut renvoyer vers un
      // domaine externe, et on n'a rien à aller chercher hors du réseau.
      redirect: "manual",
      headers: { Accept: "text/html" },
    });

    const serveur = reponse.headers.get("server");
    const type = reponse.headers.get("content-type") || "";

    // Un binaire servi sur le port 80 n'a pas de titre à lire : on garde
    // l'en-tête `Server`, qui lui reste exploitable, et on ne télécharge
    // pas le corps.
    const estLisible = !type || /text\/html|text\/plain/i.test(type);

    let corps = "";
    if (estLisible) {
      const brut = await reponse.text();
      corps = brut.length > OCTETS_MAX ? brut.slice(0, OCTETS_MAX) : brut;
    }

    const banniere = extraireBanniere(corps, serveur);
    if (!banniere.titre && !banniere.serveur) return null;

    return { ...banniere, port };
  } catch {
    // Délai dépassé, connexion refusée, réponse illisible : l'équipement
    // ne dit rien d'exploitable. C'est une absence d'information, pas une
    // erreur à signaler.
    return null;
  } finally {
    clearTimeout(minuteur);
  }
}

module.exports = { lireBanniere, extraireBanniere, PORTS_HTTP };
