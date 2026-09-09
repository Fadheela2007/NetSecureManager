/**
 * reseauxLocauxService.js
 * Déduit les plages à scanner des interfaces réseau du serveur.
 *
 * Une carte réseau porte une adresse et un masque — « 192.168.0.71 » avec
 * « 255.255.254.0 ». Ces deux valeurs suffisent à calculer la plage exacte :
 * 192.168.0.0/23. Demander ce calcul à un humain est une mauvaise idée, et
 * c'est vérifié : une plage a été déclarée en /24 là où le masque disait
 * /23, et la moitié du parc est restée invisible pendant des semaines.
 *
 * CE SERVICE PROPOSE, IL NE DÉCIDE PAS.
 *
 * Une machine de bureau porte souvent cinq ou six réseaux : Hyper-V, WSL,
 * VMware, VirtualBox. Un seul est le vrai réseau de l'entreprise. Proposer
 * les six sans distinction ferait douter de toute la suggestion — pire que
 * de ne rien proposer. Les interfaces manifestement virtuelles sont donc
 * signalées comme telles, et c'est l'exploitant qui confirme.
 *
 * Et scanner un réseau n'est jamais un acte neutre : on ne le déclenche
 * pas sur une plage devinée sans validation humaine.
 */

const os = require("os");

/**
 * Noms d'interfaces des hyperviseurs et sous-systèmes courants.
 *
 * Ancrés autant que possible : la leçon du filtre `^lo` qui avalait
 * « Local Area Connection » — l'interface principale de tout poste
 * Windows — a coûté des mesures de trafic nulles sur tout un parc. Un
 * motif trop large ici écarterait le vrai réseau de l'entreprise.
 */
const MOTIFS_VIRTUELLES = [
  /^vEthernet\b/i,           // Hyper-V, WSL : « vEthernet (Default Switch) »
  /\bVMware\b/i,             // VMware Network Adapter VMnet1, VMnet8
  /\bVirtualBox\b/i,
  /\bHyper-?V\b/i,
  /^vmnet\d/i,
  /^virbr\d/i,               // libvirt sous Linux
  /^docker\d/i,
  /^br-[0-9a-f]{12}$/i,      // ponts Docker
  /^veth[0-9a-f]/i,
  /^tap\d/i,
  /^tun\d/i,
  /\bWSL\b/i,
  /\bLoopback\b/i,
];

/** Convertit un masque « 255.255.254.0 » en longueur de préfixe (23). */
function masqueVersPrefixe(masque) {
  const octets = String(masque || "").split(".");
  if (octets.length !== 4) return null;

  let bits = "";
  for (const o of octets) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bits += n.toString(2).padStart(8, "0");
  }

  // Un masque valide est une suite de 1 puis une suite de 0, sans
  // alternance. « 255.0.255.0 » est syntaxiquement lisible et n'a aucun
  // sens : on le refuse plutôt que de produire une plage fantaisiste.
  if (!/^1*0*$/.test(bits)) return null;

  return bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
}

/** Adresse réseau d'une IP selon son masque : 192.168.0.71/23 -> 192.168.0.0 */
function adresseReseau(ip, prefixe) {
  const octets = String(ip || "").split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }

  const entier = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  // `>>> 0` ramène dans les entiers non signés : un décalage sur 32 bits
  // produit sinon un nombre négatif, et une adresse absurde.
  const masque = prefixe === 0 ? 0 : (0xffffffff << (32 - prefixe)) >>> 0;
  const reseau = (entier & masque) >>> 0;

  return [
    (reseau >>> 24) & 255,
    (reseau >>> 16) & 255,
    (reseau >>> 8) & 255,
    reseau & 255,
  ].join(".");
}

/** Vrai si le nom d'interface désigne un adaptateur d'hyperviseur. */
function estVirtuelle(nomInterface) {
  return MOTIFS_VIRTUELLES.some((m) => m.test(String(nomInterface || "")));
}

/**
 * Plages déduites des interfaces du serveur.
 *
 * @param {object} [interfaces] injectable pour les tests
 * @returns {Array<{cidr, adresse, masque, interface, virtuelle, nb_adresses}>}
 *   trié : les réseaux réels d'abord, puis les virtuels.
 */
function detecterReseaux(interfaces) {
  const cartes = interfaces || os.networkInterfaces();
  const trouves = [];
  const dejaVus = new Set();

  for (const [nom, groupe] of Object.entries(cartes || {})) {
    for (const c of groupe || []) {
      // Node renvoie "IPv4" selon les versions, 4 selon d'autres.
      if (c.family !== "IPv4" && c.family !== 4) continue;
      if (c.internal || !c.address || !c.netmask) continue;

      const prefixe = masqueVersPrefixe(c.netmask);
      if (prefixe === null) continue;

      // Un /31 ou /32 ne contient aucune machine à découvrir, et un
      // préfixe plus court qu'un /16 donnerait 65 000 adresses à balayer :
      // ce n'est pas un réseau d'entreprise, c'est une erreur de saisie.
      if (prefixe > 30 || prefixe < 16) continue;

      const reseau = adresseReseau(c.address, prefixe);
      if (!reseau) continue;

      const cidr = `${reseau}/${prefixe}`;
      if (dejaVus.has(cidr)) continue;
      dejaVus.add(cidr);

      trouves.push({
        cidr,
        adresse: c.address,
        masque: c.netmask,
        interface: nom,
        virtuelle: estVirtuelle(nom),
        // Ce que ça représente à scanner, pour que l'exploitant mesure
        // avant de lancer : un /16 fait 65 534 adresses.
        nb_adresses: Math.max(0, 2 ** (32 - prefixe) - 2),
      });
    }
  }

  // Réseaux réels d'abord : c'est celui du haut que l'exploitant prendra.
  return trouves.sort((a, b) => Number(a.virtuelle) - Number(b.virtuelle));
}

module.exports = {
  detecterReseaux,
  masqueVersPrefixe,
  adresseReseau,
  estVirtuelle,
};
