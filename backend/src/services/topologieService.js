/**
 * services/topologieService.js
 * La carte du réseau, construite à partir de ce que les postes savent
 * d'eux-mêmes — sans que personne ne la dessine.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI CE SERVICE EXISTE
 *
 * Dans les outils du marché, une carte réseau est un DESSIN : on place
 * les icônes, on tire les traits, on associe à chaque trait le
 * déclencheur qui le fera changer de couleur. Rien n'est découvert ; les
 * positions sont des coordonnées enregistrées en base.
 *
 * Ici, personne ne dessine. Le graphe est reconstruit à chaque appel à
 * partir des relevés des agents de poste.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * QUATRE NIVEAUX DE PREUVE, ET ILS NE SE VALENT PAS
 *
 *   interface  — ce poste PORTE une adresse de ce segment. Mesuré.
 *   passerelle — ce poste DÉCLARE cette adresse comme sa sortie. Mesuré.
 *   sans_fil   — ce poste est ASSOCIÉ à cette borne. Mesuré, et c'est le
 *                seul lien physique qu'un poste connaisse de lui-même.
 *   voisinage  — cette adresse a été JOINTE depuis ce segment. Certaine
 *                si l'entrée est « Reachable », déduite si elle est
 *                « Stale » : vue un jour, plus revérifiée depuis.
 *
 * Chaque lien porte son niveau. L'écran les dessinera différemment —
 * un trait plein, un trait pointillé — plutôt que de laisser croire que
 * tout se vaut.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CE QUE CETTE CARTE N'AFFIRMERA JAMAIS
 *
 * Le câble. Sans commutateur administrable interrogeable en SNMP, le
 * numéro de port physique est inconnu : on sait sur quel SEGMENT se
 * trouve une machine, pas au bout de quel cordon. Un commutateur non
 * administrable n'apparaît pas du tout, et les machines derrière lui
 * semblent raccordées à l'équipement supérieur.
 *
 * C'est pourquoi `couverture` est rendue avec le graphe, et non en
 * option : une carte qui ne dit pas ce qu'elle ignore ment par omission.
 */

const db = require("../db");
const { cidrSubnet } = require("./adressesIp");

/* ═══════════════════════════════════════════════════════════════════════
   LES ADRESSES QUI NE MÈNENT NULLE PART

   Définies par l'IANA, pas par un nom de produit : la boucle locale
   (RFC 1122) et les adresses auto-attribuées quand aucun DHCP n'a
   répondu (RFC 3927).

   Écrire « VirtualBox » ou « VMware » dans cette liste aurait marché
   aujourd'hui et cassé au premier poste équipé d'autre chose. Le poste
   de développement en porte quatre sortes à lui seul.
   ═══════════════════════════════════════════════════════════════════════ */
const RESEAUX_SANS_PORTEE = ["127.0.0.0/8", "169.254.0.0/16"];

function adresseUtile(ip) {
  if (!ip) return false;
  const texte = String(ip);
  for (const reseau of RESEAUX_SANS_PORTEE) {
    try {
      if (cidrSubnet(reseau).contains(texte)) return false;
    } catch {
      /* Une plage illisible ne disqualifie personne. */
    }
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   UNE CARTE RÉSEAU MÈNE-T-ELLE QUELQUE PART ?

   La règle vit ICI, et nulle part ailleurs. Le graphe s'en sert pour
   écarter, le diagnostic s'en sert pour EXPLIQUER — « 8 interfaces
   écartées » sans dire laquelle ni pourquoi est le genre de chiffre qui
   fait douter de tout le reste.

   L'ordre des contrôles n'est pas indifférent : on écarte d'abord sur
   l'adresse, sinon la boucle locale serait rangée dans « nature
   inconnue » alors que la vraie raison est ailleurs. Une explication
   fausse est pire qu'une explication absente.

   Et « carte virtuelle » (materielle = 0) est distingué de « nature
   inconnue » (materielle = null) : le premier est une mesure, le second
   un aveu. Les confondre reviendrait à affirmer ce qu'on ignore.
   ═══════════════════════════════════════════════════════════════════════ */
function jugerInterface(carte, nbVoisins = 0) {
  const masque = Number(carte?.masque);

  if (!adresseUtile(carte?.adresse_ip)) {
    return { retenue: false, raison: "adresse sans portée (boucle locale ou auto-attribuée)" };
  }
  if (!Number.isInteger(masque) || masque <= 0 || masque > 32) {
    return { retenue: false, raison: "masque absent ou illisible" };
  }
  if (carte?.materielle === 0 || carte?.materielle === false) {
    return { retenue: false, raison: "carte virtuelle" };
  }
  if (carte?.materielle !== 1 && carte?.materielle !== true) {
    return { retenue: false, raison: "nature de la carte inconnue" };
  }
  if (!carte?.passerelle && nbVoisins === 0) {
    return { retenue: false, raison: "ni passerelle ni voisin : ne mène nulle part" };
  }
  return { retenue: true, raison: null };
}

/* ═══════════════════════════════════════════════════════════════════════
   LA CONSTRUCTION DU GRAPHE — FONCTION PURE

   Aucune base de données ici : des tableaux entrent, un graphe sort.
   C'est délibéré. La règle qui décide si une carte réseau mène quelque
   part est le cœur de ce module ; elle doit pouvoir être éprouvée sur
   des cas tordus sans serveur MySQL allumé.
   ═══════════════════════════════════════════════════════════════════════ */
function construireGraphe({
  interfaces = [],
  voisins = [],
  sansFil = [],
  equipements = [],
} = {}) {
  const equipementParId = new Map();
  const equipementParIp = new Map();
  for (const e of equipements) {
    if (!e) continue;
    equipementParId.set(Number(e.id_equipement), e);
    if (e.adresse_ip) equipementParIp.set(String(e.adresse_ip), e);
  }

  /* Les voisins rangés par carte : une interface qui n'a ni passerelle
     ni voisin ne mène nulle part, et c'est la seule preuve qu'on en a. */
  const voisinsParCarte = new Map();
  for (const v of voisins) {
    if (!v) continue;
    const cle = `${v.id_equipement}:${v.index_carte}`;
    const liste = voisinsParCarte.get(cle) || [];
    liste.push(v);
    voisinsParCarte.set(cle, liste);
  }

  /* ── QUELLES INTERFACES RETENIR ──
     Trois conditions, toutes mesurées :
       1. l'adresse porte quelque part (ni boucle locale, ni auto-attribuée) ;
       2. la carte est MATÉRIELLE — `materielle === null` ne suffit pas :
          « je n'ai pas pu savoir » n'est pas « oui » ;
       3. elle mène quelque part : une passerelle, ou au moins un voisin.
     La troisième rattrape le cas d'un VLAN d'administration sans
     passerelle, qui est un vrai segment malgré tout. */
  const retenues = [];
  let ecartees = 0;
  for (const i of interfaces) {
    const voisinage = voisinsParCarte.get(`${i?.id_equipement}:${i?.index_carte}`) || [];
    if (jugerInterface(i, voisinage.length).retenue) retenues.push(i);
    else ecartees += 1;
  }

  const noeuds = new Map();
  const liens = new Map();

  function noeud(id, valeur) {
    if (!noeuds.has(id)) noeuds.set(id, { id, ...valeur });
    return id;
  }

  function lien(de, vers, preuve, niveau, detail) {
    const cle = `${de}|${vers}|${preuve}`;
    const existant = liens.get(cle);
    /* « certain » l'emporte sur « déduit » : deux postes qui voient le
       même voisin, l'un à l'instant et l'autre de mémoire, ne doivent
       pas faire perdre la meilleure des deux preuves. */
    if (existant && !(existant.niveau === "deduit" && niveau === "certain")) return;
    liens.set(cle, { de, vers, preuve, niveau, detail: detail || null });
  }

  function noeudEquipement(id) {
    const e = equipementParId.get(Number(id));
    return noeud(`equipement:${Number(id)}`, {
      type: "equipement",
      libelle: (e && (e.nom || e.adresse_ip)) || `équipement ${id}`,
      adresse_ip: e ? e.adresse_ip : null,
      id_equipement: Number(id),
    });
  }

  /* Une adresse vue sur le fil est soit un équipement de l'inventaire,
     soit une adresse que personne n'a jamais inventoriée. Le second cas
     n'est pas une erreur à masquer : c'est exactement ce qu'un
     responsable informatique veut voir. */
  function noeudPourAdresse(ip) {
    const connu = equipementParIp.get(String(ip));
    if (connu) return noeudEquipement(connu.id_equipement);
    return noeud(`adresse:${ip}`, {
      type: "inconnu",
      libelle: String(ip),
      adresse_ip: String(ip),
      id_equipement: null,
    });
  }

  const segments = [];
  for (const i of retenues) {
    let sous;
    try {
      sous = cidrSubnet(`${i.adresse_ip}/${i.masque}`);
    } catch {
      ecartees += 1;
      continue;
    }
    const cle = `${sous.networkAddress}/${i.masque}`;
    const idSegment = noeud(`segment:${cle}`, { type: "segment", libelle: cle });
    segments.push({ cle, idSegment, sous, carte: i });

    const idMachine = noeudEquipement(i.id_equipement);
    lien(idMachine, idSegment, "interface", "certain", i.nom || null);

    if (i.passerelle && adresseUtile(i.passerelle)) {
      const idPasserelle = noeudPourAdresse(i.passerelle);
      lien(idPasserelle, idSegment, "passerelle", "certain", "passerelle par défaut");
      lien(idMachine, idPasserelle, "passerelle", "certain", i.nom || null);
    }
  }

  /* ── LE VOISINAGE RATTACHE CE QUI N'A PAS D'AGENT ──
     C'est le vrai rendement de la méthode : un seul poste équipé révèle
     l'appartenance au segment de toutes les adresses qu'il a jointes.
     On ne retient que celles qui tombent DANS le segment de la carte
     concernée : une entrée venue d'une autre carte ne prouve rien ici. */
  for (const s of segments) {
    const liste = voisinsParCarte.get(`${s.carte.id_equipement}:${s.carte.index_carte}`) || [];
    for (const v of liste) {
      if (!adresseUtile(v.adresse_ip)) continue;
      if (!s.sous.contains(String(v.adresse_ip))) continue;
      const joignable = v.etat === "Reachable";
      lien(
        noeudPourAdresse(v.adresse_ip),
        s.idSegment,
        "voisinage",
        joignable ? "certain" : "deduit",
        joignable ? "joint à l'instant" : "vu, non revérifié depuis"
      );
    }
  }

  for (const w of sansFil) {
    if (!w || !w.bssid) continue;
    const idBorne = noeud(`borne:${w.bssid}`, {
      type: "borne",
      libelle: w.ssid || "borne sans fil",
      bssid: w.bssid,
    });
    lien(noeudEquipement(w.id_equipement), idBorne, "sans_fil", "certain", w.ssid || null);
  }

  const valeurs = [...noeuds.values()];
  const compter = (type) => valeurs.filter((n) => n.type === type).length;

  return {
    noeuds: valeurs,
    liens: [...liens.values()],
    couverture: {
      postes_ayant_repondu: new Set(retenues.map((i) => Number(i.id_equipement))).size,
      interfaces_retenues: retenues.length,
      interfaces_ecartees: ecartees,
      segments: compter("segment"),
      equipements_rattaches: compter("equipement"),
      adresses_inconnues: compter("inconnu"),
      bornes: compter("borne"),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   L'ENREGISTREMENT D'UN RELEVÉ

   `null` et `[]` ne veulent pas dire la même chose, et la différence
   compte : `[]` signifie « collecté, rien trouvé » et remplace l'ancien
   relevé ; `null` signifie « la collecte a échoué » et laisse en place ce
   qu'on savait. Les confondre effacerait la carte d'un poste sur un
   simple Windows trop ancien.
   ═══════════════════════════════════════════════════════════════════════ */
function texte(valeur, taille) {
  if (valeur === null || valeur === undefined || valeur === "") return null;
  return String(valeur).slice(0, taille);
}

function entier(valeur) {
  const n = Number(valeur);
  return Number.isInteger(n) ? n : null;
}

/* `Number(null)` vaut 0 et `Boolean(0)` vaut false : passer par un
   ternaire explicite est le seul moyen de garder les trois états. */
function booleen(valeur) {
  if (valeur === true || valeur === 1) return 1;
  if (valeur === false || valeur === 0) return 0;
  return null;
}

async function inserer(table, colonnes, lignes) {
  if (lignes.length === 0) return 0;
  const marques = `(${colonnes.map(() => "?").join(", ")})`;
  await db.query(
    `INSERT INTO ${table} (${colonnes.join(", ")})
     VALUES ${lignes.map(() => marques).join(", ")}`,
    lignes.flat()
  );
  return lignes.length;
}

async function enregistrerTopologiePoste(idEquipement, topologie) {
  if (!topologie || typeof topologie !== "object") return { ecrit: false };

  const bilan = { interfaces: 0, voisins: 0, sansFil: false };

  if (Array.isArray(topologie.interfaces)) {
    await db.query("DELETE FROM POSTE_INTERFACE WHERE id_equipement = ?", [idEquipement]);
    const vues = new Set();
    const lignes = [];
    for (const i of topologie.interfaces) {
      if (!i || !i.adresse_ip) continue;
      const index = entier(i.index) ?? 0;
      const cle = `${index}:${i.adresse_ip}`;
      if (vues.has(cle)) continue; /* la clé primaire refuserait le doublon */
      vues.add(cle);
      lignes.push([
        idEquipement, index, texte(i.nom, 128), texte(i.adresse_ip, 45), entier(i.masque),
        texte(i.passerelle, 45), texte(i.adresse_mac, 23), texte(i.media, 48),
        booleen(i.materielle), texte(i.etat, 24),
      ]);
    }
    bilan.interfaces = await inserer(
      "POSTE_INTERFACE",
      ["id_equipement", "index_carte", "nom", "adresse_ip", "masque",
       "passerelle", "adresse_mac", "media", "materielle", "etat"],
      lignes
    );
  }

  if (Array.isArray(topologie.voisins)) {
    await db.query("DELETE FROM POSTE_VOISIN WHERE id_equipement = ?", [idEquipement]);
    const vues = new Set();
    const lignes = [];
    for (const v of topologie.voisins) {
      if (!v || !v.adresse_ip) continue;
      const index = entier(v.index) ?? 0;
      const cle = `${index}:${v.adresse_ip}`;
      if (vues.has(cle)) continue;
      vues.add(cle);
      lignes.push([
        idEquipement, index, texte(v.adresse_ip, 45),
        texte(v.adresse_mac, 23), texte(v.etat, 24),
      ]);
    }
    bilan.voisins = await inserer(
      "POSTE_VOISIN",
      ["id_equipement", "index_carte", "adresse_ip", "adresse_mac", "etat"],
      lignes
    );
  }

  /* `wifi: null` veut dire « aucune association » — une information, pas
     une absence de collecte : la ligne précédente doit disparaître. */
  if (topologie.wifi !== undefined) {
    await db.query("DELETE FROM POSTE_SANS_FIL WHERE id_equipement = ?", [idEquipement]);
    if (topologie.wifi && topologie.wifi.bssid) {
      await db.query(
        `INSERT INTO POSTE_SANS_FIL (id_equipement, bssid, ssid) VALUES (?, ?, ?)`,
        [idEquipement, texte(topologie.wifi.bssid, 23), texte(topologie.wifi.ssid, 64)]
      );
      bilan.sansFil = true;
    }
  }

  return { ecrit: true, ...bilan };
}

/* ═══════════════════════════════════════════════════════════════════════
   LA LECTURE

   `portee` est le filtre de site habituel ({ clause, params }) : la carte
   d'un site ne doit jamais laisser voir les machines d'un autre.
   ═══════════════════════════════════════════════════════════════════════ */
async function lireTopologie(portee) {
  const où = portee && portee.clause ? portee.clause : "1=1";
  const params = (portee && portee.params) || [];

  const [interfaces] = await db.query(
    `SELECT i.* FROM POSTE_INTERFACE i
       JOIN EQUIPEMENT e ON e.id_equipement = i.id_equipement
      WHERE ${où}`,
    params
  );
  const [voisins] = await db.query(
    `SELECT v.* FROM POSTE_VOISIN v
       JOIN EQUIPEMENT e ON e.id_equipement = v.id_equipement
      WHERE ${où}`,
    params
  );
  const [sansFil] = await db.query(
    `SELECT w.* FROM POSTE_SANS_FIL w
       JOIN EQUIPEMENT e ON e.id_equipement = w.id_equipement
      WHERE ${où}`,
    params
  );
  const [equipements] = await db.query(
        `SELECT e.id_equipement, e.nom, e.adresse_ip
       FROM EQUIPEMENT e
      WHERE ${où}`,
    params
  );

  return construireGraphe({ interfaces, voisins, sansFil, equipements });
}

module.exports = {
  construireGraphe,
  jugerInterface,
  enregistrerTopologiePoste,
  lireTopologie,
  adresseUtile,
  RESEAUX_SANS_PORTEE,
};
