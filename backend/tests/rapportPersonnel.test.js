/**
 * tests/rapportPersonnel.test.js
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LE RISQUE QUE CES TESTS SURVEILLENT
 *
 * La plateforme sait envoyer des courriels et sa page d'inscription est
 * ouverte : n'importe qui peut obtenir un compte. Si le destinataire du
 * rapport était choisi par l'appelant, chacun disposerait d'un serveur
 * pour écrire aux autres sous l'identité de NetSecureManager.
 *
 * L'adresse doit donc venir de la BASE, à partir du jeton signé, et de
 * nulle part ailleurs. C'est ce que vérifie le premier test, et c'est le
 * plus important du fichier.
 *
 * Le second risque est plus discret : recevoir par courrier ce qu'on n'a
 * pas le droit de voir à l'écran. Le rapport est donc limité au
 * périmètre du compte, lu en base lui aussi.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test-sans-valeur";

const CHEMIN_DB = require.resolve("../src/db");
const CHEMIN_NOTIF = require.resolve("../src/services/notificationService");
const CHEMIN_RAPPORT = require.resolve("../src/services/rapportService");
const CHEMIN_SERVICE = require.resolve("../src/services/rapportPlanifieService");

/**
 * @param {object} compte   ce que la base rend pour l'utilisateur 7.
 * @param {number} nbEquipements  taille du parc dans son périmètre.
 */
function charger({ compte, nbEquipements = 3, envoiAboutit = true }) {
  const envois = [];
  const perimetresDemandes = [];

  const faux = {
    query: async (sql, params) => {
      const propre = String(sql).replace(/\s+/g, " ").trim();
      if (/FROM UTILISATEUR/i.test(propre)) {
        return [Number(params[0]) === 7 && compte ? [compte] : []];
      }
      if (/FROM SITE/i.test(propre)) {
        return [[{ id_site: 2, nom: "Agence Bonanjo" }]];
      }
      return [[]];
    },
  };
  require.cache[CHEMIN_DB] = new Module(CHEMIN_DB, null);
  require.cache[CHEMIN_DB].filename = CHEMIN_DB;
  require.cache[CHEMIN_DB].loaded = true;
  require.cache[CHEMIN_DB].exports = faux;

  const fauxNotif = new Module(CHEMIN_NOTIF, null);
  fauxNotif.filename = CHEMIN_NOTIF;
  fauxNotif.loaded = true;
  fauxNotif.exports = {
    envoyerRapport: async (message) => {
      envois.push(message);
      /* `envoiAboutit: false` reproduit le comportement réel de
         notificationService sans SMTP_HOST : il n'échoue pas, il ignore.
         Le distinguer d'un succès est tout l'objet du test. */
      return envoiAboutit
        ? { envoyes: message.destinataires.length, echecs: 0, ignores: 0 }
        : { envoyes: 0, echecs: 0, ignores: 1 };
    },
  };
  require.cache[CHEMIN_NOTIF] = fauxNotif;

  const fauxRapport = new Module(CHEMIN_RAPPORT, null);
  fauxRapport.filename = CHEMIN_RAPPORT;
  fauxRapport.loaded = true;
  fauxRapport.exports = {
    collecterDonnees: async ({ portee }) => {
      perimetresDemandes.push(portee);
      return {
        equipements: Array.from({ length: nbEquipements }, () => ({ statut: "up" })),
        alertes: [],
      };
    },
    genererPdfBuffer: async () => Buffer.alloc(2048),
    composerPdf: () => {},
  };
  require.cache[CHEMIN_RAPPORT] = fauxRapport;

  delete require.cache[CHEMIN_SERVICE];
  return { service: require(CHEMIN_SERVICE), envois, perimetresDemandes };
}

test.afterEach(() => {
  for (const c of [CHEMIN_DB, CHEMIN_NOTIF, CHEMIN_RAPPORT, CHEMIN_SERVICE]) {
    delete require.cache[c];
  }
  process.env.SMTP_HOST = "";
});

/* ═══════════════════════════════════════════════════════════════════════
   UN SEUL DESTINATAIRE, ET IL VIENT DE LA BASE
   ═══════════════════════════════════════════════════════════════════════ */

test("le rapport ne part qu'à l'adresse du compte, lue en base", async () => {
  process.env.SMTP_HOST = "smtp.exemple.com";
  const { service, envois } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
  });

  const bilan = await service.envoyerRapportAUtilisateur(7);

  assert.equal(bilan.envoye, true);
  assert.equal(envois.length, 1);
  assert.equal(envois[0].destinataires.length, 1, "un seul destinataire, jamais plus");
  assert.equal(envois[0].destinataires[0].email, "awa@entreprise.com");
  assert.equal(bilan.email, "awa@entreprise.com");
});

test("la fonction ne prend aucun destinataire en paramètre", () => {
  const { service } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
  });

  /* Une seule chose entre : l'identifiant du compte, qui vient du jeton
     signé. S'il devenait possible de passer une adresse, la plateforme
     deviendrait un relais ouvert — sa page d'inscription l'est. */
  assert.equal(service.envoyerRapportAUtilisateur.length, 1);
});

test("le message dit au destinataire qu'il est le seul à l'avoir reçu", async () => {
  process.env.SMTP_HOST = "smtp.exemple.com";
  const { service, envois } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
  });

  await service.envoyerRapportAUtilisateur(7);
  assert.match(envois[0].corps, /qu'à vous/);
});

/* ═══════════════════════════════════════════════════════════════════════
   LE PÉRIMÈTRE AUSSI VIENT DE LA BASE
   ═══════════════════════════════════════════════════════════════════════ */

test("un compte rattaché à un site ne reçoit que son site", async () => {
  process.env.SMTP_HOST = "smtp.exemple.com";
  const { service, perimetresDemandes } = charger({
    compte: { nom: "Bilal", email: "bilal@entreprise.com", id_site: 2 },
  });

  const bilan = await service.envoyerRapportAUtilisateur(7);

  assert.deepEqual(perimetresDemandes, [2], "le rapport est collecté pour le site 2");
  assert.match(bilan.perimetre, /Bonanjo/);
});

test("un compte global reçoit l'ensemble du parc", async () => {
  process.env.SMTP_HOST = "smtp.exemple.com";
  const { service, perimetresDemandes } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
  });

  await service.envoyerRapportAUtilisateur(7);
  assert.deepEqual(perimetresDemandes, [null]);
});

/* ═══════════════════════════════════════════════════════════════════════
   NE JAMAIS ANNONCER UN ENVOI QUI N'A PAS EU LIEU
   ═══════════════════════════════════════════════════════════════════════ */

test("sans serveur de messagerie, on le dit au lieu d'annoncer un envoi", async () => {
  process.env.SMTP_HOST = "";
  const { service } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
    envoiAboutit: false,
  });

  const bilan = await service.envoyerRapportAUtilisateur(7);

  assert.equal(bilan.envoye, false);
  assert.match(bilan.raison, /SMTP_HOST/);
});

test("un compte sans adresse ne provoque pas d'envoi", async () => {
  const { service, envois } = charger({
    compte: { nom: "Sans adresse", email: null, id_site: null },
  });

  const bilan = await service.envoyerRapportAUtilisateur(7);

  assert.equal(bilan.envoye, false);
  assert.match(bilan.raison, /adresse/);
  assert.equal(envois.length, 0);
});

test("un périmètre vide n'envoie pas un rapport à zéro équipement", async () => {
  process.env.SMTP_HOST = "smtp.exemple.com";
  const { service, envois } = charger({
    compte: { nom: "Awa", email: "awa@entreprise.com", id_site: null },
    nbEquipements: 0,
  });

  /* Un rapport annonçant « 0 équipement » n'apprend rien et apprend
     surtout à ignorer ces messages. */
  const bilan = await service.envoyerRapportAUtilisateur(7);

  assert.equal(bilan.envoye, false);
  assert.match(bilan.raison, /aucun équipement/i);
  assert.equal(envois.length, 0);
});

test("un compte introuvable ne fait pas tomber la route", async () => {
  const { service } = charger({ compte: null });

  const bilan = await service.envoyerRapportAUtilisateur(7);
  assert.equal(bilan.envoye, false);
  assert.match(bilan.raison, /introuvable/);
});
