/**
 * agent/pageBlocage.js
 * Sert la page expliquant qu'un site est bloqué.
 *
 * Les domaines interdits résolvent déjà vers l'adresse de l'agent (voir
 * `ipBlocage` dans politiqueWebService). Mais l'agent n'écoutait sur aucun
 * port : le navigateur arrivait à la bonne adresse et ne trouvait
 * personne. L'utilisateur voyait « impossible d'accéder à ce site » — d'où
 * les tickets « internet ne marche pas », et l'administrateur ne pouvait
 * pas savoir si le blocage fonctionnait ou si le réseau était en panne.
 *
 * Le message vient de la politique, saisi dans la page Contrôle d'accès
 * web. Il était enregistré, transmis à l'agent, et affiché à personne.
 *
 * LIMITE À CONNAÎTRE, ET ELLE EST STRUCTURELLE
 *
 * Cette page ne s'affiche que pour les sites en HTTP simple. En HTTPS, le
 * navigateur exige un certificat valide pour le domaine demandé, que nous
 * ne pouvons pas produire : il affiche sa propre erreur de sécurité avant
 * même de nous parler. Aucun blocage par DNS ne fait autrement — il faut
 * un proxy pour cela, ce qui est une autre architecture.
 *
 * Le gain reste réel : l'utilisateur qui tombe sur un site en HTTP voit
 * une explication, et le port ouvert prouve que l'agent tourne.
 */

const http = require("http");

const PORT = Number(process.env.PORT_BLOCAGE) || 80;

const MESSAGE_PAR_DEFAUT =
  "Ce site est bloqué par la politique de votre entreprise. " +
  "Contactez le service informatique si vous pensez qu'il s'agit d'une erreur.";

let serveur = null;
let messageCourant = MESSAGE_PAR_DEFAUT;

/** Neutralise le HTML : le message vient d'un champ libre de l'interface. */
function echapper(texte) {
  return String(texte)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(message, hote) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site bloqué</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:#1c1624; color:#ece8f0;
         font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 1rem; }
  p { line-height:1.6; color:#a094ad; }
  .domaine { display:inline-block; margin-top:1.5rem; padding:.4rem .8rem;
             border:1px solid #3b2f49; border-radius:.4rem;
             font-family:ui-monospace, monospace; font-size:.85rem; }
</style>
</head>
<body>
  <main>
    <h1>Accès bloqué</h1>
    <p>${echapper(message)}</p>
    ${hote ? `<div class="domaine">${echapper(hote)}</div>` : ""}
  </main>
</body>
</html>`;
}

/**
 * Démarre le serveur, ou met simplement à jour le message s'il tourne déjà.
 *
 * Ne lève jamais. Un port 80 refusé — privilèges insuffisants sous Linux,
 * ou port déjà pris — ne doit pas empêcher l'agent de superviser : le
 * blocage DNS, lui, fonctionne de toute façon. On rend l'erreur pour que
 * l'appelant la DISE, au lieu de la découvrir six mois plus tard.
 *
 * @returns {Promise<{actif: boolean, port: number, erreur: string|null}>}
 */
function demarrer(message) {
  messageCourant = (message && String(message).trim()) || MESSAGE_PAR_DEFAUT;

  if (serveur) return Promise.resolve({ actif: true, port: PORT, erreur: null });

  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      // Toute requête reçoit la page : on est arrivé ici parce qu'un
      // domaine bloqué pointe vers nous, quel que soit le chemin demandé.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        // Sans cela, le navigateur garderait la page en cache et
        // continuerait à l'afficher après le retrait du blocage.
        "Cache-Control": "no-store",
      });
      res.end(page(messageCourant, req.headers.host));
    });

    s.on("error", (err) => {
      serveur = null;
      const aide =
        err.code === "EACCES"
          ? `port ${PORT} refusé — sous Linux, les ports sous 1024 exigent des ` +
            "privilèges. Lancez l'agent en service système, ou définissez " +
            "PORT_BLOCAGE sur un port libre."
          : err.code === "EADDRINUSE"
            ? `port ${PORT} déjà occupé par un autre programme.`
            : err.message;
      resolve({ actif: false, port: PORT, erreur: aide });
    });

    s.listen(PORT, () => {
      serveur = s;
      resolve({ actif: true, port: PORT, erreur: null });
    });
  });
}

/** Arrête le serveur. Sans blocage actif, la page n'a plus lieu d'être. */
function arreter() {
  return new Promise((resolve) => {
    if (!serveur) return resolve();
    serveur.close(() => {
      serveur = null;
      resolve();
    });
  });
}

function estActif() {
  return serveur !== null;
}

module.exports = { demarrer, arreter, estActif, MESSAGE_PAR_DEFAUT };
