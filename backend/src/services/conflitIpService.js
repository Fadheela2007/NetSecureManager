/**
 * conflitIpService.js
 * Détection des adresses IP en conflit.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER EXISTE
 *
 * Le texte d'aide `conflit_ip` était écrit et affiché dans
 * services/suggestions.js, mais AUCUN code n'émettait jamais ce code de
 * cause. La plateforme annonçait donc une capacité qu'elle n'avait pas —
 * ce qui est pire que ne pas l'avoir : un utilisateur qui découvre une
 * fonction absente doute ensuite de toutes les autres.
 *
 * COMMENT UN CONFLIT SE VOIT
 *
 * La table EQUIPEMENT interdit deux lignes avec la même adresse IP sur
 * un site. Un conflit ne se lit donc pas dans la colonne des adresses,
 * mais dans celle des adresses MATÉRIELLES : quand deux adresses IP
 * différentes répondent avec la MÊME adresse matérielle, une seule carte
 * réseau répond pour les deux.
 *
 * LE PIÈGE, ET LA RAISON PRINCIPALE DE CE MODULE
 *
 * Ce signal produit énormément de faux positifs si on le prend au pied
 * de la lettre. Lorsqu'on scanne au-delà d'une frontière de sous-réseau,
 * le ROUTEUR répond pour toutes les machines situées derrière lui : sa
 * propre adresse matérielle apparaît alors sur des dizaines d'adresses
 * IP. C'est du fonctionnement normal, pas un conflit.
 *
 * D'où la règle centrale : une adresse matérielle vue sur BEAUCOUP
 * d'adresses IP est une passerelle ; vue sur DEUX OU TROIS, c'est
 * suspect. Le seuil sépare le routage du conflit.
 *
 * Le service ne signale donc qu'un doute, jamais une certitude — la
 * décision finale demande de regarder les machines concernées.
 * ─────────────────────────────────────────────────────────────────────
 */

const { normaliserMac, estMacTechnique } = require("./attributionPortService");

/**
 * Au-delà de ce nombre d'adresses IP partageant une même adresse
 * matérielle, on conclut au routage et non au conflit.
 *
 * Trois est un compromis : une machine légitimement porteuse de
 * plusieurs adresses (serveur multi-adressé, machine virtuelle) en a
 * rarement plus. Un routeur en expose des dizaines.
 */
const MAX_IP_PAR_MAC = 3;

/** Convertit une adresse IPv4 en nombre, pour un tri lisible. */
function ipEnNombre(ip) {
  const parties = String(ip || "").split(".");
  if (parties.length !== 4) return -1;
  return parties.reduce((total, p) => total * 256 + (Number(p) || 0), 0);
}

/**
 * Cherche les conflits d'adresses dans une liste d'équipements.
 *
 * Chaque entrée attendue : { id_equipement, adresse_ip, adresse_mac,
 * mac_aleatoire }.
 *
 * Renvoie un tableau de conflits :
 *   { adresse_mac, equipements: [...], adresses: ["192.168.0.5", ...] }
 */
function detecterConflits(equipements, options = {}) {
  const maxIp = options.maxIpParMac ?? MAX_IP_PAR_MAC;
  const parMac = new Map();

  for (const eq of equipements || []) {
    const mac = normaliserMac(eq?.adresse_mac);

    // Sans adresse matérielle, aucune conclusion possible.
    if (!mac) continue;

    // Diffusion, multidiffusion, adresse nulle : ne désignent aucune
    // machine réelle.
    if (estMacTechnique(mac)) continue;

    // Adresse aléatoire : téléphones et portables modernes en changent à
    // chaque réseau pour préserver la vie privée. Deux appareils peuvent
    // en tirer une identique par coïncidence, et surtout un même
    // appareil en change entre deux scans. Les inclure produirait des
    // conflits fantômes que personne ne pourrait reproduire.
    if (eq.mac_aleatoire) continue;

    if (!parMac.has(mac)) parMac.set(mac, []);
    parMac.get(mac).push(eq);
  }

  const conflits = [];
  for (const [mac, groupe] of parMac) {
    if (groupe.length < 2) continue;

    // Au-delà du seuil : c'est une passerelle qui répond pour tout un
    // sous-réseau. Voir l'en-tête du fichier.
    if (groupe.length > maxIp) continue;

    const tries = [...groupe].sort(
      (a, b) => ipEnNombre(a.adresse_ip) - ipEnNombre(b.adresse_ip)
    );

    conflits.push({
      adresse_mac: mac,
      equipements: tries,
      adresses: tries.map((e) => e.adresse_ip),
    });
  }

  // Le plus de machines concernées en premier, puis par adresse : un
  // ordre stable rend les comparaisons entre deux scans possibles.
  return conflits.sort(
    (a, b) =>
      b.equipements.length - a.equipements.length ||
      ipEnNombre(a.adresses[0]) - ipEnNombre(b.adresses[0])
  );
}

/**
 * Message destiné à l'opérateur.
 *
 * Formulé au CONDITIONNEL, et disant ce qui a été observé plutôt que ce
 * qu'on en déduit. Le service constate que deux adresses répondent avec
 * la même carte réseau ; affirmer « conflit d'adresses » serait aller
 * au-delà de ce que la mesure permet.
 */
function decrireConflit(conflit) {
  const adresses = conflit.adresses.join(" et ");
  return (
    `Les adresses ${adresses} répondent avec la même adresse matérielle ` +
    `(${conflit.adresse_mac}). Une seule carte réseau répond pour ces ` +
    `${conflit.adresses.length} adresses : conflit d'adresses probable, ` +
    `ou machine configurée avec plusieurs adresses.`
  );
}

module.exports = {
  detecterConflits,
  decrireConflit,
  MAX_IP_PAR_MAC,
};
