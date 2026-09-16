/**
 * services/planAdressageService.js
 * Le plan d'adressage : ce qui est attribué, ce qui est libre, ce qui est
 * réservé — plage par plage.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE VUE EXISTE
 *
 * Un inventaire dit ce qu'on a trouvé. Il ne dit jamais ce qu'on n'a PAS
 * trouvé — et sur un réseau, c'est la moitié de l'information qui manque.
 * « 47 équipements » ne répond ni à « mon réseau est-il plein ? », ni à
 * « quelle adresse puis-je donner à la nouvelle imprimante ? », ni à
 * « pourquoi ce /23 alors que 40 machines suffiraient d'un /26 ? ».
 *
 * Elle règle aussi, autrement, le problème des adresses fantômes. Une
 * adresse derrière laquelle il n'y a personne ne DISPARAÎT pas : elle
 * redevient ce qu'elle a toujours été — une adresse LIBRE. Un inventaire
 * qui rétrécit sans explication inquiète ; un plan d'adressage où le
 * compte des libres augmente d'autant se comprend d'un coup d'œil.
 *
 * CE QUE NAGIOS, ZABBIX, CENTREON ET CHECKMK N'AFFICHENT PAS. Ils
 * supervisent des hôtes. La gestion du plan d'adressage est un autre
 * métier, tenu par d'autres outils (phpIPAM, NetBox) — donc un autre
 * logiciel à installer, une autre base à tenir à jour, et deux
 * inventaires qui divergent au bout de trois mois. Ici, les deux vues
 * lisent la MÊME table : elles ne peuvent pas se contredire.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AUCUN PAQUET N'EST ENVOYÉ
 *
 * Ce calcul ne sonde rien : il croise la plage déclarée avec les
 * équipements déjà découverts. Il est donc instantané, répétable, et
 * utilisable devant un client sans rien émettre sur son réseau.
 *
 * Conséquence à dire, et elle est écrite dans la réponse : « libre »
 * signifie « aucun équipement connu ne la porte », pas « personne ne s'en
 * sert ». Une machine jamais scannée y est invisible. C'est le prix de
 * l'absence de trafic, et il faut l'assumer plutôt que de le cacher.
 */
const db = require("../db");
const { cidrSubnet, toLong, fromLong } = require("./adressesIp");
const { detecterReseaux } = require("./reseauxLocauxService");

/** Combien d'adresses libres on cite en exemple. */
const EXEMPLES_LIBRES = 24;

/* ═══════════════════════════════════════════════════════════════════════
   LES ADRESSES LIBRES, EN INTERVALLES PLUTÔT QU'UNE PAR UNE

   POURQUOI LA LISTE PLATE NE RÉPONDAIT PAS À LA QUESTION.

   L'écran citait vingt-quatre adresses disponibles, les unes après les
   autres. Cela répond à « donne-moi UNE adresse », et à rien d'autre. Or
   les vraies questions d'un exploitant devant un plan d'adressage sont :

     « où ai-je encore de la place pour dix serveurs d'affilée ? »
     « ce /23 est-il occupé de façon tassée, ou troué partout ? »
     « où commence la zone que je peux réserver au Wi-Fi invité ? »

   Vingt-quatre adresses isolées ne répondent à aucune des trois. Pire :
   sur un réseau à moitié plein, elles viennent toutes du même trou — ce
   qui laisse croire qu'il n'y a de place qu'à cet endroit.

   UN INTERVALLE RÉPOND AUX TROIS D'UN COUP : « 192.168.1.48 →
   192.168.1.99, 52 adresses ». On voit la place, sa taille, et où elle
   commence.

   POURQUOI ON NE CONSTRUIT PAS LA LISTE COMPLÈTE. Un /16 compte 65 534
   adresses attribuables. On parcourt la plage une fois — c'est
   instantané — mais on ne RETIENT que les intervalles, dont le nombre
   est borné. Au-delà, on dit combien il en reste plutôt que de les
   envoyer : un tableau de plusieurs milliers de lignes a déjà fait
   tomber ce serveur une fois.
   ═══════════════════════════════════════════════════════════════════════ */

/** Nombre d'intervalles renvoyés au plus. Au-delà, on compte. */
const MAX_INTERVALLES = 60;

/**
 * Au-delà de cette taille, on ne calcule plus les intervalles.
 *
 * Le parcours resterait rapide, mais une plage démesurée vient toujours
 * d'une faute de saisie (« 10.0.0.0/8 » pour « 10.0.0.0/24 »), et le
 * produit refuse déjà de la scanner. Il serait incohérent de la
 * cartographier ici.
 */
const MAX_ADRESSES_PARCOURUES = 100_000;

/**
 * Regroupe les adresses libres en intervalles contigus.
 *
 * @param {object} sousReseau   résultat de cidrSubnet()
 * @param {Set<string>} prises  adresses occupées ou réservées
 * @param {function} estReservee  (ip) => bool, pour les .0 et .255 intérieurs
 * @returns {{intervalles: Array, tronques: number}|null} null si trop large
 */
function intervallesLibres(sousReseau, prises, estReservee) {
  const debut = toLong(sousReseau.firstAddress);
  const fin = toLong(sousReseau.lastAddress);

  if (fin - debut + 1 > MAX_ADRESSES_PARCOURUES) return null;

  const intervalles = [];
  let courantDebut = null;
  let courantFin = null;
  let tronques = 0;

  /** Referme l'intervalle en cours, s'il y en a un. */
  const fermer = () => {
    if (courantDebut === null) return;
    if (intervalles.length < MAX_INTERVALLES) {
      intervalles.push({
        debut: fromLong(courantDebut >>> 0),
        fin: fromLong(courantFin >>> 0),
        nb: courantFin - courantDebut + 1,
      });
    } else {
      tronques++;
    }
    courantDebut = null;
    courantFin = null;
  };

  for (let n = debut; n <= fin; n++) {
    const a = fromLong(n >>> 0);
    /* EXACTEMENT le même critère que `libres_exemples` : ne jamais
       proposer une adresse que le balayage n'ira pas voir. Deux écrans du
       même logiciel qui se contrediraient là-dessus seraient pires que
       pas d'écran du tout. */
    if (!prises.has(a) && !estReservee(a)) {
      if (courantDebut === null) courantDebut = n;
      courantFin = n;
    } else {
      fermer();
    }
  }
  fermer();

  return { intervalles, tronques };
}

/**
 * Nombre d'adresses attribuables à une machine.
 * /31 et /32 sont des cas à part : ils n'ont ni réseau ni diffusion à
 * retrancher (RFC 3021, et l'adresse unique d'une vérification ciblée).
 */
function nbAttribuables(prefixe) {
  if (prefixe >= 31) return 2 ** (32 - prefixe);
  return 2 ** (32 - prefixe) - 2;
}

/**
 * Combien d'adresses en .0 ou .255 se trouvent À L'INTÉRIEUR de la plage,
 * sans compter le vrai réseau ni la vraie diffusion.
 *
 * POURQUOI ELLES COMPTENT À PART, ET POURQUOI CE N'EST PAS UN DÉTAIL.
 *
 * Sur un /23, 192.168.0.255 et 192.168.1.0 sont techniquement des
 * adresses d'hôte valides. Mais les postes du réseau sont configurés en
 * /24 — comme la quasi-totalité du matériel — et traitent la première
 * comme une diffusion : ils répondent tous au ping. Cette réponse ne
 * vient d'aucun appareil. Un équipement fantôme naissait ainsi, puis
 * alertait indéfiniment.
 *
 * Le balayage les écarte donc volontairement (discoveryService,
 * estAdresseReservee). Le plan d'adressage doit dire EXACTEMENT la même
 * chose : les compter comme libres ferait proposer une adresse que le
 * produit lui-même refuse de scanner — deux écrans du même logiciel qui
 * se contredisent.
 *
 * Calculé, jamais énuméré : un /16 en contient 510.
 */
function nbIntermediairesReservees(prefixe) {
  if (prefixe > 23) return 0;
  return 2 * 2 ** (24 - prefixe) - 2;
}

/** Dernier octet à 0 ou 255 — même règle que le balayage. */
function estOctetReserve(ip) {
  const dernier = Number(String(ip).split(".")[3]);
  return dernier === 0 || dernier === 255;
}

/**
 * Adresses du serveur lui-même situées dans cette plage. Elles sont
 * occupées, mais par la plateforme — pas par un équipement découvert. Les
 * compter comme « libres » ferait proposer à l'exploitant l'adresse de sa
 * propre machine.
 */
function adressesDuServeur(sousReseau) {
  try {
    return detecterReseaux()
      .map((r) => r.adresse)
      .filter((a) => sousReseau.contains(a));
  } catch {
    return [];
  }
}

/**
 * @param {number} idSite
 * @param {string} cidr
 * @returns {Promise<object>} le plan d'une plage
 */
async function planDUnePlage(idSite, cidr) {
  const sousReseau = cidrSubnet(cidr);
  const prefixe = sousReseau.subnetMaskLength;
  const total = nbAttribuables(prefixe);

  // On lit TOUS les équipements du site, puis on filtre par appartenance.
  // Un LIKE sur l'adresse serait faux dès que la plage n'est pas un /24
  // aligné — exactement le cas d'un /23, qui a déjà coûté la moitié d'un
  // parc sur ce projet.
  const [equipements] = await db.query(
    `SELECT e.id_equipement, e.adresse_ip, e.statut,
            COALESCE(e.nom_personnalise, e.nom) AS nom,
            e.fabricant, t.libelle AS type,
            e.preuve_existence, e.preuve_detail, e.derniere_decouverte
     FROM EQUIPEMENT e
     LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
     WHERE e.id_site = ?`,
    [idSite]
  );

  const occupees = equipements
    .filter((e) => sousReseau.contains(e.adresse_ip))
    .sort((a, b) => toLong(a.adresse_ip) - toLong(b.adresse_ip));

  const prises = new Set(occupees.map((e) => e.adresse_ip));

  // ── LES RÉSERVÉES ──
  //
  // Réseau et diffusion ne sont pas « libres » : la norme interdit de les
  // attribuer. Les compter comme disponibles ferait donner à une machine
  // une adresse qui ne peut pas fonctionner — et le défaut serait
  // rapporté comme une panne réseau, jamais comme une erreur de plan.
  const reservees = [];
  if (prefixe <= 30) {
    reservees.push(
      { adresse: sousReseau.networkAddress, role: "adresse de réseau (non attribuable)" },
      { adresse: sousReseau.broadcastAddress, role: "adresse de diffusion (non attribuable)" }
    );
  }
  for (const a of adressesDuServeur(sousReseau)) {
    if (!prises.has(a)) {
      reservees.push({ adresse: a, role: "cette plateforme" });
      prises.add(a);
    }
  }

  // Les .0 et .255 intérieurs à la plage. Énumérés tant qu'ils tiennent à
  // l'écran, comptés au-delà.
  /* Comptées SANS celles qu'un équipement occupe déjà.

     Le total analytique compte toutes les .0 et .255 intérieures. Si
     l'une d'elles porte un équipement — cas rare mais réel, c'est même
     ainsi que le premier fantôme est né — elle serait retranchée deux
     fois : une comme occupée, une comme réservée. Le compte des libres
     baissait alors sans raison visible, sur l'écran même dont le sujet
     est que ces trois nombres s'additionnent. */
  let nbIntermediaires = nbIntermediairesReservees(prefixe);
  if (nbIntermediaires > 0) {
    let dejaOccupees = 0;
    for (const e of occupees) {
      if (
        estOctetReserve(e.adresse_ip) &&
        e.adresse_ip !== sousReseau.networkAddress &&
        e.adresse_ip !== sousReseau.broadcastAddress
      ) {
        dejaOccupees++;
      }
    }
    nbIntermediaires = Math.max(0, nbIntermediaires - dejaOccupees);
  }

  if (nbIntermediaires > 0 && nbIntermediaires <= 16) {
    const debut = toLong(sousReseau.firstAddress);
    const fin = toLong(sousReseau.lastAddress);
    for (let n = debut; n <= fin; n++) {
      const a = fromLong(n >>> 0);
      if (estOctetReserve(a) && !prises.has(a)) {
        reservees.push({
          adresse: a,
          role: "diffusion d'un bloc /24 intérieur — non balayée, par choix",
        });
      }
    }
  }

  // ── LES LIBRES ──
  //
  // On ne construit JAMAIS la liste complète : un /16 en compte 65 534, et
  // c'est le genre de tableau qui a déjà fait tomber le serveur entier.
  // On compte par soustraction, et on ne cite que les premières — ce qu'on
  // vient chercher est « quelle adresse puis-je donner », pas la liste.
  const libresTotal = Math.max(0, total - prises.size - nbIntermediaires);
  const exemples = [];
  {
    const debut = toLong(sousReseau.firstAddress);
    const fin = toLong(sousReseau.lastAddress);
    for (let n = debut; n <= fin && exemples.length < EXEMPLES_LIBRES; n++) {
      const a = fromLong(n >>> 0);
      // Ne jamais proposer une adresse que le balayage n'ira pas voir.
      if (!prises.has(a) && !estOctetReserve(a)) exemples.push(a);
    }
  }

  /* Les intervalles sont calculés APRÈS `prises`, qui contient à ce
     stade les occupées, les adresses du serveur et les réservées de
     norme. Le même ensemble sert donc aux deux vues — elles ne peuvent
     pas diverger. */
  const groupes = intervallesLibres(sousReseau, prises, estOctetReserve);

  return {
    cidr,
    prefixe,
    adresse_reseau: sousReseau.networkAddress,
    adresse_diffusion: sousReseau.broadcastAddress,
    premiere_attribuable: sousReseau.firstAddress,
    derniere_attribuable: sousReseau.lastAddress,

    total_attribuables: total,
    nb_occupees: occupees.length,
    nb_reservees: Math.max(0, total - occupees.length - libresTotal),
    nb_libres: libresTotal,
    taux_occupation: total > 0 ? Math.round((occupees.length / total) * 100) : 0,

    occupees,
    reservees,
    libres_exemples: exemples,
    libres_tronquees: libresTotal > exemples.length,

    /* ── LA PLACE DISPONIBLE, TELLE QU'ON LA CHERCHE ──

       `libres_intervalles` répond à « où ai-je de la place, et
       combien ? » ; `libres_exemples` répond à « donne-moi une adresse
       pour cette imprimante ». Deux questions, deux formes, les deux
       calculées sur le même ensemble.

       `null` quand la plage est trop large pour être parcourue : c'est
       une absence de calcul, pas une absence de place, et l'interface
       doit pouvoir faire la différence. */
    libres_intervalles: groupes ? groupes.intervalles : null,
    libres_intervalles_tronques: groupes ? groupes.tronques : 0,
    /* Le plus grand bloc d'un seul tenant. C'est le chiffre qui décide
       si l'on peut encore réserver une zone — un réseau avec 200
       adresses libres éparpillées une par une est PLEIN pour qui veut
       poser dix serveurs consécutifs, et rien dans les trois compteurs
       ne le disait. */
    plus_grand_bloc_libre: groupes
      ? groupes.intervalles.reduce((max, i) => Math.max(max, i.nb), 0)
      : null,

    // La limite, écrite dans la réponse et non reléguée à une note de bas
    // de page : c'est elle qui empêche de lire ce tableau pour ce qu'il
    // n'est pas.
    avertissement:
      "« Libre » signifie qu'aucun équipement découvert ne porte cette adresse. " +
      "Une machine jamais scannée, ou éteinte lors de tous les scans, y est " +
      "invisible. Ce calcul n'envoie aucun paquet sur le réseau.",
  };
}

/**
 * Plan de toutes les plages ACTIVES d'un site.
 * Une plage illisible n'interrompt pas les autres : elle est rendue avec
 * son erreur. Distinguer « cette plage est pleine » de « cette plage n'a
 * pas pu être lue » est tout l'intérêt de la vue.
 */
async function planDuSite(idSite) {
  const [plages] = await db.query(
    "SELECT id_plage, cidr FROM PLAGE_SCAN WHERE id_site = ? AND actif = TRUE ORDER BY cidr",
    [idSite]
  );

  const plans = [];
  for (const p of plages) {
    try {
      plans.push({ id_plage: p.id_plage, ...(await planDUnePlage(idSite, p.cidr)) });
    } catch (err) {
      plans.push({ id_plage: p.id_plage, cidr: p.cidr, erreur: err.message });
    }
  }
  return plans;
}

module.exports = {
  planDUnePlage,
  planDuSite,
  nbAttribuables,
  nbIntermediairesReservees,
  // Exposé pour les tests : logique pure, sans base ni réseau.
  intervallesLibres,
  MAX_INTERVALLES,
};
