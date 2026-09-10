/**
 * agent-poste/agent-poste.js
 * L'agent installé SUR une machine à suivre.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEUX AGENTS, DEUX MÉTIERS — ne pas les confondre
 *
 *   agent de SITE (src/agent/agent.js)   un par RÉSEAU.
 *       Scanne la plage, interroge le SNMP, applique la politique web.
 *       Existe parce qu'un réseau privé distant n'est pas joignable
 *       depuis le serveur central.
 *
 *   agent de POSTE (ce fichier)          un par MACHINE à suivre.
 *       Remonte ce que seule la machine peut savoir d'elle-même : les
 *       logiciels installés et les programmes qui tournent.
 *       Existe parce qu'aucun scan réseau ne peut voir l'intérieur d'un
 *       poste — c'est vrai de Zabbix, de CheckMK et de Nagios comme
 *       d'ici, et c'est pourquoi tous les trois ont aussi un agent.
 *
 * ─────────────────────────────────────────────────────────────────────
 * CONFIGURATION (.env à côté de ce fichier, ou ENV_FILE=)
 *
 *   CENTRAL_API_URL=https://supervision.societe.fr/api
 *   AGENT_TOKEN=<jeton du site, page Sites de la plateforme>
 *   ID_SITE=1
 *   INTERVALLE_MINUTES=60          (défaut 60 : un inventaire n'est pas
 *                                   une mesure, il ne change pas en 5 min)
 *   COLLECTER_UTILISATEUR=0        (défaut 0 — voir plus bas)
 *
 * Le jeton est celui du SITE, pas de la machine : déployer l'agent sur
 * quarante postes ne demande donc pas quarante secrets à gérer. La
 * contrepartie est assumée et doit être dite au client : un poste
 * compromis peut envoyer un inventaire au nom d'un autre poste du même
 * site. Il ne peut RIEN lire — le jeton n'ouvre aucune route de lecture.
 *
 * ─────────────────────────────────────────────────────────────────────
 * VIE PRIVÉE
 *
 * La liste des programmes qu'une personne fait tourner sur son poste dit
 * beaucoup d'elle. Par défaut l'agent ne remonte NI le nom de
 * l'utilisateur, NI les lignes de commande — celles-ci contiennent
 * régulièrement des mots de passe et des chemins personnels.
 *
 * `COLLECTER_UTILISATEUR=1` existe pour les cas où l'exploitant en a
 * réellement besoin. Ce doit être une décision prise, pas un réglage
 * découvert : c'est pourquoi le défaut est l'inverse.
 */
require("dotenv").config({ path: process.env.ENV_FILE || ".env", quiet: true });

const axios = require("axios");
const cron = require("node-cron");
const {
  collecterProcessus,
  collecterLogiciels,
  identite,
  systeme,
} = require("./collecteurs");

const VERSION_AGENT = "1.0.0";

const {
  CENTRAL_API_URL,
  AGENT_TOKEN,
  ID_SITE,
  INTERVALLE_MINUTES = 60,
  COLLECTER_UTILISATEUR = "0",
} = process.env;

/**
 * Bornes d'envoi.
 *
 * Un poste bureautique fait tourner 80 à 150 processus et porte 60 à 200
 * logiciels. Les bornes ci-dessous ne servent donc pas au cas normal :
 * elles évitent qu'un poste anormal — un serveur de virtualisation, une
 * machine infectée — envoie un corps de plusieurs mégaoctets que la
 * limite de taille du serveur refuserait EN ENTIER. Un inventaire tronqué
 * et reçu vaut mieux qu'un inventaire complet et rejeté.
 */
const MAX_PROCESSUS = 400;
const MAX_LOGICIELS = 600;

function verifierConfiguration() {
  const manquants = [];
  if (!CENTRAL_API_URL) manquants.push("CENTRAL_API_URL");
  if (!AGENT_TOKEN) manquants.push("AGENT_TOKEN");
  if (!ID_SITE) manquants.push("ID_SITE");

  if (manquants.length > 0) {
    // Un agent qui démarre sans configuration et tourne en silence est
    // pire qu'un agent qui refuse de démarrer : on le croit en place.
    console.error(
      `\n[Agent de poste] Configuration incomplète : ${manquants.join(", ")}.\n` +
        "  Renseignez-les dans le fichier .env placé à côté de agent-poste.js,\n" +
        "  puis relancez. L'agent ne démarre pas sans elles — un agent muet\n" +
        "  laisserait croire que cette machine est suivie.\n"
    );
    process.exit(1);
  }
}

async function collecterEtEnvoyer() {
  const debut = Date.now();
  const avecUtilisateur = COLLECTER_UTILISATEUR === "1";

  const [processus, logiciels] = await Promise.all([
    collecterProcessus(avecUtilisateur).catch((e) => {
      console.error(`[Agent de poste] Processus non collectés : ${e.message}`);
      return null;
    }),
    collecterLogiciels().catch((e) => {
      console.error(`[Agent de poste] Logiciels non collectés : ${e.message}`);
      return null;
    }),
  ]);

  const moi = identite();
  if (!moi.adresse_ip) {
    console.error(
      "[Agent de poste] Aucune adresse réseau utilisable sur cette machine — " +
        "envoi annulé. Sans adresse, le serveur ne peut rattacher cet " +
        "inventaire à aucun équipement."
    );
    return;
  }

  /* `null` et `[]` ne veulent PAS dire la même chose, et le serveur les
     traite différemment : `[]` signifie « collecté, rien trouvé », `null`
     signifie « la collecte a échoué ». Les confondre effacerait
     l'inventaire d'une machine sur un simple refus de PowerShell. */
  const corps = {
    id_site: Number(ID_SITE),
    agent_version: VERSION_AGENT,
    ...moi,
    ...systeme(),
    processus: processus ? processus.slice(0, MAX_PROCESSUS) : null,
    logiciels: logiciels ? logiciels.slice(0, MAX_LOGICIELS) : null,
  };

  try {
    const { data } = await axios.post(`${CENTRAL_API_URL}/agent/inventaire-poste`, corps, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      timeout: 30_000,
    });
    console.log(
      `[Agent de poste] ${corps.nom_machine} (${corps.adresse_ip}) — ` +
        `${data.logiciels ?? 0} logiciel(s), ${data.processus ?? 0} processus, ` +
        `en ${Math.round((Date.now() - debut) / 1000)} s.`
    );
  } catch (err) {
    const detail = err.response?.data?.error || err.message;
    console.error(`[Agent de poste] Envoi refusé : ${detail}`);
  }
}

function demarrer() {
  verifierConfiguration();

  const minutes = Math.max(5, Number(INTERVALLE_MINUTES) || 60);
  console.log(
    `[Agent de poste ${VERSION_AGENT}] ${systeme().nom_machine} — site ${ID_SITE}, ` +
      `envoi toutes les ${minutes} minutes.` +
      (COLLECTER_UTILISATEUR === "1"
        ? "\n  Collecte du nom d'utilisateur ACTIVÉE."
        : "\n  Nom d'utilisateur non collecté (COLLECTER_UTILISATEUR=0).")
  );

  // Un premier envoi immédiat : sans lui, installer l'agent puis ouvrir
  // la fiche de la machine montrerait un écran vide pendant une heure, et
  // on conclurait que l'installation a échoué.
  collecterEtEnvoyer();

  // UN INTERVALLE D'UNE HEURE OU PLUS SE COMPTE EN HEURES.
  //
  // Un pas de 60 n'existe pas dans un champ « minutes », qui va de 0 à
  // 59. La borne à 59 que j'avais posée produisait un pas de 59 : un
  // déclenchement à la minute 0, PUIS un à la minute 59 — deux envois
  // séparés d'une minute, puis une heure de silence. Le défaut de
  // cadence le plus discret qui soit : l'agent a l'air de fonctionner,
  // il envoie même trop, et l'intervalle demandé n'est jamais respecté.
  //
  // (Ce commentaire est en lignes simples et non en bloc : la syntaxe
  // d'une expression cron contient la séquence qui FERME un commentaire
  // de bloc, et le fichier cessait d'être lisible par Node.)
  const planification =
    minutes >= 60
      ? `0 ${"*"}/${Math.max(1, Math.min(23, Math.round(minutes / 60)))} * * *`
      : `${"*"}/${minutes} * * * *`;

  let enCours = false;
  cron.schedule(planification, async () => {
    if (enCours) return;
    enCours = true;
    try {
      await collecterEtEnvoyer();
    } finally {
      enCours = false;
    }
  });
}

if (require.main === module) demarrer();

module.exports = { collecterEtEnvoyer, VERSION_AGENT };
