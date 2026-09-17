/**
 * progressionScan.js
 * Où en est le scan en cours, pour le site demandé.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI UN REGISTRE EN MÉMOIRE, ET PAS UNE TABLE
 *
 * Cette information ne survit pas au scan : elle n'a d'intérêt que
 * pendant les quelques minutes où il tourne, et personne ne demandera
 * jamais « à combien de pour cent en était le scan de mardi ». L'écrire
 * en base coûterait une écriture par machine analysée — soixante-treize
 * écritures pour un affichage qui disparaît à la fin.
 *
 * Conséquence assumée : si le serveur redémarre pendant un scan, le
 * registre est vide au redémarrage. C'est exact, puisque le scan est mort
 * avec lui.
 *
 * ── LE POURCENTAGE EST CALCULÉ SUR DES COMPTES RÉELS ──
 *
 * Il ne s'agit pas d'une barre qui avance toute seule pour rassurer. Le
 * chiffre vient de `traites / total` remonté par parLots, machine par
 * machine. Une barre qui progresse alors que rien n'avance est pire que
 * pas de barre du tout : elle fait attendre au lieu de faire chercher.
 *
 * ── LES TROIS ÉTAPES N'ONT PAS LE MÊME POIDS, ET C'EST MESURÉ ──
 *
 * Le balayage d'une plage /23 par nmap prend environ 7 secondes pour 512
 * adresses. L'identification des machines vivantes prend des MINUTES :
 * jusqu'à 25 s par machine pour la détection de système, dix en
 * parallèle. Sur un parc réel de 73 machines vivantes, le balayage pèse
 * moins de 5 % du temps total.
 *
 * Donner 50 % au balayage, comme le ferait un découpage naïf en deux
 * étapes égales, produirait une barre qui saute à la moitié en sept
 * secondes puis paraît bloquée pendant trois minutes. Les poids
 * ci-dessous reflètent la durée observée, pas le nombre d'étapes.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Part du travail déjà faite quand une étape COMMENCE. */
const DEBUT_ETAPE = {
  balayage: 0,
  identification: 5,
  enregistrement: 96,
};

/** Part du travail que couvre l'étape. Seule l'identification se compte. */
const AMPLEUR_ETAPE = {
  balayage: 5,
  identification: 91,
  enregistrement: 4,
};

/**
 * Durée pendant laquelle un scan terminé reste consultable.
 *
 * Sans ce délai, l'interface qui interroge toutes les deux secondes
 * pourrait ne jamais voir les 100 % : le scan se termine, le registre
 * s'efface, la réponse suivante dit « aucun scan » et la barre
 * disparaîtrait sans jamais avoir été pleine. Une minute suffit
 * largement — et l'entrée est marquée `actif: false`, l'interface sait
 * donc qu'il s'agit d'un résultat et non d'un travail en cours.
 */
const RETENTION_MS = 60 * 1000;

/** id_site (chaîne) -> état. Un scan à la fois par site. */
const registre = new Map();

function cle(idSite) {
  return String(idSite);
}

/** Retire les entrées terminées depuis plus d'une minute. */
function nettoyer() {
  const maintenant = Date.now();
  for (const [k, e] of registre) {
    if (!e.actif && maintenant - (e.fin || 0) > RETENTION_MS) registre.delete(k);
  }
}

/**
 * Un scan commence sur ce site.
 * @param {number} idSite
 * @param {number} plagesTotal  nombre de plages à parcourir (1 pour un scan de plage)
 */
function demarrer(idSite, plagesTotal = 1) {
  nettoyer();
  registre.set(cle(idSite), {
    actif: true,
    debut: Date.now(),
    fin: null,
    plages_total: Math.max(1, Number(plagesTotal) || 1),
    // -1 : aucune plage n'a encore commencé. La première annonce la
    // portera à 0, ce qui est bien « la première sur n ».
    plage_index: -1,
    cidr: null,
    etape: "preparation",
    courant: 0,
    total: 0,
  });
}

/** Une nouvelle plage commence. */
function plage(idSite, cidr) {
  const e = registre.get(cle(idSite));
  if (!e || !e.actif) return;
  e.plage_index += 1;
  e.cidr = cidr;
  e.etape = "preparation";
  e.courant = 0;
  e.total = 0;
}

/**
 * Avancement à l'intérieur d'une plage.
 * Reçoit exactement ce que `scanRange` émet par son `onProgress`.
 */
function etape(idSite, nom, courant = 0, total = 0) {
  const e = registre.get(cle(idSite));
  if (!e || !e.actif) return;
  e.etape = nom;
  e.courant = Number(courant) || 0;
  e.total = Number(total) || 0;
}

/** Le scan est fini — ou a échoué. */
function terminer(idSite, resume = {}) {
  const e = registre.get(cle(idSite));
  if (!e) return;
  e.actif = false;
  e.fin = Date.now();
  e.etape = "termine";
  Object.assign(e, resume);
}

/**
 * Pourcentage global, plages comprises.
 *
 * Une plage qui n'a pas commencé ne compte pas ; la plage en cours
 * contribue à hauteur de son propre avancement. Le résultat est borné à
 * 99 % tant que le scan tourne : afficher 100 % avant la fin ferait
 * fermer la page une seconde trop tôt.
 */
function pourcentageDe(e) {
  if (!e.actif) return 100;

  const debut = DEBUT_ETAPE[e.etape] ?? 0;
  const ampleur = AMPLEUR_ETAPE[e.etape] ?? 0;

  // Le total vaut zéro pendant le balayage (nmap ne rend rien d'
  // intermédiaire) : l'étape compte alors pour son début seul.
  const dansEtape = e.total > 0 ? Math.min(1, e.courant / e.total) : 0;
  const local = debut + ampleur * dansEtape;

  const faites = Math.max(0, e.plage_index);
  const global = ((faites + local / 100) / e.plages_total) * 100;

  return Math.max(0, Math.min(99, Math.round(global)));
}

/** État public, tel que l'interface le reçoit. */
function etat(idSite) {
  nettoyer();
  const e = registre.get(cle(idSite));
  if (!e) return { actif: false, connu: false };

  return {
    connu: true,
    actif: e.actif,
    pourcentage: pourcentageDe(e),
    etape: e.etape,
    cidr: e.cidr,
    plage: Math.max(1, e.plage_index + 1),
    plages_total: e.plages_total,
    courant: e.courant,
    total: e.total,
    secondes: Math.round(((e.fin || Date.now()) - e.debut) / 1000),
  };
}

module.exports = { demarrer, plage, etape, terminer, etat };
