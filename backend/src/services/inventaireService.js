/**
 * services/inventaireService.js
 * L'inventaire ne contient que des ÉQUIPEMENTS. Jamais des adresses.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER EXISTE
 *
 * Une adresse IP n'est pas un équipement. C'est une case dans un plan
 * d'adressage : la plupart sont vides. Le balayage complétait le ping par
 * la lecture de `arp -a`, le CACHE ARP du système — un souvenir des
 * machines vues il y a quelques minutes, pas une observation. Un portable
 * parti à midi y figure encore à midi cinq, et se retrouvait inscrit à
 * l'inventaire comme un équipement à part entière.
 *
 * Le scan ne les inscrit plus. Mais empêcher l'arrivée de nouvelles
 * lignes ne suffisait pas : celles des scans précédents restaient, et il
 * fallait lancer un outil en ligne de commande pour les retirer. Un
 * produit qui demande une commande de nettoyage récurrente n'est pas
 * terminé — il fait porter à l'exploitant une règle que le logiciel
 * connaît parfaitement.
 *
 * D'où ce module : la règle « une adresse sans preuve n'est pas un
 * équipement » devient une PROPRIÉTÉ PERMANENTE de l'inventaire, tenue
 * par le produit lui-même, à chaque scan et à chaque cycle de
 * supervision. Aucune commande à lancer, jamais.
 *
 * C'est ce que font les autres : Zabbix ne crée un hôte que lorsqu'un
 * contrôle aboutit et le retire quand la règle de découverte cesse de le
 * voir ; nmap n'affiche que les hôtes qui ont répondu. Aucun des deux ne
 * laisse une ligne sans réponse derrière lui.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LE CRITÈRE — SIX CONDITIONS, TOUTES REQUISES
 *
 * Est écartée une ligne qui, depuis sa découverte, n'a JAMAIS :
 *   1. produit un relevé          (jamais répondu à un ping) ;
 *   2. exposé un seul port TCP    (aucun service détecté) ;
 *   3. répondu en SNMP            (sys_descr vide) ;
 *   4. livré une empreinte nmap   (os_detecte vide) ;
 *   5. fourni de preuve d'existence au scan (preuve_existence vide) ;
 * et qui, en plus :
 *   6. n'a pas été nommée à la main par l'exploitant, n'est pas « up »,
 *      et a plus de deux minutes d'ancienneté.
 *
 * Six absences sur six. Un poste Windows qui bloque le ping mais expose
 * le port 445 n'est PAS concerné et n'est jamais touché. Une machine
 * qu'un opérateur a renommée non plus : un nom saisi à la main est une
 * affirmation humaine, elle prime sur toute déduction automatique.
 *
 * Les deux minutes d'ancienneté évitent la seule course possible : le
 * scan écrit l'équipement, puis ses ports détectés une fraction de
 * seconde plus tard. Une purge tombant entre les deux verrait une ligne
 * sans service qui, elle, en avait un.
 *
 * ─────────────────────────────────────────────────────────────────────
 * LE FREIN — ON NE VIDE PAS UN INVENTAIRE
 *
 * Si le critère désignait la quasi-totalité d'un site, la cause ne
 * serait pas quatre-vingts fantômes : ce serait une panne de la
 * supervision, ou une table de relevés vidée. Le produit refuse alors de
 * supprimer et le DIT. Effacer un parc entier sur une règle automatique
 * serait une faute bien plus grave que la ligne qu'on corrige.
 *
 * RIEN N'EST PERDU. Une machine réellement présente mais totalement
 * muette réapparaît au prochain scan dès qu'elle répond à quoi que ce
 * soit — un ping, un port, un paquet SNMP.
 */
const db = require("../db");
const { tracer } = require("./journal");
const { diffuser } = require("./tempsReelService");

/** Part du parc d'un site au-delà de laquelle on refuse de purger. */
const PART_MAXIMALE = 0.9;
/** Nombre d'équipements en dessous duquel le frein ne s'applique pas. */
const PARC_SIGNIFICATIF = 5;

let colonnePreuveSignalee = false;

function colonneManquante(err) {
  return err && (err.code === "ER_BAD_FIELD_ERROR" || /Unknown column/i.test(err.message || ""));
}

/**
 * Les cinq absences, plus les garde-fous. Le fragment est bâti en deux
 * versions : avec `preuve_existence` quand la colonne existe, sans elle
 * quand la migration n'est pas encore passée. Une migration en retard ne
 * doit jamais faire tomber la supervision — c'est déjà arrivé sur ce
 * projet et cela a coûté 113 équipements sans relevés pendant des jours.
 */
function critere(avecColonnesRecentes) {
  return `
    NOT EXISTS (SELECT 1 FROM RELEVE r WHERE r.id_equipement = e.id_equipement)
    AND NOT EXISTS (SELECT 1 FROM SERVICE_DETECTE s WHERE s.id_equipement = e.id_equipement)
    AND e.sys_descr IS NULL
    AND e.os_detecte IS NULL
    ${avecColonnesRecentes ? "AND e.preuve_existence IS NULL" : ""}
    /* ── UNE MACHINE QUI A UN AGENT N'EST JAMAIS UNE ADRESSE VIDE ──

       Défaut trouvé à l'audit du 10 septembre, avant qu'il ne se
       produise. Le scénario tenait en trois temps :

         1. un ancien scan inscrit un poste, sans preuve enregistrée
            (les preuves datent du 9 septembre) ;
         2. l'agent de poste y est installé et transmet son inventaire —
            deux cents logiciels, la machine passe « up » ;
         3. le poste est éteint quelques jours. La supervision le voit
            muet, sans aucun relevé à son actif, et le marque « inconnu ».

       Le nettoyage suivant le prenait alors pour une adresse fantôme et
       l'effaçait — EN EMPORTANT SON INVENTAIRE, par cascade. Un poste
       éteint aurait perdu ce que seul un agent installé dessus pouvait
       savoir, et personne n'aurait pu dire pourquoi.

       Un agent qui a parlé est la preuve d'existence la plus forte dont
       dispose la plateforme : il a fallu qu'une machine réelle, allumée,
       exécute du code. Elle sort donc du critère par deux chemins
       indépendants — la preuve posée à la réception, et cette ligne. */
    ${avecColonnesRecentes ? "AND e.dernier_inventaire_poste IS NULL" : ""}
    AND e.nom_personnalise IS NULL
    AND e.statut <> 'up'
    AND e.date_ajout < NOW() - INTERVAL 2 MINUTE`;
}

async function chercher(idSite, avecPreuve) {
  const conditions = critere(avecPreuve);
  const params = [];
  let portee = "";
  if (idSite != null) {
    portee = "AND e.id_site = ?";
    params.push(idSite);
  }
  const [lignes] = await db.query(
    `SELECT e.id_equipement, e.id_site, e.adresse_ip
     FROM EQUIPEMENT e
     WHERE ${conditions} ${portee}
     ORDER BY e.id_site, INET_ATON(e.adresse_ip)`,
    params
  );
  return lignes;
}

/**
 * Retire de l'inventaire les adresses derrière lesquelles il n'y a
 * personne. Appelée à la fin de chaque scan et à chaque cycle de
 * supervision — jamais à la main.
 *
 * @param {number|null} idSite  limite la purge à un site, ou tout le parc
 * @returns {Promise<{retires:number, adresses:string[], freine:boolean}>}
 */
async function purgerAdressesSansPreuve(idSite = null) {
  const vide = { retires: 0, adresses: [], freine: false };

  let candidats;
  try {
    candidats = await chercher(idSite, true);
  } catch (err) {
    if (!colonneManquante(err)) {
      console.error("Purge des adresses sans preuve impossible:", err.message);
      return vide;
    }
    if (!colonnePreuveSignalee) {
      colonnePreuveSignalee = true;
      console.warn(
        "\n⚠  EQUIPEMENT.preuve_existence est absente de la base.\n" +
          "   Le nettoyage automatique de l'inventaire fonctionne quand même,\n" +
          "   sur les quatre autres critères. Pour la version complète :\n" +
          "   node tools\\appliquer-migrations.js\n"
      );
    }
    try {
      candidats = await chercher(idSite, false);
    } catch (err2) {
      console.error("Purge des adresses sans preuve impossible:", err2.message);
      return vide;
    }
  }

  if (candidats.length === 0) return vide;

  // ── LE FREIN, PAR SITE ──
  //
  // Évalué site par site et non sur le parc entier : une panne de
  // supervision ne touche pas forcément tous les sites en même temps, et
  // un petit site sain ne doit pas protéger un grand site en panne.
  const parSite = new Map();
  for (const c of candidats) {
    if (!parSite.has(c.id_site)) parSite.set(c.id_site, []);
    parSite.get(c.id_site).push(c);
  }

  const aSupprimer = [];
  let freine = false;

  for (const [site, lignes] of parSite) {
    const [[{ total }]] = await db.query(
      "SELECT COUNT(*) AS total FROM EQUIPEMENT WHERE id_site = ?",
      [site]
    );
    if (total >= PARC_SIGNIFICATIF && lignes.length / total > PART_MAXIMALE) {
      freine = true;
      /* LE FREIN SE DIT DANS LA PLATEFORME, PAS SEULEMENT EN CONSOLE.

         Il ne se déclenche que dans un cas : la supervision est arrêtée,
         ou les relevés ont disparu. C'est-à-dire précisément le moment où
         personne ne lit la fenêtre du serveur. Un garde-fou qui ne
         s'exprime que là où l'on ne regarde pas ne protège de rien —
         c'est exactement le défaut qui a laissé 111 machines supervisées
         par personne pendant quatre jours. */
      await tracer(
        null,
        "nettoyage_inventaire_suspendu",
        `Nettoyage suspendu sur le site ${site} : ${lignes.length} des ${total} ` +
          "équipements n'ont jamais donné signe de vie. Une telle proportion " +
          "ressemble à une supervision arrêtée, pas à des adresses vides. " +
          "Rien n'a été supprimé."
      ).catch(() => {});
      console.warn(
        `\n⚠  NETTOYAGE DE L'INVENTAIRE SUSPENDU sur le site ${site}.\n` +
          `   ${lignes.length} des ${total} équipements n'ont jamais donné le moindre\n` +
          "   signe de vie. Une telle proportion ne s'explique pas par des adresses\n" +
          "   vides : elle ressemble à une supervision arrêtée ou à des relevés\n" +
          "   effacés. Rien n'a été supprimé — vérifiez d'abord :\n" +
          "     node tools\\diagnostic-supervision.js\n"
      );
      continue;
    }
    aSupprimer.push(...lignes);
  }

  if (aSupprimer.length === 0) return { ...vide, freine };

  // Transaction : soit tout part, soit rien. Un inventaire à demi nettoyé
  // serait moins cohérent que celui qu'on corrige.
  const ids = aSupprimer.map((c) => c.id_equipement);
  const adresses = aSupprimer.map((c) => c.adresse_ip);
  const cx = await db.getConnection();
  try {
    await cx.beginTransaction();
    await cx.query(
      `DELETE FROM EQUIPEMENT WHERE id_equipement IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    await cx.commit();
  } catch (err) {
    await cx.rollback().catch(() => {});
    console.error("Purge des adresses sans preuve annulée:", err.message);
    return { ...vide, freine };
  } finally {
    cx.release();
  }

  // Une suppression automatique se DIT. Un produit qui retire des lignes
  // sans laisser de trace est indéfendable devant un audit, et
  // indiagnosticable le jour où il se trompe.
  console.log(
    `Inventaire : ${adresses.length} adresse(s) sans équipement retirée(s) — ` +
      adresses.slice(0, 12).join(", ") +
      (adresses.length > 12 ? `, … (+${adresses.length - 12})` : "")
  );
  await tracer(
    null,
    "adresses_sans_equipement_retirees",
    `${adresses.length} adresse(s) retirée(s) de l'inventaire, ` +
      "aucune n'ayant jamais répondu (ping, port TCP, SNMP, nmap) : " +
      adresses.join(", ")
  );

  // Les écrans ouverts se remettent à jour seuls : l'exploitant ne doit
  // pas voir une ligne qui n'existe plus jusqu'à son prochain F5.
  try {
    diffuser(null, "inventaire", { adresses_retirees: adresses.length });
  } catch (err) {
    console.error("Diffusion du nettoyage d'inventaire impossible:", err.message);
  }

  return { retires: adresses.length, adresses, freine };
}

module.exports = { purgerAdressesSansPreuve };
