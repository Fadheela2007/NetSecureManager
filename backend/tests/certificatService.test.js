/**
 * tests/certificatService.test.js
 *
 * Ce module produit des affirmations de SÉCURITÉ sur le parc d'un
 * client. Une erreur ici ne casse pas un écran : elle fait dire à la
 * plateforme qu'un service est sain alors qu'il ne l'est pas, ou
 * l'inverse. Les deux directions se testent.
 *
 * La date du jour est INJECTÉE partout : un test qui dépend de la date
 * réelle passe aujourd'hui et échoue dans un mois, ce qui apprend à
 * ignorer la suite de tests.
 */
const test = require("node:test");
const assert = require("node:assert");
const {
  analyserCertificat,
  versDate,
  nomLisible,
  SEUIL_ALERTE_JOURS,
} = require("../src/services/certificatService");

const LE_10_SEPTEMBRE = new Date("2026-09-10T00:00:00Z");

/** Fabrique une lecture comme en rendrait une vraie poignée de main. */
function lecture(champs = {}, protocole = "TLSv1.3") {
  return {
    brut: {
      subject: { CN: "serveur.exemple.fr" },
      issuer: { CN: "Autorite Interne", O: "Societe" },
      valid_from: "Jan  1 00:00:00 2026 GMT",
      valid_to: "Jan  1 00:00:00 2027 GMT",
      bits: 2048,
      fingerprint256: "AA:BB:CC",
      ...champs,
    },
    protocole,
    chiffrement: "TLS_AES_256_GCM_SHA384",
  };
}

test("un certificat sain ne produit aucun constat", () => {
  const r = analyserCertificat(lecture(), false, LE_10_SEPTEMBRE);
  assert.strictEqual(r.constats.length, 0);
  assert.strictEqual(r.sujet, "serveur.exemple.fr");
  assert.strictEqual(r.emetteur, "Autorite Interne");
  assert.strictEqual(r.auto_signe, false);
});

test("l'expiration se compte en jours, dans les deux sens", () => {
  const bientot = analyserCertificat(
    lecture({ valid_to: "Sep 25 00:00:00 2026 GMT" }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(bientot.jours_restants, 15);
  assert.strictEqual(bientot.constats[0].code, "expire_bientot");
  assert.strictEqual(bientot.constats[0].gravite, "avertissement");

  const passe = analyserCertificat(
    lecture({ valid_to: "Sep 01 00:00:00 2026 GMT" }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(passe.jours_restants, -9);
  assert.strictEqual(passe.constats[0].code, "expire");
  assert.strictEqual(passe.constats[0].gravite, "critique");
});

test("le seuil d'alerte est une frontière, pas une zone floue", () => {
  // Juste au-dessus du seuil : rien. Juste dessus : on alerte. Un test
  // qui n'éprouve pas la borne laisse passer les erreurs de comparaison.
  const jourApres = new Date(LE_10_SEPTEMBRE.getTime() + (SEUIL_ALERTE_JOURS + 1) * 86400000);
  const juste = analyserCertificat(
    lecture({ valid_to: jourApres.toUTCString() }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(juste.constats.length, 0, `${SEUIL_ALERTE_JOURS + 1} jours : rien`);

  const auSeuil = new Date(LE_10_SEPTEMBRE.getTime() + SEUIL_ALERTE_JOURS * 86400000);
  const alerte = analyserCertificat(
    lecture({ valid_to: auSeuil.toUTCString() }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(alerte.constats[0].code, "expire_bientot", `${SEUIL_ALERTE_JOURS} jours : alerte`);
});

test("un certificat pas encore valide est signalé comme une panne", () => {
  // Horloge mal réglée sur l'équipement, ou déploiement en avance : le
  // service est inutilisable exactement comme avec un certificat expiré.
  const r = analyserCertificat(
    lecture({ valid_from: "Dec  1 00:00:00 2026 GMT" }), false, LE_10_SEPTEMBRE
  );
  const c = r.constats.find((x) => x.code === "pas_encore_valide");
  assert.ok(c, "le constat existe");
  assert.strictEqual(c.gravite, "critique");
});

test("auto-signé se juge sur le sujet ENTIER, pas sur le seul nom", () => {
  const memeNom = analyserCertificat(
    lecture({ subject: { CN: "device" }, issuer: { CN: "device" } }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(memeNom.auto_signe, true);

  // Deux certificats différents partagent souvent un nom courant
  // (« localhost », un modèle d'imprimante). Les confondre classerait
  // comme auto-signé un certificat émis par une autorité interne.
  const nomPartage = analyserCertificat(
    lecture({ subject: { CN: "device" }, issuer: { CN: "device", O: "Autorite" } }),
    false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(nomPartage.auto_signe, false);
});

test("UNE CLÉ À COURBE ELLIPTIQUE N'EST PAS UNE CLÉ FAIBLE", () => {
  // `bits` n'est renseigné que pour RSA et DSA. Traiter son absence
  // comme une petite clé ferait crier au danger sur les certificats les
  // plus modernes du parc — et apprendrait à ignorer l'avertissement.
  const r = analyserCertificat(
    lecture({ bits: undefined, nistCurve: "P-256" }), false, LE_10_SEPTEMBRE
  );
  assert.strictEqual(r.taille_cle, null);
  assert.strictEqual(r.courbe, "P-256");
  assert.strictEqual(r.constats.find((c) => c.code === "cle_faible"), undefined);
});

test("une clé RSA trop courte est signalée", () => {
  const r = analyserCertificat(lecture({ bits: 1024 }), false, LE_10_SEPTEMBRE);
  const c = r.constats.find((x) => x.code === "cle_faible");
  assert.ok(c);
  assert.match(c.texte, /1024/);
});

test("TLS ancien : SEULE la preuve produit un constat", () => {
  // LE test qui compte. `false` signifie « notre bibliothèque a peut-être
  // refusé avant le serveur » : en tirer « ce serveur est sûr » serait
  // une affirmation de sécurité non vérifiée.
  const prouve = analyserCertificat(lecture(), true, LE_10_SEPTEMBRE);
  assert.ok(prouve.constats.find((c) => c.code === "tls_ancien"));
  assert.strictEqual(prouve.tls_ancien_accepte, 1);

  const refuse = analyserCertificat(lecture(), false, LE_10_SEPTEMBRE);
  assert.strictEqual(refuse.constats.find((c) => c.code === "tls_ancien"), undefined);
  assert.strictEqual(refuse.tls_ancien_accepte, 0, "refusé : 0, distinct de non testé");

  const nonTeste = analyserCertificat(lecture(), null, LE_10_SEPTEMBRE);
  assert.strictEqual(nonTeste.tls_ancien_accepte, null, "non testé : null, jamais 0");
});

test("une lecture vide ne produit rien plutôt qu'un certificat vide", () => {
  assert.strictEqual(analyserCertificat(null), null);
  assert.strictEqual(analyserCertificat({}), null);
  assert.strictEqual(analyserCertificat({ brut: null }), null);
});

test("une date illisible ne devient pas le 1er janvier 1970", () => {
  assert.strictEqual(versDate("pas une date"), null);
  assert.strictEqual(versDate(""), null);
  assert.strictEqual(versDate(null), null);
  assert.ok(versDate("Jan  1 00:00:00 2027 GMT") instanceof Date);
});

test("un certificat sans date d'expiration ne déclenche aucune alarme", () => {
  // Mieux vaut ne rien dire que d'annoncer une expiration calculée sur
  // une date absente.
  const r = analyserCertificat(lecture({ valid_to: null }), false, LE_10_SEPTEMBRE);
  assert.strictEqual(r.jours_restants, null);
  assert.strictEqual(r.constats.find((c) => c.code === "expire"), undefined);
  assert.strictEqual(r.constats.find((c) => c.code === "expire_bientot"), undefined);
});

test("le nom lisible retombe sur l'organisation à défaut du nom courant", () => {
  assert.strictEqual(nomLisible({ CN: "a", O: "b" }), "a");
  assert.strictEqual(nomLisible({ O: "b" }), "b");
  assert.strictEqual(nomLisible({ OU: "c" }), "c");
  assert.strictEqual(nomLisible({}), null);
  assert.strictEqual(nomLisible(null), null);
});
