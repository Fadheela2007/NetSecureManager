/**
 * services/destinationService.js
 * Donner un NOM et un SERVICE à ce que NetFlow rapporte en chiffres.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE PROBLÈME
 *
 * Le collecteur écrit des lignes de la forme « cette machine a échangé
 * 412 Mo avec 142.250.75.238 sur le port 443 ». C'est exact et illisible.
 * Personne ne sait de tête à qui appartient une adresse, et une page qui
 * en affiche vingt ne fait que déplacer le travail sur l'exploitant.
 *
 * Ce fichier transforme ces deux colonnes en deux mots : QUI (le nom
 * derrière l'adresse) et QUOI (le service derrière le port).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE LE NOM VAUT, ET CE QU'IL NE VAUT PAS — à lire avant de vendre.
 *
 * Le nom vient du DNS INVERSE, c'est-à-dire de ce que le propriétaire de
 * l'adresse a bien voulu publier. Trois conséquences qu'il faut assumer
 * devant un client plutôt que découvrir devant lui :
 *
 *   • Beaucoup d'adresses n'ont aucun nom inverse. On affiche alors
 *     l'adresse, telle quelle. On n'invente rien, et surtout on ne
 *     devine pas « sûrement Google » à partir d'un préfixe.
 *
 *   • Le nom décrit l'HÉBERGEUR, pas toujours le service. Un trafic vers
 *     « ec2-52-x.compute.amazonaws.com » dit Amazon, alors que le service
 *     utilisé est peut-être celui d'une toute autre entreprise hébergée
 *     là. C'est une limite du procédé, pas un défaut de mise en œuvre :
 *     aucun outil ne fait mieux sans inspecter le contenu du trafic.
 *
 *   • Un nom n'est pas une preuve d'usage. « googlevideo.com » signale
 *     très probablement de la vidéo ; ça ne dit ni quelle vidéo, ni qui
 *     la regardait. La plateforme n'en sait pas plus, et ne le prétend
 *     pas — c'est ce qui la sépare d'un outil de surveillance.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * REGROUPER PAR DOMAINE, PAS PAR ADRESSE
 *
 * Un service de vidéo répond depuis des dizaines de serveurs :
 * rr1---sn-4g5e6nzz.googlevideo.com, rr3---sn-a5m7lne6.googlevideo.com…
 * Vingt adresses différentes pour une seule chose. Classées par adresse,
 * elles occupent tout le tableau et chacune paraît négligeable.
 *
 * On regroupe donc par DOMAINE ENREGISTRABLE — la fonction existe déjà
 * dans observationDnsService, écrite pour les relevés DNS. C'est le même
 * besoin, et il n'y a aucune raison d'en avoir deux versions.
 */

const dns = require("node:dns").promises;
const db = require("../db");
const { verdictManuel } = require("./politiqueWebService");
const { domaineEnregistrable } = require("./observationDnsService");

/* ═══════════════════════════════════════════════════════════════════════
   LE SERVICE DERRIÈRE LE PORT
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ports dont le nom apprend quelque chose à un exploitant.
 *
 * VOLONTAIREMENT COURTE. La liste IANA compte des milliers d'entrées, et
 * la recopier donnerait des libellés faux plus souvent qu'utiles : le
 * port 8080 est « HTTP alternatif » chez IANA et à peu près n'importe
 * quoi dans la vraie vie. On ne nomme que ce dont on est sûr ; le reste
 * s'affiche comme un numéro, ce qui est honnête et n'a jamais trompé
 * personne.
 */
const SERVICES = {
  20: "Transfert de fichiers",
  21: "Transfert de fichiers",
  22: "Administration à distance (SSH)",
  23: "Administration à distance (Telnet)",
  25: "Courriel (envoi)",
  53: "Annuaire DNS",
  67: "Attribution d'adresses (DHCP)",
  68: "Attribution d'adresses (DHCP)",
  80: "Web",
  110: "Courriel (relève)",
  123: "Horloge réseau",
  137: "Partage de fichiers Windows",
  138: "Partage de fichiers Windows",
  139: "Partage de fichiers Windows",
  143: "Courriel (relève)",
  161: "Supervision SNMP",
  162: "Supervision SNMP",
  389: "Annuaire d'entreprise",
  443: "Web sécurisé",
  445: "Partage de fichiers Windows",
  465: "Courriel (envoi)",
  514: "Journaux distants",
  587: "Courriel (envoi)",
  636: "Annuaire d'entreprise",
  993: "Courriel (relève)",
  995: "Courriel (relève)",
  1433: "Base de données",
  1521: "Base de données",
  1935: "Flux vidéo",
  3306: "Base de données",
  3389: "Bureau à distance",
  5060: "Téléphonie",
  5061: "Téléphonie",
  5432: "Base de données",
  5900: "Bureau à distance (VNC)",
  6379: "Base de données",
  27017: "Base de données",
};

const PROTOCOLES = { 1: "ICMP", 6: "TCP", 17: "UDP", 58: "ICMPv6" };

/**
 * Nomme un service. Ne devine jamais.
 *
 * Un port inconnu revient sous la forme « TCP 8443 » plutôt que sous un
 * libellé inventé : l'exploitant qui lit « TCP 8443 » sait qu'il doit
 * chercher, alors qu'un faux nom l'aurait arrêté net.
 */
function nommerService(port, protocole) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) {
    return PROTOCOLES[Number(protocole)] || "Autre protocole";
  }
  if (SERVICES[p]) return SERVICES[p];
  const proto = PROTOCOLES[Number(protocole)];
  return proto ? `${proto} ${p}` : `Port ${p}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   LE NOM DERRIÈRE L'ADRESSE
   ═══════════════════════════════════════════════════════════════════════ */

/** Adresses de réseau privé : RFC 1918, lien-local, et la boucle. */
function estPrivee(ip) {
  const o = String(ip).split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n))) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 127) return true;
  return false;
}

/**
 * Durée de validité d'un nom en cache.
 *
 * Longue pour un nom trouvé — l'adresse d'un grand service ne change pas
 * de propriétaire dans la semaine. Beaucoup plus courte pour un échec :
 * un DNS momentanément injoignable ne doit pas condamner une adresse à
 * rester anonyme pendant sept jours.
 */
const VALIDITE_NOM_MS = 7 * 24 * 60 * 60 * 1000;
const VALIDITE_ECHEC_MS = 6 * 60 * 60 * 1000;

/** Nombre de résolutions menées de front. */
const FRONT = 8;

/** Au-delà, on renonce : un DNS lent ne doit pas retarder l'écriture. */
const DELAI_DNS_MS = 2000;

async function inverseAvecDelai(ip) {
  let minuterie;
  try {
    return await Promise.race([
      dns.reverse(ip),
      new Promise((_, rejeter) => {
        minuterie = setTimeout(() => rejeter(new Error("délai dépassé")), DELAI_DNS_MS);
      }),
    ]);
  } finally {
    clearTimeout(minuterie);
  }
}

/**
 * Résout un lot d'adresses, en s'appuyant sur le cache en base.
 *
 * NE LÈVE JAMAIS. Un nom est un confort : son absence doit dégrader
 * l'affichage, pas empêcher la mesure d'être écrite ou lue.
 *
 * @param {string[]} adresses
 * @returns {Promise<Map<string,{nom:string|null, domaine:string|null}>>}
 */
async function resoudreNoms(adresses) {
  const resultat = new Map();
  const uniques = [...new Set((adresses || []).filter(Boolean))];
  if (uniques.length === 0) return resultat;

  let connues = [];
  try {
    const [rows] = await db.query(
      `SELECT adresse, nom, domaine, date_maj FROM NOM_DESTINATION WHERE adresse IN (?)`,
      [uniques]
    );
    connues = rows;
  } catch {
    // Table absente : on renvoie les adresses telles quelles. La page
    // s'affiche, sans les noms. Voir la migration 2026-09-28.
    return resultat;
  }

  const maintenant = Date.now();
  const aResoudre = [];

  const parAdresse = new Map(connues.map((r) => [r.adresse, r]));
  for (const ip of uniques) {
    const ligne = parAdresse.get(ip);
    if (ligne) {
      const age = maintenant - new Date(ligne.date_maj).getTime();
      const validite = ligne.nom ? VALIDITE_NOM_MS : VALIDITE_ECHEC_MS;
      if (age < validite) {
        resultat.set(ip, { nom: ligne.nom, domaine: ligne.domaine });
        continue;
      }
    }
    // Une adresse privée n'a rien à demander à l'Internet. On la marque
    // une fois pour toutes plutôt que d'interroger un DNS qui ne
    // répondra pas.
    if (estPrivee(ip)) {
      resultat.set(ip, { nom: null, domaine: null });
      aResoudre.push({ ip, sauter: true });
      continue;
    }
    aResoudre.push({ ip, sauter: false });
  }

  const aEcrire = [];

  for (let i = 0; i < aResoudre.length; i += FRONT) {
    const lot = aResoudre.slice(i, i + FRONT);
    await Promise.all(
      lot.map(async ({ ip, sauter }) => {
        if (sauter) {
          aEcrire.push([ip, null, null]);
          return;
        }
        let nom = null;
        try {
          const noms = await inverseAvecDelai(ip);
          nom = Array.isArray(noms) && noms[0] ? String(noms[0]).toLowerCase() : null;
        } catch {
          nom = null;
        }
        const domaine = nom ? domaineEnregistrable(nom) : null;
        resultat.set(ip, { nom, domaine });
        aEcrire.push([ip, nom, domaine]);
      })
    );
  }

  if (aEcrire.length > 0) {
    try {
      await db.query(
        `INSERT INTO NOM_DESTINATION (adresse, nom, domaine)
         VALUES ${aEcrire.map(() => "(?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE nom = VALUES(nom), domaine = VALUES(domaine),
                                 date_maj = CURRENT_TIMESTAMP`,
        aEcrire.flat()
      );
    } catch {
      /* Le cache est une optimisation : son échec n'a aucune conséquence
         visible, sinon une résolution refaite au prochain tour. */
    }
  }

  return resultat;
}

/**
 * Comment afficher une destination : le domaine s'il existe, sinon le nom
 * complet, sinon l'adresse. Jamais rien d'inventé entre les trois.
 */
function libelleDestination(ip, resolu) {
  if (resolu?.domaine) return resolu.domaine;
  if (resolu?.nom) return resolu.nom;
  if (estPrivee(ip)) return `${ip} (réseau interne)`;
  return ip;
}

/* ═══════════════════════════════════════════════════════════════════════
   LECTURES POUR L'INTERFACE
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Additionne des lignes de flux par destination puis les nomme.
 *
 * Le regroupement se fait en JavaScript et non en SQL, parce que la clé
 * de regroupement — le domaine — n'est connue qu'après la résolution DNS,
 * qui a lieu après la lecture. Le volume le permet : on lit au plus
 * quelques milliers de lignes déjà agrégées par le collecteur.
 */
async function grouper(lignes) {
  const noms = await resoudreNoms(lignes.map((l) => l.destination));

  const groupes = new Map();
  for (const l of lignes) {
    const resolu = noms.get(l.destination) || null;
    const libelle = libelleDestination(l.destination, resolu);
    const service = nommerService(l.port_distant, l.protocole);
    const cle = `${libelle}|${service}`;

    let g = groupes.get(cle);
    if (!g) {
      g = {
        destination: libelle,
        service,
        port: l.port_distant === null ? null : Number(l.port_distant),
        protocole: l.protocole === null ? null : Number(l.protocole),
        octets_sortants: 0,
        octets_entrants: 0,
        adresses: new Set(),
        machines: new Set(),
      };
      groupes.set(cle, g);
    }
    g.octets_sortants += Number(l.octets_sortants) || 0;
    g.octets_entrants += Number(l.octets_entrants) || 0;
    g.adresses.add(l.destination);
    if (l.id_equipement) g.machines.add(l.id_equipement);
  }

  return [...groupes.values()]
    .map((g) => ({
      destination: g.destination,
      service: g.service,
      port: g.port,
      protocole: g.protocole,
      octets_sortants: g.octets_sortants,
      octets_entrants: g.octets_entrants,
      octets_total: g.octets_sortants + g.octets_entrants,
      nb_adresses: g.adresses.size,
      nb_machines: g.machines.size,
    }))
    .sort((a, b) => b.octets_total - a.octets_total);
}

/* ═══════════════════════════════════════════════════════════════════════
   CE QUI EST INDÉSIRABLE, ET CE QUE CE MOT VEUT DIRE ICI

   La plateforme sait déjà quels domaines une politique d'accès web
   désigne comme indésirables — par catégorie, ou par règle écrite à la
   main. Elle ne s'en servait que pour PRODUIRE du blocage. On s'en sert
   maintenant aussi pour LIRE : parmi les correspondants d'une machine,
   lesquels tombent dans ces listes.

   ── « INDÉSIRABLE » N'EST PAS « BLOQUÉ » ──

   C'est une ÉTIQUETTE, jamais un constat d'action. Ces flux ont été
   OBSERVÉS : ils ont donc eu lieu. Dire « bloqué » de quelque chose
   qu'on vient de voir passer serait un mensonge visible à l'œil nu, et
   la pire faute possible sur un écran de supervision.

   Quand la politique est active et que le flux a eu lieu quand même,
   l'écran le dit : ça signale un poste que le blocage n'atteint pas, et
   c'est une information de valeur — pas un bug d'affichage.

   ── LA PRÉCÉDENCE VIENT DE politiqueWebService ──

   Règle manuelle la plus spécifique d'abord, « autoriser » l'emporte à
   égalité. On réutilise `verdictManuel` plutôt que de réimplémenter ces
   deux lignes : deux versions de la même précédence finiraient par se
   contredire, et l'écran dirait le contraire du pare-feu.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Les suffixes d'un nom d'hôte, du plus précis au plus large.
 *
 * `a.b.exemple.com` -> a.b.exemple.com, b.exemple.com, exemple.com, com
 *
 * Interroger ces quelques valeurs exactes sur un index vaut infiniment
 * mieux qu'un `LIKE '%...'` sur DOMAINE_CATEGORIE, qui compte des
 * centaines de milliers de lignes et ne peut pas utiliser d'index.
 */
function suffixes(nom) {
  const morceaux = String(nom || "").toLowerCase().split(".");
  const liste = [];
  for (let i = 0; i < morceaux.length; i++) {
    liste.push(morceaux.slice(i).join("."));
  }
  return liste;
}

/** Un libellé de destination est-il un nom d'hôte exploitable ? */
function nomExploitable(libelle) {
  const nom = String(libelle || "").trim().toLowerCase();
  // « 192.168.1.10 (réseau interne) », une IP nue, un libellé vide :
  // rien à chercher dans une liste de domaines.
  if (!nom || nom.includes(" ")) return null;
  if (!nom.includes(".")) return null;
  if (/^[0-9.]+$/.test(nom)) return null;
  return nom;
}

/**
 * Ajoute `indesirable` à chaque destination.
 *
 * @param {Array} destinations  ce que rend `grouper()`
 * @param {number|null} idSite  le site dont on lit la politique
 * @returns {Promise<{destinations:Array, politique:object|null}>}
 */
async function marquerIndesirables(destinations, idSite = null) {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return { destinations: destinations || [], politique: null };
  }

  let politique = null;
  try {
    const [rows] = await db.query(
      `SELECT id_politique, nom, active FROM POLITIQUE_WEB
        WHERE id_site <=> ? OR id_site IS NULL
        ORDER BY id_site IS NULL
        LIMIT 1`,
      [idSite ?? null]
    );
    politique = rows[0] || null;
  } catch {
    // Migration du contrôle d'accès web non passée : il n'y a pas de
    // politique, donc rien n'est indésirable. On rend les destinations
    // telles quelles au lieu de faire échouer toute la lecture.
    return { destinations, politique: null };
  }

  if (!politique) return { destinations, politique: null };

  /* Une seule requête pour les règles manuelles — il y en a quelques
     dizaines au plus — et une seule pour les catégories, sur la liste
     exacte des suffixes qui nous intéressent. */
  let manuelles = [];
  const parDomaine = new Map();

  try {
    const [rowsM] = await db.query(
      "SELECT domaine, action FROM POLITIQUE_DOMAINE WHERE id_politique = ?",
      [politique.id_politique]
    );
    manuelles = rowsM.map((r) => ({
      domaine: String(r.domaine).toLowerCase(),
      action: r.action,
    }));

    const candidats = new Set();
    for (const d of destinations) {
      const nom = nomExploitable(d.destination);
      if (nom) for (const s of suffixes(nom)) candidats.add(s);
    }

    if (candidats.size > 0) {
      const [rowsC] = await db.query(
        `SELECT dc.domaine, c.libelle
           FROM DOMAINE_CATEGORIE dc
           JOIN POLITIQUE_CATEGORIE pc ON pc.id_categorie = dc.id_categorie
           JOIN CATEGORIE_WEB c ON c.id_categorie = dc.id_categorie
          WHERE pc.id_politique = ? AND dc.domaine IN (?)`,
        [politique.id_politique, [...candidats]]
      );
      for (const r of rowsC) {
        parDomaine.set(String(r.domaine).toLowerCase(), r.libelle);
      }
    }
  } catch {
    return { destinations, politique: null };
  }

  const marquees = destinations.map((d) => {
    const nom = nomExploitable(d.destination);
    if (!nom) return { ...d, indesirable: null };

    const verdict = verdictManuel(nom, manuelles);
    if (verdict === "autoriser") return { ...d, indesirable: null };
    if (verdict === "bloquer") {
      return {
        ...d,
        indesirable: { raison: "regle_manuelle", categorie: null },
      };
    }

    /* Le suffixe le plus SPÉCIFIQUE qui figure dans une catégorie : c'est
       lui qui nomme la catégorie affichée. Prendre le premier trouvé
       aurait donné « .com » quand il y figure. */
    for (const s of suffixes(nom)) {
      if (parDomaine.has(s)) {
        return {
          ...d,
          indesirable: { raison: "categorie", categorie: parDomaine.get(s) },
        };
      }
    }
    return { ...d, indesirable: null };
  });

  return {
    destinations: marquees,
    politique: {
      nom: politique.nom,
      active: Boolean(politique.active),
    },
  };
}

/** Les correspondants d'UNE machine sur la période. */
async function destinationsDeLEquipement(idEquipement, heures = 24, limite = 15) {
  const [lignes] = await db.query(
    `SELECT id_equipement, destination, port_distant, protocole,
            SUM(octets_sortants) AS octets_sortants,
            SUM(octets_entrants) AS octets_entrants
       FROM FLUX_DESTINATION
      WHERE id_equipement = ?
        AND date_fenetre >= NOW() - INTERVAL ? HOUR
      GROUP BY id_equipement, destination, port_distant, protocole`,
    [idEquipement, heures]
  );

  const groupes = await grouper(lignes);
  return {
    heures: Number(heures),
    depuis: new Date(Date.now() - heures * 3600 * 1000).toISOString(),
    destinations: groupes.slice(0, limite),
    nb_destinations: groupes.length,
  };
}

/**
 * Les correspondants de TOUT le parc visible par l'utilisateur.
 *
 * @param {{clause:string, params:Array}} portee  issue de clauseSite()
 */
async function destinationsDuSite(portee, heures = 24, limite = 15, idSite = null) {
  const [lignes] = await db.query(
    `SELECT f.id_equipement, f.destination, f.port_distant, f.protocole,
            SUM(f.octets_sortants) AS octets_sortants,
            SUM(f.octets_entrants) AS octets_entrants
       FROM FLUX_DESTINATION f
       JOIN EQUIPEMENT e ON e.id_equipement = f.id_equipement
      WHERE f.date_fenetre >= NOW() - INTERVAL ? HOUR
        AND (? IS NULL OR e.id_site = ?)
        AND ${portee.clause}
      GROUP BY f.id_equipement, f.destination, f.port_distant, f.protocole`,
    [heures, idSite || null, idSite || null, ...portee.params]
  );

  const groupes = await grouper(lignes);

  // Le total sert à afficher une part : « 62 % de ce qui est mesuré ».
  // Un chiffre absolu en octets ne se compare à rien.
  const total = groupes.reduce((n, g) => n + g.octets_total, 0);

  return {
    heures: Number(heures),
    depuis: new Date(Date.now() - heures * 3600 * 1000).toISOString(),
    octets_total: total,
    nb_destinations: groupes.length,
    destinations: groupes.slice(0, limite),
  };
}

/**
 * CE QUE COÛTERAIT UN BLOCAGE, AVANT DE LE POSER.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA SEULE FONCTION DE LA PLATEFORME QUI PUISSE CASSER LE RÉSEAU D'UN
 * CLIENT EST CELLE QUI BLOQUE. Elle a donc besoin de quelque chose que
 * les autres n'ont pas : un moyen de se tromper SANS CONSÉQUENCE.
 *
 * « Bloquer dropbox.com » paraît anodin jusqu'à ce qu'on apprenne que
 * quatorze postes s'en servent tous les jours, dont celui de la
 * comptabilité. L'information existe — on vient de la collecter — et la
 * question se pose exactement au moment de cliquer.
 *
 * Ce que renvoie cette fonction n'est pas une estimation : ce sont les
 * machines qui ont RÉELLEMENT échangé avec ce domaine, sur la période
 * observée, et ce qu'elles ont échangé.
 *
 * ── UNE LIMITE À DIRE PLUTÔT QU'À TAIRE ──
 *
 * L'observation ne porte que sur les jours conservés. Un domaine utilisé
 * une fois par mois — la déclaration fiscale, la paie — n'apparaîtra pas,
 * et le blocage semblera sans conséquence. C'est pourquoi la réponse
 * porte la durée observée : « aucune machine sur 7 jours » n'est pas
 * « aucune machine ».
 */
async function impactDuBlocage(portee, domaine, heures = 168) {
  const cible = String(domaine || "").trim().toLowerCase();
  if (!cible) return null;

  const [lignes] = await db.query(
    `SELECT e.id_equipement, e.nom, e.adresse_ip,
            SUM(f.octets_sortants + f.octets_entrants) AS octets,
            COUNT(DISTINCT DATE(f.date_fenetre)) AS jours
       FROM FLUX_DESTINATION f
       JOIN NOM_DESTINATION n ON n.adresse = f.destination
       JOIN EQUIPEMENT e ON e.id_equipement = f.id_equipement
      WHERE n.domaine = ?
        AND f.date_fenetre >= NOW() - INTERVAL ? HOUR
        AND ${portee.clause}
      GROUP BY e.id_equipement, e.nom, e.adresse_ip
      ORDER BY octets DESC`,
    [cible, heures, ...portee.params]
  );

  const machines = lignes.map((l) => ({
    id_equipement: l.id_equipement,
    nom: l.nom,
    adresse_ip: l.adresse_ip,
    octets: Number(l.octets) || 0,
    jours_actifs: Number(l.jours) || 0,
  }));

  return {
    domaine: cible,
    heures: Number(heures),
    /* Combien de jours de mesure existent RÉELLEMENT dans la table. Une
       installation dont le collecteur tourne depuis hier ne peut pas
       répondre pour la semaine, et doit le dire. */
    nb_machines: machines.length,
    octets_total: machines.reduce((n, m) => n + m.octets, 0),
    machines: machines.slice(0, 20),
  };
}

/**
 * Efface les flux plus vieux que la durée de conservation.
 * Voir la migration : cette purge n'a pas d'interrupteur, et c'est voulu.
 */
const JOURS_CONSERVATION = 7;

async function purger() {
  let total = 0;

  try {
    const [r] = await db.query(
      `DELETE FROM FLUX_DESTINATION WHERE date_fenetre < NOW() - INTERVAL ? DAY`,
      [JOURS_CONSERVATION]
    );
    total = r.affectedRows || 0;
  } catch {
    return 0;
  }

  /* ── LE CACHE DE NOMS AUSSI ──

     NOM_DESTINATION n'avait aucune purge : une ligne par adresse distincte
     jamais vue, gardée pour toujours. Un parc bureautique contacte des
     dizaines de milliers d'adresses par mois — publicité, télémétrie,
     réseaux de diffusion — et ce cache serait devenu plus lourd que les
     mesures qu'il sert à nommer.

     Trente jours, et non sept comme les flux : un nom reste utile après
     la disparition des flux qui l'ont fait connaître, et le recalculer
     coûte une requête DNS. On garde donc le cache un peu plus longtemps
     que ce qu'il décrit, sans le garder indéfiniment. */
  try {
    await db.query(
      "DELETE FROM NOM_DESTINATION WHERE date_maj < NOW() - INTERVAL 30 DAY"
    );
  } catch {
    /* Table absente : rien à purger. */
  }

  return total;
}

module.exports = {
  marquerIndesirables,
  suffixes,
  nomExploitable,
  nommerService,
  resoudreNoms,
  libelleDestination,
  destinationsDeLEquipement,
  destinationsDuSite,
  impactDuBlocage,
  purger,
  estPrivee,
  SERVICES,
  JOURS_CONSERVATION,
};
