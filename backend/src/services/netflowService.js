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
const destinations = require("./destinationService");

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

/**
 * Le même trafic, mais détaillé PAR CORRESPONDANT.
 *
 * `compteurs` répond « combien », cette carte répond « vers quoi ». Elles
 * sont alimentées par la même boucle et vidées ensemble : ce sont deux
 * lectures d'un seul flux, pas deux mesures.
 *
 * Clé : source|destination|portSource|portDestination|protocole.
 * On garde les deux ports parce qu'on ignore encore, à ce stade, laquelle
 * des deux adresses appartient au parc — donc lequel des deux ports nomme
 * le service. La question est tranchée au vidage, quand la base peut dire
 * quelles adresses sont des équipements connus.
 */
const conversations = new Map();

/**
 * Plafond de conversations suivies dans une fenêtre.
 *
 * Un parc bureautique en produit quelques milliers par tranche de cinq
 * minutes. Ce plafond n'est pas un réglage de confort : sans lui, un
 * routeur mal configuré qui exporterait le trafic d'un opérateur entier
 * remplirait la mémoire du serveur en quelques minutes.
 */
const MAX_CONVERSATIONS = 40000;

/**
 * Correspondants gardés par machine au moment d'écrire.
 *
 * Un poste ordinaire parle à quelques dizaines de serveurs par tranche de
 * cinq minutes, et la queue de cette distribution est faite d'échanges de
 * quelques kilo-octets — une requête DNS, une vérification de mise à
 * jour. Les écrire tous multiplierait la taille de la table par dix pour
 * une information que personne ne lira jamais.
 */
const MAX_DESTINATIONS_PAR_MACHINE = 60;

/** Modèles de champs NetFlow v9, par exportateur et par identifiant. */
const modeles = new Map();

/** Statistiques dites une fois, pour que l'exploitant sache que ça vit. */
let paquetsRecus = 0;
let premierExportateurSignale = false;
let versionInconnueSignalee = false;
let tableDestinationsSignalee = false;
let dernierePurge = 0;

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
 * En-tête de 24 octets, puis des enregistrements de 48 octets à
 * composition fixe.
 *
 * On en retient six champs : les deux adresses, les deux PORTS, le
 * protocole et le nombre d'octets. Les ports étaient auparavant ignorés —
 * « ne sert pas à répondre qui consomme combien », disait le commentaire,
 * ce qui était vrai de la question d'alors. Ils sont ce qui permet
 * aujourd'hui de répondre à la suivante : vers QUOI.
 *
 * Le reste (drapeaux TCP, numéros d'AS, masques) est toujours sauté.
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
      // Décalages figés par la spécification v5 : srcport à 32, dstport à
      // 34, protocole à 38. Ils ne varient pas d'un routeur à l'autre —
      // c'est tout l'intérêt de ce format par rapport au v9.
      portSource: buf.readUInt16BE(debut + 32),
      portDestination: buf.readUInt16BE(debut + 34),
      protocole: buf[debut + 38],
    });
  }
  return flux;
}

/* Identifiants de champs NetFlow v9 utilisés ici. Les autres sont
   sautés en sachant leur longueur, ce qui permet d'avancer dans
   l'enregistrement sans connaître leur signification. */
const CHAMP_OCTETS_ENTREE = 1;
const CHAMP_PROTOCOLE = 4;
const CHAMP_PORT_SOURCE = 7;
const CHAMP_ADRESSE_SOURCE = 8;
const CHAMP_PORT_DESTINATION = 11;
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
            let portSource = null;
            let portDestination = null;
            let protocole = null;
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
              } else if (champ.type === CHAMP_PORT_SOURCE) {
                portSource = lireEntier(buf, decalage, champ.longueur);
              } else if (champ.type === CHAMP_PORT_DESTINATION) {
                portDestination = lireEntier(buf, decalage, champ.longueur);
              } else if (champ.type === CHAMP_PROTOCOLE) {
                protocole = lireEntier(buf, decalage, champ.longueur);
              }
              decalage += champ.longueur;
            }

            /* Un exportateur n'est pas tenu d'inclure les ports dans son
               modèle. Quand ils manquent, le flux reste compté dans le
               total de la machine et sa destination est enregistrée sans
               service nommé — une information partielle, jamais une
               information inventée. */
            if (source && destination) {
              flux.push({ source, destination, octets, portSource, portDestination, protocole });
            }
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
    ajouterConversation(f);
  }
}

/**
 * Additionne un flux dans la carte des conversations.
 *
 * On n'essaie PAS de deviner ici laquelle des deux adresses appartient au
 * parc. La tentation serait de tester les plages privées (10.x, 192.168.x)
 * et d'en conclure « celle-ci est interne » : ce serait juste dans la
 * plupart des cas et faux dans ceux qui comptent — un site qui utilise des
 * adresses publiques à l'intérieur, une machine du parc joignable depuis
 * l'extérieur. Une supposition fausse imputerait le trafic à la mauvaise
 * machine, sans que rien ne le signale.
 *
 * La base sait répondre avec certitude. On attend le vidage.
 */
function ajouterConversation(f) {
  if (!f.octets || f.octets <= 0) return;
  const cle = `${f.source}|${f.destination}|${f.portSource ?? ""}|${f.portDestination ?? ""}|${f.protocole ?? ""}`;
  let ligne = conversations.get(cle);
  if (!ligne) {
    if (conversations.size >= MAX_CONVERSATIONS) return;
    ligne = {
      source: f.source,
      destination: f.destination,
      portSource: f.portSource ?? null,
      portDestination: f.portDestination ?? null,
      protocole: f.protocole ?? null,
      octets: 0,
    };
    conversations.set(cle, ligne);
  }
  ligne.octets += f.octets;
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
/**
 * Impute chaque conversation à la machine du parc qui y a participé.
 *
 * ── QUEL PORT NOMME LE SERVICE ──
 *
 * Celui du CORRESPONDANT, jamais celui de la machine du parc. Un poste
 * qui navigue ouvre un port local tiré au hasard — 52134, puis 52135 à la
 * page suivante — vers le port 443 du serveur. Retenir le port local
 * produirait une ligne différente par connexion et ne nommerait rien ;
 * c'est le port distant qui dit « web sécurisé ».
 *
 * ── UNE CONVERSATION ENTRE DEUX MACHINES DU PARC COMPTE DEUX FOIS ──
 *
 * Et c'est volontaire : elle est sortante pour l'une, entrante pour
 * l'autre, et chacune doit la voir sur sa propre fiche. Les deux lignes
 * décrivent le même échange vu des deux bouts, pas deux échanges.
 */
async function ecrireDestinations(echanges, lignesEquipements, dateFenetre) {
  if (!Array.isArray(echanges) || echanges.length === 0) return;

  const idParIp = new Map(lignesEquipements.map((l) => [l.adresse_ip, l.id_equipement]));
  if (idParIp.size === 0) return;

  /* Clé : machine + correspondant + port distant + protocole. Plusieurs
     conversations s'y fondent — c'est exactement ce qu'on veut : dix
     onglets ouverts vers le même service font une ligne, pas dix. */
  const parCle = new Map();

  const imputer = (idEquipement, autreIp, portDistant, protocole, sens, octets) => {
    const cle = `${idEquipement}|${autreIp}|${portDistant ?? ""}|${protocole ?? ""}`;
    let l = parCle.get(cle);
    if (!l) {
      l = {
        id: idEquipement,
        destination: autreIp,
        port: portDistant,
        protocole,
        sortants: 0,
        entrants: 0,
      };
      parCle.set(cle, l);
    }
    l[sens] += octets;
  };

  for (const e of echanges) {
    const idSource = idParIp.get(e.source);
    const idDestination = idParIp.get(e.destination);

    // Aucun des deux bouts n'est une machine connue : le flux n'a personne
    // à qui être imputé. On le laisse tomber plutôt que d'inventer une
    // ligne orpheline.
    if (idSource === undefined && idDestination === undefined) continue;

    if (idSource !== undefined) {
      imputer(idSource, e.destination, e.portDestination, e.protocole, "sortants", e.octets);
    }
    if (idDestination !== undefined) {
      imputer(idDestination, e.source, e.portSource, e.protocole, "entrants", e.octets);
    }
  }

  if (parCle.size === 0) return;

  /* On ne garde que les plus gros correspondants de chaque machine. Voir
     MAX_DESTINATIONS_PAR_MACHINE : la queue est faite d'échanges de
     quelques kilo-octets qui n'apprennent rien. */
  const parMachine = new Map();
  for (const l of parCle.values()) {
    if (!parMachine.has(l.id)) parMachine.set(l.id, []);
    parMachine.get(l.id).push(l);
  }

  const retenues = [];
  for (const liste of parMachine.values()) {
    liste.sort((a, b) => b.sortants + b.entrants - (a.sortants + a.entrants));
    for (const l of liste.slice(0, MAX_DESTINATIONS_PAR_MACHINE)) {
      if (l.sortants <= 0 && l.entrants <= 0) continue;
      const port = Number.isInteger(l.port) && l.port > 0 ? l.port : null;
      const proto = Number.isInteger(l.protocole) ? l.protocole : null;
      retenues.push([l.id, l.destination, port, proto, l.sortants, l.entrants, dateFenetre]);
    }
  }

  if (retenues.length === 0) return;

  const TAILLE_LOT = 200;
  for (let i = 0; i < retenues.length; i += TAILLE_LOT) {
    const lot = retenues.slice(i, i + TAILLE_LOT);
    try {
      await db.query(
        `INSERT INTO FLUX_DESTINATION
           (id_equipement, destination, port_distant, protocole,
            octets_sortants, octets_entrants, date_fenetre)
         VALUES ${lot.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE
           octets_sortants = octets_sortants + VALUES(octets_sortants),
           octets_entrants = octets_entrants + VALUES(octets_entrants)`,
        lot.flat()
      );
    } catch (err) {
      /* Table absente : la migration 2026-09-28 n'est pas appliquée. On le
         dit UNE fois et le collecteur continue son travail d'origine — la
         mesure du débit, elle, n'a pas besoin de cette table. */
      if (!tableDestinationsSignalee) {
        tableDestinationsSignalee = true;
        console.warn(
          "\n⚠  NetFlow — impossible d'enregistrer les destinations : " +
            err.message +
            "\n   Le débit par machine continue d'être mesuré.\n" +
            "   Pour savoir VERS QUOI part ce débit :\n" +
            "   backend/migrations/2026-09-28-flux-destinations.sql\n"
        );
      }
      return;
    }
  }
}

async function vider() {
  const maintenant = Date.now();
  const secondes = Math.max(1, Math.round((maintenant - debutFenetre) / 1000));

  /* La fenêtre est datée par son DÉBUT, arrondi à la minute. Deux
     collecteurs, ou un redémarrage en cours de route, retombent ainsi sur
     la même valeur et additionnent dans la même ligne au lieu d'en créer
     deux qu'aucune requête ne saurait rapprocher. */
  const debutDeLaFenetre = new Date(Math.floor(debutFenetre / 60000) * 60000);
  debutFenetre = maintenant;

  if (compteurs.size === 0 && conversations.size === 0) return;

  const parIp = new Map(compteurs);
  compteurs.clear();
  const echanges = [...conversations.values()];
  conversations.clear();

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

    /* ── LES CORRESPONDANTS ──
       Écrits pour TOUTES les machines connues, y compris celles déjà
       mesurées en SNMP. Le doublon qu'on évite plus haut concerne le
       DÉBIT — deux méthodes de mesure dans la même moyenne. Ici il n'y a
       pas de concurrence : aucune autre source ne dit vers quoi une
       machine parle, et une imprimante relevée en SNMP a autant besoin
       qu'une autre qu'on sache à quel serveur elle s'adresse. */
    await ecrireDestinations(echanges, lignes, debutDeLaFenetre);

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
    /* La purge vit ici plutôt que dans un cron : cette table n'existe que
       si ce collecteur tourne, et sa durée de conservation est une règle
       du produit, pas un réglage. Une heure entre deux passages. */
    if (Date.now() - dernierePurge > 60 * 60 * 1000) {
      dernierePurge = Date.now();
      destinations.purger().catch(() => {});
    }
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
    conversations_suivies: conversations.size,
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
  _conversations: conversations,
};
