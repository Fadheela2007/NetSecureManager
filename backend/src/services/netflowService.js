/**
 * services/netflowService.js
 * La consommation de CHAQUE machine, sans rien installer sur aucune.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI CE FICHIER EXISTE
 *
 * Mesurer le débit d'une machine suppose un compteur, et un compteur
 * n'existe qu'à trois endroits :
 *
 *   1. dans la machine (SNMP activé, ou un agent qui lit sa carte) —
 *      un poste Windows n'offre ni l'un ni l'autre ;
 *   2. dans le port du commutateur où elle est branchée — il faut un
 *      commutateur administrable, ce que beaucoup de parcs n'ont pas ;
 *   3. au POINT DE PASSAGE : le routeur, par lequel tout transite.
 *
 * Les deux premiers sont déjà lus par la plateforme (discoveryService
 * pour le SNMP direct, attributionPortService pour le port de switch).
 * Le troisième manquait — et c'est le seul qui voie TOUT le parc d'un
 * coup, y compris les machines qui ne disent rien d'elles-mêmes.
 *
 * C'est ainsi que procèdent ntopng, PRTG ou SolarWinds pour afficher la
 * consommation par poste sans agent : ce n'est pas la machine qu'on
 * interroge, c'est le routeur qui raconte ce qu'il a vu passer.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QU'EST NETFLOW, EN UNE PHRASE
 *
 * Le routeur résume chaque conversation qu'il a routée — adresse source,
 * adresse destination, nombre d'octets — et envoie ces résumés en UDP au
 * collecteur. Ce fichier EST le collecteur : il écoute, il décode, il
 * additionne par machine, et il écrit le résultat dans RELEVE, la même
 * table que les mesures SNMP. Tous les écrans existants — classement,
 * courbe du parc, fiche d'équipement — l'affichent alors sans une ligne
 * de code en plus.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE ÇA NE FAIT PAS, ET IL FAUT LE DIRE AVANT DE L'ACTIVER
 *
 * • Le routeur doit SAVOIR exporter du NetFlow, et être configuré pour
 *   le faire vers ce serveur. Un routeur d'opérateur ou une box grand
 *   public n'en est généralement pas capable. Sans exportateur, ce
 *   collecteur écoute un port où rien n'arrive — il le dit au démarrage
 *   et reste silencieux ensuite.
 * • Versions décodées : NetFlow v5 et v9. Pas sFlow (échantillonnage de
 *   paquets, format sans rapport), pas IPFIX (proche de v9, mais ses
 *   champs propriétaires demandent leur propre travail). Un paquet d'une
 *   version inconnue est compté et ignoré, jamais deviné.
 * • Le trafic INTERNE entre deux machines du même réseau ne passe pas
 *   par le routeur : il ne sera donc pas vu. Ce qui est mesuré, c'est ce
 *   qui a été routé — pour un parc bureautique, l'essentiel.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ÉTEINT PAR DÉFAUT
 *
 * Ouvrir un port UDP est un acte d'exploitation, pas un détail : il ne
 * doit pas arriver par surprise à la mise à jour. Une seule ligne dans
 * backend/.env l'active :
 *
 *     NETFLOW_PORT=2055
 *
 * Et, si l'on veut n'accepter que son propre routeur :
 *
 *     NETFLOW_EXPORTEURS=192.168.0.254
 */
const dgram = require("node:dgram");
const db = require("../db");

/** Fenêtre d'agrégation : on écrit un relevé par machine à chaque tour. */
const PERIODE_MS = 5 * 60 * 1000;

/**
 * Nombre maximal d'adresses suivies simultanément.
 *
 * Un routeur mal configuré peut exporter le trafic de l'Internet entier,
 * et chaque adresse inconnue occuperait de la mémoire jusqu'au prochain
 * vidage. Au-delà de ce seuil, les nouvelles adresses sont ignorées :
 * mieux vaut une mesure incomplète qu'un serveur de supervision qui
 * tombe parce qu'il a voulu tout compter.
 */
const MAX_ADRESSES = 20000;

let socket = null;
let minuterie = null;
let debutFenetre = Date.now();

/** adresse IP → { entrant, sortant } en octets, depuis le dernier vidage. */
const compteurs = new Map();

/** Modèles de champs NetFlow v9, par exportateur et par identifiant. */
const modeles = new Map();

/** Statistiques dites une fois, pour que l'exploitant sache que ça vit. */
let paquetsRecus = 0;
let premierExportateurSignale = false;
let versionInconnueSignalee = false;

/* ═══════════════════════════════════════════════════════════════════════
   DÉCODAGE
   ═══════════════════════════════════════════════════════════════════════ */

function adresseDepuis(buf, offset) {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

/**
 * Lit un entier de longueur variable.
 *
 * NetFlow v9 laisse l'exportateur choisir la taille de chaque champ : le
 * compteur d'octets fait 4 octets chez l'un, 8 chez l'autre. Supposer
 * l'une des deux donnerait des débits absurdes chez la moitié des
 * routeurs — d'où cette lecture générique.
 *
 * Au-delà de 6 octets, `readUIntBE` refuse (la précision des entiers
 * JavaScript s'arrête à 2^53) : on passe alors par BigInt.
 */
function lireEntier(buf, offset, longueur) {
  if (offset + longueur > buf.length) return 0;
  if (longueur <= 0) return 0;
  if (longueur <= 6) return buf.readUIntBE(offset, longueur);
  if (longueur === 8) return Number(buf.readBigUInt64BE(offset));
  return 0;
}

/**
 * NetFlow v5 — format figé, le plus simple et encore très répandu.
 *
 * En-tête de 24 octets, puis des enregistrements de 48 octets dont on ne
 * retient que trois champs : l'adresse source, l'adresse destination et
 * le nombre d'octets. Le reste (ports, drapeaux TCP, numéros d'AS) ne
 * sert pas à répondre « qui consomme combien ».
 */
function decoderV5(buf) {
  const flux = [];
  const nombre = buf.readUInt16BE(2);

  for (let i = 0; i < nombre; i++) {
    const debut = 24 + i * 48;
    if (debut + 48 > buf.length) break;
    flux.push({
      source: adresseDepuis(buf, debut),
      destination: adresseDepuis(buf, debut + 4),
      octets: buf.readUInt32BE(debut + 20),
    });
  }
  return flux;
}

/* Identifiants de champs NetFlow v9 utilisés ici. Les autres sont
   sautés en sachant leur longueur, ce qui permet d'avancer dans
   l'enregistrement sans connaître leur signification. */
const CHAMP_OCTETS_ENTREE = 1;
const CHAMP_ADRESSE_SOURCE = 8;
const CHAMP_ADRESSE_DESTINATION = 12;
const CHAMP_OCTETS_SORTIE = 23;

/**
 * NetFlow v9 — format à modèles.
 *
 * L'exportateur annonce d'abord la COMPOSITION de ses enregistrements
 * (un « template »), puis envoie les données brutes qui s'y conforment.
 * Un collecteur qui reçoit des données avant le modèle correspondant ne
 * peut rien en faire : c'est normal, les modèles sont réémis
 * périodiquement, et les premières minutes peuvent être muettes.
 *
 * `cle` distingue les exportateurs : deux routeurs peuvent employer le
 * même numéro de modèle pour des compositions différentes, et les
 * confondre produirait des chiffres faux plutôt qu'une erreur visible.
 */
function decoderV9(buf, cle) {
  const flux = [];
  if (buf.length < 20) return flux;

  const identifiantSource = buf.readUInt32BE(16);
  let position = 20;

  while (position + 4 <= buf.length) {
    const idJeu = buf.readUInt16BE(position);
    const longueur = buf.readUInt16BE(position + 2);
    if (longueur < 4 || position + longueur > buf.length) break;

    const finJeu = position + longueur;

    if (idJeu === 0) {
      // Jeu de modèles.
      let p = position + 4;
      while (p + 4 <= finJeu) {
        const idModele = buf.readUInt16BE(p);
        const nbChamps = buf.readUInt16BE(p + 2);
        p += 4;

        const champs = [];
        for (let i = 0; i < nbChamps && p + 4 <= finJeu; i++) {
          champs.push({ type: buf.readUInt16BE(p), longueur: buf.readUInt16BE(p + 2) });
          p += 4;
        }
        if (champs.length === nbChamps && nbChamps > 0) {
          modeles.set(`${cle}|${identifiantSource}|${idModele}`, champs);
        }
      }
    } else if (idJeu > 255) {
      // Jeu de données : il faut le modèle du même numéro.
      const champs = modeles.get(`${cle}|${identifiantSource}|${idJeu}`);
      if (champs) {
        const taille = champs.reduce((n, c) => n + c.longueur, 0);
        if (taille > 0) {
          let p = position + 4;
          // `+ taille <= finJeu` : le bourrage de fin de jeu est ignoré,
          // il est plus court qu'un enregistrement complet.
          while (p + taille <= finJeu) {
            let source = null;
            let destination = null;
            let octets = 0;
            let decalage = p;

            for (const champ of champs) {
              if (champ.type === CHAMP_ADRESSE_SOURCE && champ.longueur === 4) {
                source = adresseDepuis(buf, decalage);
              } else if (champ.type === CHAMP_ADRESSE_DESTINATION && champ.longueur === 4) {
                destination = adresseDepuis(buf, decalage);
              } else if (
                champ.type === CHAMP_OCTETS_ENTREE ||
                champ.type === CHAMP_OCTETS_SORTIE
              ) {
                octets += lireEntier(buf, decalage, champ.longueur);
              }
              decalage += champ.longueur;
            }

            if (source && destination) flux.push({ source, destination, octets });
            p += taille;
          }
        }
      }
    }
    // idJeu === 1 : modèles d'options, sans intérêt ici. On saute.

    position = finJeu;
  }

  return flux;
}

/**
 * Décode un paquet, quelle que soit sa version.
 * Ne lève jamais : un paquet malformé est ignoré, pas fatal.
 */
function decoderPaquet(buf, cle) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return [];
  const version = buf.readUInt16BE(0);
  try {
    if (version === 5) return decoderV5(buf);
    if (version === 9) return decoderV9(buf, cle);
  } catch {
    return [];
  }

  if (!versionInconnueSignalee) {
    versionInconnueSignalee = true;
    console.log(
      `NetFlow — paquets de version ${version} reçus : non décodés. ` +
        "Ce collecteur lit NetFlow v5 et v9."
    );
  }
  return [];
}

/* ═══════════════════════════════════════════════════════════════════════
   COMPTABILISATION
   ═══════════════════════════════════════════════════════════════════════ */

function ajouter(ip, sens, octets) {
  if (!octets || octets <= 0) return;
  let ligne = compteurs.get(ip);
  if (!ligne) {
    if (compteurs.size >= MAX_ADRESSES) return;
    ligne = { entrant: 0, sortant: 0 };
    compteurs.set(ip, ligne);
  }
  ligne[sens] += octets;
}

/**
 * Un flux compte DEUX fois, et ce n'est pas une erreur.
 *
 * Une conversation entre 192.168.0.42 et un serveur d'Internet est du
 * SORTANT pour .42 si elle part de lui, et de l'ENTRANT pour lui si elle
 * y arrive. Chaque flux est donc imputé à son émetteur en sortie et à
 * son destinataire en entrée ; l'adresse qui ne fait pas partie du parc
 * sera simplement ignorée au moment d'écrire en base, faute
 * d'équipement correspondant.
 */
function comptabiliser(flux) {
  for (const f of flux) {
    ajouter(f.source, "sortant", f.octets);
    ajouter(f.destination, "entrant", f.octets);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   ÉCRITURE
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Convertit les octets accumulés en débit moyen, et l'écrit dans RELEVE.
 *
 * ── POURQUOI ON N'ÉCRIT PAS POUR UNE MACHINE DÉJÀ MESURÉE EN SNMP ──
 *
 * Une imprimante qui expose ses compteurs est déjà relevée par le cycle
 * de supervision. Y ajouter une mesure NetFlow ferait cohabiter deux
 * méthodes dans la même moyenne : l'une compte ce qui traverse sa carte
 * réseau, l'autre ce que le routeur a vu passer — deux chiffres justes,
 * jamais égaux. La moyenne des deux ne voudrait rien dire.
 *
 * Le SNMP direct garde donc la priorité, comme il l'a déjà sur la mesure
 * par port de commutateur. NetFlow sert ce pour quoi il est irremplaçable
 * : les machines dont aucun compteur n'est lisible.
 */
async function vider() {
  const maintenant = Date.now();
  const secondes = Math.max(1, Math.round((maintenant - debutFenetre) / 1000));
  debutFenetre = maintenant;

  if (compteurs.size === 0) return;

  const parIp = new Map(compteurs);
  compteurs.clear();

  try {
    const adresses = [...parIp.keys()];

    // Les équipements connus portant ces adresses, et ceux qu'un relevé
    // SNMP a déjà servis pendant la fenêtre.
    const [lignes] = await db.query(
      `SELECT e.id_equipement, e.adresse_ip,
              EXISTS (
                SELECT 1 FROM RELEVE r
                WHERE r.id_equipement = e.id_equipement
                  AND r.trafic_entrant_kbps IS NOT NULL
                  AND r.date_releve >= NOW() - INTERVAL ? SECOND
              ) AS deja_mesure
       FROM EQUIPEMENT e
       WHERE e.adresse_ip IN (?)`,
      [secondes, adresses]
    );

    const aEcrire = [];
    for (const ligne of lignes) {
      if (Number(ligne.deja_mesure) === 1) continue;
      const compte = parIp.get(ligne.adresse_ip);
      if (!compte) continue;

      // octets → kbit/s : ×8 pour les bits, ÷1000 pour les kilobits.
      const entrant = (compte.entrant * 8) / 1000 / secondes;
      const sortant = (compte.sortant * 8) / 1000 / secondes;
      if (entrant <= 0 && sortant <= 0) continue;

      aEcrire.push([ligne.id_equipement, entrant, sortant]);
    }

    if (aEcrire.length === 0) return;

    await db.query(
      `INSERT INTO RELEVE (id_equipement, trafic_entrant_kbps, trafic_sortant_kbps)
       VALUES ${aEcrire.map(() => "(?, ?, ?)").join(", ")}`,
      aEcrire.flat()
    );

    console.log(
      `NetFlow — ${aEcrire.length} machine(s) mesurée(s) sur les ${Math.round(
        secondes / 60
      )} dernière(s) minute(s), sur ${parIp.size} adresse(s) vues.`
    );
  } catch (err) {
    // Une écriture ratée ne doit pas arrêter le collecteur : le tour
    // suivant repartira d'une fenêtre propre.
    console.error("NetFlow — enregistrement impossible:", err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   CYCLE DE VIE
   ═══════════════════════════════════════════════════════════════════════ */

/** Liste blanche d'exportateurs, ou null si l'on accepte tout le monde. */
function exportateursAutorises() {
  const brut = (process.env.NETFLOW_EXPORTEURS || "").trim();
  if (!brut) return null;
  const liste = brut
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return liste.length > 0 ? new Set(liste) : null;
}

function demarrer() {
  const port = Number(process.env.NETFLOW_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;

  const autorises = exportateursAutorises();
  socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (message, expediteur) => {
    if (autorises && !autorises.has(expediteur.address)) return;

    paquetsRecus++;
    if (!premierExportateurSignale) {
      premierExportateurSignale = true;
      console.log(
        `NetFlow — premier paquet reçu de ${expediteur.address}. ` +
          "L'export est en place ; les premières mesures apparaîtront au " +
          "prochain vidage."
      );
    }

    comptabiliser(decoderPaquet(message, expediteur.address));
  });

  socket.on("error", (err) => {
    console.error(
      `NetFlow — écoute impossible sur le port ${port} : ${err.message}. ` +
        "Le reste de la plateforme n'est pas affecté."
    );
    try {
      socket.close();
    } catch {
      /* déjà fermé */
    }
    socket = null;
  });

  socket.bind(port, () => {
    console.log(
      `\nNetFlow — collecteur à l'écoute sur le port UDP ${port}` +
        (autorises ? ` (exportateurs acceptés : ${[...autorises].join(", ")})` : "") +
        ".\n" +
        "  À configurer sur le routeur : exporter le NetFlow vers l'adresse de\n" +
        "  ce serveur, port " +
        port +
        ", version 5 ou 9. Sans cela, ce port reste muet.\n"
    );
  });

  debutFenetre = Date.now();
  minuterie = setInterval(() => {
    vider().catch(() => {});
  }, PERIODE_MS);
  // Le collecteur ne doit pas, à lui seul, empêcher le processus de
  // s'arrêter proprement.
  if (typeof minuterie.unref === "function") minuterie.unref();

  return true;
}

function arreter() {
  if (minuterie) clearInterval(minuterie);
  minuterie = null;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* déjà fermé */
    }
  }
  socket = null;
}

function etat() {
  return {
    actif: Boolean(socket),
    paquets: paquetsRecus,
    adresses_suivies: compteurs.size,
    modeles_connus: modeles.size,
  };
}

module.exports = {
  demarrer,
  arreter,
  etat,
  // Exposés pour les tests : logique pure, sans réseau ni base.
  decoderPaquet,
  decoderV5,
  decoderV9,
  comptabiliser,
  _compteurs: compteurs,
};
