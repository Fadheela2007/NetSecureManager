/**
 * agent.js
 * Agent à déployer sur une machine LOCALE à chaque site (ex: un mini-PC ou VM à
 * l'agence de la ville A, un autre à celle de la ville B...). Il scanne le réseau
 * local du site puis pousse les résultats vers la plateforme centrale via HTTPS.
 *
 * C'est ce qui permet de superviser "une autre ville" : le scan actif (ping/ARP/SNMP)
 * doit techniquement partir d'une machine présente sur ce réseau local -- il n'existe
 * pas de moyen de scanner un réseau privé distant depuis Internet sans y avoir un
 * point d'entrée (agent local ou VPN routé jusque-là).
 *
 * Depuis la correction de l'architecture de supervision, l'agent remonte aussi
 * les RELEVÉS SNMP (processeur, mémoire, débit) : le serveur central ne peut pas
 * interroger en SNMP des machines qu'il ne peut pas joindre.
 *
 * Configuration (.env de l'agent) :
 *   CENTRAL_API_URL=https://netsecuremanager.example.com/api
 *   AGENT_TOKEN=<token du site, généré par la plateforme centrale>
 *   ID_SITE=2
 *   CIDR=192.168.10.0/24
 *   SCAN_INTERVAL_MINUTES=5
 *   SNMP_COMMUNITY=public                 (optionnel, défaut « public »)
 *   INVENTAIRE_TOUS_LES_N_CYCLES=12       (optionnel, 0 pour désactiver)
 */

// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ path: process.env.ENV_FILE || ".env", quiet: true });

const axios = require("axios");
const cron = require("node-cron");
const { scanRange, snmpMetrics } = require("../services/discoveryService");
const { calculerDebitsEquipement } = require("../services/traficService");
const dnsGuard = require("./dnsGuard");

const {
  CENTRAL_API_URL,
  AGENT_TOKEN,
  ID_SITE,
  CIDR,
  SCAN_INTERVAL_MINUTES = 5,
  SNMP_COMMUNITY = "public",
  INVENTAIRE_TOUS_LES_N_CYCLES = 12,
} = process.env;

/**
 * Le compteur précédent est gardé par l'AGENT, pas par le serveur.
 *
 * SNMP ne fournit qu'un compteur cumulé : le débit se calcule par
 * différence entre deux relevés, ce qui suppose de connaître l'intervalle
 * exact qui les sépare. L'agent le connaît ; le serveur central ne
 * connaîtrait que le délai entre deux réceptions de push, latence et
 * reprises comprises. Un push retardé de 30 s donnerait un débit
 * plausible et faux.
 *
 * Conséquence assumée : au redémarrage de l'agent le cache est vide et le
 * premier cycle ne remonte pas de débit. Un relevé manquant vaut mieux
 * qu'un relevé inventé, et le cycle suivant corrige.
 *
 * Le calcul vit dans services/traficService.js, partagé avec le cycle
 * central. Le cache y est indexé par (équipement, interface) et non par
 * équipement : sans quoi deux ports du même switch écrasaient
 * mutuellement leur compteur précédent.
 */
let numeroCycle = 0;

/**
 * Version de politique web actuellement appliquée par ce résolveur.
 *
 * Gardée en mémoire pour que l'agent annonce « j'ai la version 7 » et
 * que le serveur réponde « rien de neuf » en quelques octets, au lieu de
 * renvoyer plusieurs mégaoctets de domaines toutes les cinq minutes.
 *
 * Repart à null au redémarrage : le premier cycle retélécharge tout.
 * C'est voulu — l'agent ne peut pas savoir si le fichier sur disque
 * correspond encore à ce que la plateforme attend.
 */
let versionPolitique = null;

/**
 * Récupère la politique de blocage web et l'applique au résolveur local.
 *
 * NE FAIT JAMAIS ÉCHOUER LE CYCLE. La supervision est la fonction
 * principale du produit ; le blocage web est une fonction en plus. Si
 * dnsmasq est absent, si les droits manquent, si la plateforme ne répond
 * pas — on le signale et on continue de superviser.
 */
/**
 * Dernier motif annoncé, pour ne pas répéter le même message à chaque
 * cycle. Voir `annoncer()`.
 */
let dernierMotif = null;

/**
 * Dit ce qui s'est passé — une fois par changement d'état.
 *
 * `appliquerPolitiqueWeb()` avait trois sorties muettes : migration
 * absente côté serveur, politique inactive, politique inchangée. Chacune
 * est légitime, aucune ne disait rien. Résultat observé : huit cycles
 * affichant « politique web uniquement » et rien d'autre, alors que le
 * script d'installation annonçait une ligne « Politique web vN appliquée »
 * qui ne pouvait pas venir. Impossible de distinguer « rien à refaire » de
 * « le serveur n'a pas la migration ».
 *
 * Un agent qui tourne sans rien dire ressemble à un agent qui fonctionne :
 * aucun symptôme jusqu'au jour où quelqu'un constate qu'un site interdit
 * s'ouvre.
 *
 * On n'annonce qu'au premier passage et à chaque changement d'état — un
 * agent tourne toutes les cinq minutes, parfois pendant des mois.
 */
function annoncer(motif, message, estErreur = false) {
  if (dernierMotif === motif) return;
  dernierMotif = motif;
  (estErreur ? console.error : console.log)(`[Agent site ${ID_SITE}] ${message}`);
}

async function appliquerPolitiqueWeb() {
  try {
    const { data } = await axios.get(`${CENTRAL_API_URL}/agent/politique`, {
      params: { id_site: ID_SITE, version: versionPolitique ?? "", ip: dnsGuard.ipLocale() || "" },
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      timeout: 60000, // la liste peut être volumineuse au premier envoi
    });

    if (data.non_installee) {
      annoncer(
        "non_installee",
        "Blocage web indisponible : la base du serveur central n'a pas reçu " +
          "les tables de politique web. Lancez les migrations côté serveur. " +
          "La supervision, elle, continue normalement.",
        true
      );
      return;
    }

    if (!data.active) {
      // Politique désactivée : on RETIRE le blocage. Le conserver
      // laisserait des sites bloqués sans que l'interface l'indique
      // nulle part — impossible à diagnostiquer pour l'administrateur.
      if (versionPolitique !== null) {
        const r = await dnsGuard.retirer();
        versionPolitique = null;
        annoncer(
          "retiree",
          `Politique web retirée${r.applique ? "" : ` (échec : ${r.erreur})`}`
        );
      } else {
        // Cas qui ne disait rien : aucune politique n'a JAMAIS été
        // appliquée, et il n'y en a pas d'active à appliquer. Rien ne
        // bloque, et c'est normal — mais il faut le dire, sinon on
        // attend indéfiniment une ligne qui ne viendra pas.
        annoncer(
          "inactive",
          "Aucune politique de blocage active pour ce site — rien n'est " +
            "bloqué. Activez-la depuis la page Contrôle d'accès web."
        );
      }
      return;
    }

    if (data.inchangee) {
      annoncer(
        `inchangee-v${data.version}`,
        `Politique web v${data.version} déjà en place — rien à refaire.`
      );
      return;
    }

    const resultat = await dnsGuard.appliquer(data.dnsmasq);

    // On remonte le résultat RÉEL, succès comme échec. C'est ce qui
    // permet à l'interface de dire « politique reçue mais non appliquée :
    // dnsmasq absent » au lieu d'afficher un blocage imaginaire.
    // CE COMPTE RENDU NE DOIT PAS ÉCHOUER EN SILENCE.
    //
    // Il portait un `.catch(() => {})` : si l'envoi échouait, l'agent
    // continuait sans un mot. Or c'est CE message qui alimente le
    // bandeau « l'agent applique la version N » de l'interface. Sans
    // lui, l'écran affiche un tiret pour toujours — et le tiret veut
    // dire « je ne sais pas », ce qui est vrai mais inexploitable :
    // impossible de distinguer un agent qui n'a rien appliqué d'un
    // agent qui a réussi mais dont le compte rendu s'est perdu.
    //
    // Le blocage, lui, EST posé. On ne fait donc pas échouer le cycle :
    // on le dit, et on continue. C'est la même règle que partout
    // ailleurs dans cet agent — signaler sans interrompre.
    await axios
      .post(
        `${CENTRAL_API_URL}/agent/politique/etat`,
        {
          id_site: ID_SITE,
          version_appliquee: resultat.applique ? data.version : null,
          erreur: resultat.erreur || null,
        },
        { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }
      )
      .then((r) => {
        // Le serveur peut répondre 200 en disant qu'il n'a rien
        // enregistré — migration absente, par exemple. Un code 200 ne
        // suffit donc pas à conclure que c'est passé.
        if (r.data && r.data.enregistre === false) {
          annoncer(
            "etat-non-enregistre",
            "Blocage posé, mais le serveur central n'a pas enregistré le " +
              "compte rendu" +
              (r.data.non_installee ? " (tables de politique web absentes)." : ".") +
              " L'interface affichera « — » à la place de la version appliquée.",
            true
          );
        }
      })
      .catch((e) => {
        annoncer(
          `etat-echec-${e.message}`,
          `Blocage posé, mais le compte rendu au serveur a échoué : ${e.message}. ` +
            "L'interface affichera « — » à la place de la version appliquée.",
          true
        );
      });

    if (resultat.applique) {
      versionPolitique = data.version;
      // DEUX NOMBRES, PAS UN SEUL.
      //
      // `total_bloques` compte les RÈGLES écrites dans le résolveur, pas
      // les domaines bloqués. Le compilateur retire les sous-domaines
      // déjà couverts par leur parent : bloquer « exemple.com » bloque
      // aussi « pub.exemple.com ». La réduction est importante — 78 985
      // domaines tenaient en 43 701 règles lors d'un test réel.
      //
      // L'ancien message annonçait « 43 701 domaine(s) bloqué(s) » après
      // qu'on venait d'en importer 78 985. Le chiffre était exact, sa
      // formulation trompeuse : elle se lit « 35 000 domaines ont été
      // perdus ». Un client qui compare les deux écrans conclut à une
      // panne, et rien dans le produit ne le détrompe.
      const regles = data.stats?.total_bloques;
      const couverts = data.stats?.domaines_categories;
      const compactes = data.stats?.compactes;
      let detail;
      if (couverts && regles && couverts > regles) {
        detail =
          `${couverts.toLocaleString("fr-FR")} domaine(s) couvert(s) par ` +
          `${regles.toLocaleString("fr-FR")} règle(s)` +
          (compactes
            ? ` — ${compactes.toLocaleString("fr-FR")} sous-domaine(s) déjà couvert(s) par leur domaine parent.`
            : ".");
      } else {
        detail = `${regles ?? "?"} règle(s) de blocage.`;
      }
      annoncer(`appliquee-v${data.version}`, `Politique web v${data.version} appliquée — ${detail}`);
    } else {
      versionPolitique = null;
      annoncer(`echec-${resultat.erreur}`, `Politique web NON appliquée : ${resultat.erreur}`, true);
    }
  } catch (err) {
    annoncer(`injoignable-${err.message}`, `Politique web indisponible : ${err.message}`, true);
  }
}

/**
 * Remonte le comptage AGRÉGÉ des blocages.
 *
 * Un total par jour, rien d'autre : ni domaine, ni adresse de poste, ni
 * heure. Voir dnsGuard.relever() pour la raison technique de ce choix.
 */
async function remonterStatistiques() {
  try {
    const releve = await dnsGuard.relever();
    if (releve.total === null) return;

    await axios.post(
      `${CENTRAL_API_URL}/agent/stats-blocage`,
      {
        id_site: ID_SITE,
        jour: new Date().toISOString().slice(0, 10),
        compteurs: [{ categorie: null, nb: releve.total }],
      },
      { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }
    );
  } catch {
    // Une statistique manquante n'a aucune conséquence : on n'en parle pas.
  }
}

/**
 * Collecte les relevés SNMP.
 *
 * NE SONDE QUE LES ÉQUIPEMENTS AYANT DÉJÀ RÉPONDU EN SNMP.
 *
 * Sur un parc courant, la grande majorité des machines n'expose pas SNMP.
 * Les interroger quand même coûterait 4 interrogations à 3 s de délai
 * d'attente chacune, soit jusqu'à 12 secondes par machine muette — sur
 * 50 machines, 10 minutes de balayage pour aucun résultat.
 *
 * `scanRange` a déjà déterminé qui répond : les équipements dont
 * `sys_descr` est renseigné. On se limite à ceux-là. Aucune erreur, aucun
 * trafic inutile.
 *
 * @param {Array} equipements  résultat de scanRange
 * @param {boolean} avecInventaire  inclure le nom et l'état des interfaces
 */
async function collecterReleves(equipements, avecInventaire) {
  const releves = [];
  const interfaces = [];

  const repondentSnmp = equipements.filter((e) => e.sys_descr);
  if (repondentSnmp.length === 0) return { releves, interfaces, sondes: 0 };

  for (const eq of repondentSnmp) {
    try {
      const metrics = await snmpMetrics(eq.adresse_ip, SNMP_COMMUNITY, { avecInventaire });

      // Toutes les interfaces, pas seulement la première : sur un switch,
      // le port 1 ne dit rien de la charge de l'équipement.
      const debits = calculerDebitsEquipement(eq.adresse_ip, metrics.interfaces || []);
      const entrant = debits.total.entrant;
      const sortant = debits.total.sortant;

      releves.push({
        adresse_ip: eq.adresse_ip,
        latence_ms: eq.latence_ms ?? null,
        cpu_pourcent: metrics.cpuPercent,
        ram_pourcent: metrics.ramPercent,
        trafic_entrant_kbps: entrant,
        trafic_sortant_kbps: sortant,
      });

      if (avecInventaire) {
        const debitParIndex = new Map(debits.parInterface.map((d) => [d.index_snmp, d]));
        for (const i of metrics.interfaces || []) {
          if (!i.nom) continue;
          const d = debitParIndex.get(Number(i.index));
          interfaces.push({
            adresse_ip: eq.adresse_ip,
            index_snmp: i.index,
            nom: i.nom,
            adresse_mac: i.adresseMac,
            etat_admin: i.etatAdmin,
            etat_operationnel: i.etatOperationnel,
            vitesse_mbps: i.vitesseMbps ?? null,
            trafic_entrant_kbps: d?.trafic_entrant_kbps ?? null,
            trafic_sortant_kbps: d?.trafic_sortant_kbps ?? null,
          });
        }
      }
    } catch (err) {
      // Un équipement qui échoue ne doit pas interrompre la collecte.
      console.error(`[Agent site ${ID_SITE}] Relevé de ${eq.adresse_ip} ignoré :`, err.message);
    }
  }

  return { releves, interfaces, sondes: repondentSnmp.length };
}

async function runScanAndPush() {
  numeroCycle++;

  // MODE « POLITIQUE SEULE » (POLITIQUE_SEULE=1 dans le .env)
  //
  // N'applique que la politique web : ni scan, ni push.
  //
  // Ce mode existe pour une raison précise. Sur le site CENTRAL, un push
  // renseigne `SITE.dernier_push` — et c'est justement ce champ qui dit
  // au serveur « ce site est pris en charge par un agent, arrête de le
  // superviser toi-même ». Lancer l'agent de test sur le site local
  // couperait donc la supervision de ce site, sans le moindre message.
  //
  // Le symptôme serait particulièrement trompeur : tous les équipements
  // resteraient au dernier statut connu, l'interface aurait l'air
  // normale, et plus rien ne serait réellement surveillé.
  if (process.env.POLITIQUE_SEULE === "1") {
    console.log(`[Agent site ${ID_SITE}] Cycle ${numeroCycle} — politique web uniquement.`);
    await appliquerPolitiqueWeb();
    await remonterStatistiques();
    return;
  }
  console.log(`[Agent site ${ID_SITE}] Cycle ${numeroCycle} — scan de ${CIDR}...`);

  // `balayage_complet` distingue « la plage a été parcourue en entier » de
  // « le balayage s'est interrompu ». C'est ce qui autorise le serveur à
  // conclure qu'un équipement absent du relevé est réellement hors ligne :
  // sur un balayage partiel, il ne conclut rien plutôt que de déclarer une
  // panne générale.
  let equipements = [];
  let balayageComplet = false;
  const debutScan = Date.now();
  try {
    // Retour d'avancement : sur un /23 (510 adresses), l'identification
    // machine par machine peut durer plusieurs minutes. Sans ces lignes,
    // l'agent lancé à la main reste muet assez longtemps pour qu'on le
    // croie planté — et c'est exactement ce qu'on conclut.
    let dernierAffichage = 0;
    equipements = await scanRange({
      cidr: CIDR,
      snmpCommunity: SNMP_COMMUNITY,
      onProgress: (etape, courant, total) => {
        if (etape === "balayage") {
          console.log(`[Agent site ${ID_SITE}] Balayage de ${total} adresses...`);
          return;
        }
        // Une ligne toutes les 5 s au plus : sur 200 machines, une ligne
        // par machine noierait le journal systemd.
        const maintenant = Date.now();
        if (courant === 1 || courant === total || maintenant - dernierAffichage > 5000) {
          dernierAffichage = maintenant;
          const s = Math.round((maintenant - debutScan) / 1000);
          console.log(`[Agent site ${ID_SITE}] Identification ${courant}/${total} (${s} s écoulées)...`);
        }
      },
    });
    balayageComplet = true;
  } catch (err) {
    console.error(`[Agent site ${ID_SITE}] Balayage interrompu :`, err.message);
    // On transmet quand même ce qui a été trouvé, sans autoriser de déduction.
  }

  // L'inventaire des interfaces double le coût SNMP (4 tables de plus par
  // équipement). Le nom, la MAC et le VLAN d'une interface ne changent qu'à
  // la reconfiguration d'un switch : inutile de les relire toutes les
  // 5 minutes. Même arbitrage que côté serveur, transposé au rythme de
  // l'agent : premier cycle après démarrage, puis un cycle sur N.
  const nInventaire = Number(INVENTAIRE_TOUS_LES_N_CYCLES);
  const avecInventaire =
    Number.isFinite(nInventaire) && nInventaire > 0
      ? numeroCycle === 1 || numeroCycle % nInventaire === 0
      : false;

  let releves = [];
  let interfaces = [];
  let sondes = 0;
  try {
    const collecte = await collecterReleves(equipements, avecInventaire);
    releves = collecte.releves;
    interfaces = collecte.interfaces;
    sondes = collecte.sondes;
  } catch (err) {
    console.error(`[Agent site ${ID_SITE}] Collecte SNMP échouée :`, err.message);
    // Le push a lieu quand même : les statuts valent mieux que rien.
  }

  // Le push est enveloppé : un échec ne doit PAS emporter la suite du
  // cycle. Sans cette capture, une plateforme momentanément indisponible
  // faisait remonter l'exception jusqu'au `.catch(console.error)` du
  // démarrage, et la politique web n'était jamais appliquée — alors
  // qu'elle ne dépend en rien de la réussite du push.
  let data = null;
  try {
    const reponse = await axios.post(
      `${CENTRAL_API_URL}/agent/push`,
      {
        id_site: ID_SITE,
        equipements,
        cidr: CIDR,
        balayage_complet: balayageComplet,
        releves,
        interfaces: avecInventaire ? interfaces : undefined,
      },
      { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }
    );
    data = reponse.data;
  } catch (err) {
    console.error(`[Agent site ${ID_SITE}] Transmission échouée :`, err.message);
  }

  // Politique web APRÈS le push : la supervision passe en premier. Si la
  // plateforme est lente à répondre sur la politique, les relevés sont
  // déjà arrivés.
  await appliquerPolitiqueWeb();
  await remonterStatistiques();

  console.log(
    `[Agent site ${ID_SITE}] Cycle terminé en ${Math.round((Date.now() - debutScan) / 1000)} s — ` +
      `${equipements.length} équipement(s), ` +
      `${sondes} sondé(s) en SNMP, ${releves.length} relevé(s) transmis` +
      (avecInventaire ? `, ${interfaces.length} interface(s)` : "") +
      (balayageComplet
        ? `, ${data?.hors_ligne ?? 0} passé(s) hors ligne.`
        : " (balayage partiel : aucun statut déduit).")
  );
}

// Démarrage automatique uniquement quand ce fichier est lancé directement
// (`node src/agent/agent.js`). Sans cette garde, un simple `require` du
// module déclenchait un balayage réseau complet — ce qui rendait l'agent
// intestable et pouvait surprendre au premier import.
if (require.main === module) {
  runScanAndPush().catch(console.error);
  cron.schedule(`*/${SCAN_INTERVAL_MINUTES} * * * *`, () => {
    runScanAndPush().catch(console.error);
  });
}

module.exports = { runScanAndPush, collecterReleves };
