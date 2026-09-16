/**
 * services/observationDnsService.js
 * Ce qu'une machine cherche à joindre, et ce que ça dit d'elle.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CETTE VUE EXISTE, ET POURQUOI ELLE EST NOTRE AVANTAGE
 *
 * Voir les processus à l'intérieur d'un poste sans qu'un programme y
 * tourne est impossible — pour tout le monde, pas seulement pour nous.
 * Mais la question peut se retourner.
 *
 * Une machine, avant de faire quoi que ce soit sur le réseau, doit
 * demander un nom. Toujours, sans exception. Le résolveur DNS du site —
 * que cette plateforme héberge déjà pour appliquer le blocage web — voit
 * donc passer TOUT ce que chaque machine cherche à joindre.
 *
 * Ce n'est pas la liste des logiciels installés. C'est la liste de ce que
 * la machine FAIT. Pour un travail de sécurité, c'est la plus utile des
 * deux : un logiciel installé et jamais lancé ne présente aucun risque ;
 * un outil de prise de contrôle lancé depuis une clé USB, sans rien
 * installer, en présente un considérable — et lui, on le voit ici.
 *
 * CE QUE L'AGENT NE COUVRIRA JAMAIS. Un agent ne tourne que sur les PC
 * qu'on administre. Le DNS couvre le téléphone du directeur, l'ordinateur
 * du prestataire de passage, l'imprimante, la caméra, la télé de la salle
 * de réunion, et la machine que personne n'a déclarée. Nagios, Zabbix,
 * Centreon et CheckMK ne font rien de tel ; ntopng le fait mais exige un
 * port miroir sur le commutateur ; les pare-feux le font, à condition
 * d'acheter le pare-feu.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEUX FAMILLES DE SIGNAUX, ET ELLES NE SE VALENT PAS
 *
 * RECONNUS — le domaine figure dans une liste. Fiable, explicable, mais
 * limité à ce que la liste contient. Un domaine absent est INCONNU, pas
 * suspect : traiter l'inconnu comme du danger produirait des centaines de
 * fausses alertes le premier jour, et plus personne ne lirait l'écran.
 *
 * DÉDUITS — la FORME du nom trahit son usage, sans qu'aucune liste soit
 * nécessaire. Un logiciel malveillant qui fabrique ses noms de domaine
 * au hasard produit des chaînes qu'aucun humain n'écrirait. Une fuite de
 * données déguisée en requêtes DNS produit des sous-noms très longs et
 * très nombreux sous un même domaine.
 *
 * Les seconds sont plus puissants — ils attrapent ce qu'aucune liste ne
 * connaît — et bien plus dangereux : ils se trompent. D'où la règle qui
 * gouverne ce fichier : un signal déduit dit toujours POURQUOI il s'est
 * déclenché, et il est formulé comme une question, jamais comme un
 * verdict.
 */
const fs = require("node:fs");
const path = require("node:path");

const FICHIER = path.join(__dirname, "..", "..", "donnees", "domaines-connus.json");

let table = null;

function charger() {
  if (table) return table;
  try {
    const brut = JSON.parse(fs.readFileSync(FICHIER, "utf8"));
    const parDomaine = new Map();
    for (const [cle, cat] of Object.entries(brut.categories || {})) {
      for (const d of cat.domaines || []) {
        parDomaine.set(d.toLowerCase(), {
          categorie: cle,
          libelle: cat.libelle,
          gravite: cat.gravite || "information",
        });
      }
    }
    table = {
      parDomaine,
      infrastructure: new Set((brut.infrastructure || []).map((d) => d.toLowerCase())),
      suffixesComposes: new Set((brut.suffixes_composes || []).map((d) => d.toLowerCase())),
    };
  } catch (err) {
    console.error(
      `Table des domaines illisible (${FICHIER}) : ${err.message}\n` +
        "  Les observations DNS restent enregistrées, mais sans catégorie — " +
        "aucune conclusion ne sera tirée d'une donnée absente."
    );
    table = { parDomaine: new Map(), infrastructure: new Set(), suffixesComposes: new Set() };
  }
  return table;
}

/** Minuscules, sans point final, sans espaces. */
function normaliser(nom) {
  return String(nom || "").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Le domaine ENREGISTRABLE : « files.eu.dropbox.com » → « dropbox.com ».
 *
 * C'est le seul niveau qu'on conserve, et c'est un choix de VIE PRIVÉE
 * autant que de technique. Le nom complet est souvent parlant —
 * « dossiers-medicaux.clinique.cm » en dit long sur qui consulte quoi.
 * Le domaine enregistrable suffit à répondre aux questions qu'on pose à
 * un outil de supervision, et il borne la table par la même occasion.
 */
function domaineEnregistrable(nom) {
  const propre = normaliser(nom);
  if (!propre || !propre.includes(".")) return propre || null;

  const parties = propre.split(".");
  if (parties.length <= 2) return propre;

  const deuxDerniers = parties.slice(-2).join(".");
  if (charger().suffixesComposes.has(deuxDerniers) && parties.length >= 3) {
    return parties.slice(-3).join(".");
  }
  return deuxDerniers;
}

/**
 * Entropie de Shannon, en bits par caractère.
 * Un mot écrit par un humain tourne autour de 3 ; une chaîne tirée au
 * hasard dépasse 4. C'est la mesure qui distingue « boutique » de
 * « x7f3q9zk2m ».
 */
function entropie(texte) {
  const s = String(texte || "");
  if (s.length === 0) return 0;
  const comptes = new Map();
  for (const c of s) comptes.set(c, (comptes.get(c) || 0) + 1);
  let h = 0;
  for (const n of comptes.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Part de voyelles. Un nom prononçable en contient ; une chaîne au hasard, peu. */
function partVoyelles(texte) {
  const lettres = String(texte || "").replace(/[^a-z]/g, "");
  if (lettres.length === 0) return 0;
  return (lettres.match(/[aeiouy]/g) || []).length / lettres.length;
}

/** Le domaine appartient-il à une infrastructure aux noms aléatoires par nature ? */
function estInfrastructure(nom) {
  const enregistrable = domaineEnregistrable(nom);
  return enregistrable ? charger().infrastructure.has(enregistrable) : false;
}

/**
 * Seuils de la détection de noms improbables.
 * Volontairement stricts : un faux positif coûte plus cher qu'un manque,
 * parce qu'il apprend à ignorer l'écran.
 */
const LONGUEUR_MINIMALE = 10;
const ENTROPIE_SUSPECTE = 3.6;
const VOYELLES_MINIMALES = 0.18;

/**
 * Le premier niveau du nom ressemble-t-il à une chaîne fabriquée ?
 * @returns {null|{code:string, gravite:string, texte:string}}
 */
function nomImprobable(nom) {
  const propre = normaliser(nom);
  if (!propre) return null;

  // Une infrastructure de diffusion fabrique ses noms au hasard : c'est
  // son fonctionnement normal. Sans cette exclusion, la détection
  // désignerait d'abord Amazon, Microsoft et Google — donc serait
  // ignorée dès la première lecture, et les vrais signaux avec elle.
  if (estInfrastructure(propre)) return null;

  const premier = propre.split(".")[0];
  if (premier.length < LONGUEUR_MINIMALE) return null;

  const h = entropie(premier);
  const v = partVoyelles(premier);
  if (h < ENTROPIE_SUSPECTE || v > VOYELLES_MINIMALES) return null;

  return {
    code: "nom_improbable",
    gravite: "avertissement",
    // Formulé comme une question. Ce signal SE TROMPE parfois — un nom de
    // machine, une clé technique, un identifiant de session peuvent lui
    // ressembler. Il sert à orienter un regard, pas à conclure.
    texte:
      `« ${premier} » ne ressemble pas à un nom choisi par quelqu'un ` +
      `(entropie ${h.toFixed(1)}, ${Math.round(v * 100)} % de voyelles). ` +
      "Les logiciels malveillants fabriquent leurs noms ainsi pour joindre " +
      "leur serveur — à vérifier, ce n'est pas une preuve.",
  };
}

/** Au-delà, un empilement de sous-noms n'a plus d'usage légitime courant. */
const SOUS_NIVEAUX_SUSPECTS = 5;
const LONGUEUR_TOTALE_SUSPECTE = 100;

/**
 * Le nom ressemble-t-il à un transport de données déguisé ?
 *
 * Une fuite par DNS encode les données dans le nom demandé :
 * « MFRGG2LOOM.QWE3TY.7ZQ.tunnel.exemple.com ». Chaque requête emporte
 * quelques octets, et le pare-feu laisse passer — c'est du DNS.
 *
 * C'est une des rares exfiltrations qu'un outil réseau puisse voir sans
 * déchiffrer quoi que ce soit, et aucune plateforme de supervision
 * classique ne la cherche.
 */
function transportDeDonnees(nom) {
  const propre = normaliser(nom);
  if (!propre || estInfrastructure(propre)) return null;

  const niveaux = propre.split(".").length;
  if (niveaux < SOUS_NIVEAUX_SUSPECTS && propre.length < LONGUEUR_TOTALE_SUSPECTE) return null;

  const premier = propre.split(".")[0];
  if (premier.length < 20 || entropie(premier) < ENTROPIE_SUSPECTE) return null;

  return {
    code: "transport_dns",
    gravite: "critique",
    texte:
      `Nom de ${propre.length} caractères sur ${niveaux} niveaux, au contenu ` +
      "aléatoire. Cette forme est celle d'un transfert de données caché dans " +
      "des requêtes DNS — le pare-feu ne l'arrête pas, puisque c'est du DNS. " +
      "À examiner en priorité.",
  };
}

/**
 * Cherche la catégorie du nom le plus PRÉCIS vers le plus général.
 *
 * DÉFAUT TROUVÉ À L'ESSAI, avant toute mise en service. La recherche se
 * faisait sur le seul domaine enregistrable : « teams.microsoft.com »
 * était réduit à « microsoft.com » AVANT d'être cherché, si bien que
 * toute entrée de la liste comportant plus de deux niveaux ne pouvait
 * JAMAIS correspondre. Elles étaient là, lisibles, et sans effet.
 *
 * Le défaut se serait vu comment ? Il ne se serait pas vu : la liste
 * aurait paru fonctionner, portée par ses entrées à deux niveaux, et
 * personne n'aurait su que la moitié du fichier était morte.
 *
 * On essaie donc le nom entier, puis on retire un niveau à la fois. La
 * première correspondance gagne : une entrée précise l'emporte sur une
 * entrée générale, ce qui est le comportement attendu de n'importe
 * quelle liste de ce genre.
 */
function chercherCategorie(nom) {
  const propre = normaliser(nom);
  if (!propre) return null;

  const table = charger();
  const parties = propre.split(".");
  const domaine = domaineEnregistrable(propre);
  const niveauxDuDomaine = domaine ? domaine.split(".").length : 2;

  for (let i = 0; i <= parties.length - niveauxDuDomaine; i++) {
    const candidat = parties.slice(i).join(".");
    const trouve = table.parDomaine.get(candidat);
    if (trouve) return trouve;
  }
  return null;
}

/**
 * Tout ce qu'on peut dire d'un nom demandé.
 * Fonction PURE : aucun réseau, aucune base. C'est elle qui est testée.
 *
 * @param {string} nom  le nom demandé, tel que le résolveur l'a reçu
 * @returns {{domaine:string|null, categorie:string|null, libelle:string|null,
 *            gravite:string, signaux:Array}}
 */
function analyserNom(nom) {
  const propre = normaliser(nom);
  const domaine = domaineEnregistrable(propre);
  const connu = chercherCategorie(propre);

  const signaux = [];
  if (connu && connu.gravite !== "information") {
    signaux.push({
      code: connu.categorie,
      gravite: connu.gravite === "critique" ? "critique" : "avertissement",
      texte: connu.libelle,
    });
  }

  // L'ordre compte : le transport de données est plus grave et plus
  // spécifique qu'un simple nom improbable. Les deux se déclencheraient
  // sur la même chaîne ; n'en garder qu'un évite d'afficher deux fois le
  // même fait avec deux gravités différentes.
  const transport = transportDeDonnees(propre);
  if (transport) {
    signaux.push(transport);
  } else {
    const improbable = nomImprobable(propre);
    if (improbable) signaux.push(improbable);
  }

  const gravites = ["information", "avertissement", "critique"];
  const gravite = signaux.reduce(
    (max, s) => (gravites.indexOf(s.gravite) > gravites.indexOf(max) ? s.gravite : max),
    "information"
  );

  return {
    domaine,
    categorie: connu ? connu.categorie : null,
    libelle: connu ? connu.libelle : null,
    gravite,
    signaux,
  };
}

/**
 * Une ligne de journal dnsmasq → qui a demandé quoi.
 *
 * Format réel :
 *   Sep 14 10:15:32 hote dnsmasq[1234]: query[A] teams.microsoft.com from 192.168.0.42
 *
 * On ne retient QUE le couple (adresse du poste, nom demandé). L'heure
 * exacte est écartée volontairement : c'est elle qui transforme un
 * relevé d'usage en emploi du temps de la personne.
 */
function lireLigneJournal(ligne) {
  const m = String(ligne || "").match(/query\[[A-Za-z0-9]+\]\s+(\S+)\s+from\s+(\S+)/);
  if (!m) return null;
  const nom = normaliser(m[1]);
  const ip = String(m[2]).trim();
  if (!nom || !ip) return null;
  // Les recherches inverses interrogent le DNS sur une ADRESSE, pas sur
  // un service : elles n'apprennent rien sur ce que fait la machine et
  // noieraient le relevé.
  if (nom.endsWith(".in-addr.arpa") || nom.endsWith(".ip6.arpa")) return null;
  return { ip, nom };
}

/**
 * Résume un journal en un relevé par poste — L'ÉTAPE QUI PROTÈGE.
 *
 * Elle tourne SUR L'AGENT, avant tout envoi. Ce qui part vers la
 * plateforme n'est donc pas « à 14 h 03, ce poste a demandé
 * dossiers-medicaux.clinique.cm » mais « ce poste a contacté
 * clinique.cm, 12 fois ». Le journal complet ne quitte jamais la machine
 * où il a été produit, et la plateforme n'a jamais eu de quoi
 * reconstituer une navigation.
 *
 * Trois réductions, dans cet ordre :
 *   1. l'heure de chaque requête est jetée ;
 *   2. le nom est ramené à son domaine enregistrable ;
 *   3. les requêtes identiques deviennent un compteur.
 *
 * @param {string} texte  le journal brut
 * @returns {Array<{ip:string, domaines:Array<{domaine:string, n:number}>}>}
 */
function agregerRequetes(texte) {
  const parPoste = new Map();

  for (const ligne of String(texte || "").split(/\r?\n/)) {
    const lu = lireLigneJournal(ligne);
    if (!lu) continue;

    const domaine = domaineEnregistrable(lu.nom);
    if (!domaine) continue;

    if (!parPoste.has(lu.ip)) parPoste.set(lu.ip, new Map());
    const compteurs = parPoste.get(lu.ip);
    compteurs.set(domaine, (compteurs.get(domaine) || 0) + 1);
  }

  return [...parPoste.entries()].map(([ip, compteurs]) => ({
    ip,
    domaines: [...compteurs.entries()]
      .map(([domaine, n]) => ({ domaine, n }))
      // Les plus demandés d'abord : si un envoi doit être tronqué, ce
      // sont les domaines marginaux qu'on perd, pas l'essentiel.
      .sort((a, b) => b.n - a.n),
  }));
}

module.exports = {
  agregerRequetes,
  lireLigneJournal,
  analyserNom,
  chercherCategorie,
  domaineEnregistrable,
  normaliser,
  entropie,
  partVoyelles,
  estInfrastructure,
  nomImprobable,
  transportDeDonnees,
  LONGUEUR_MINIMALE,
  ENTROPIE_SUSPECTE,
};
