/**
 * tests/limiteurConnexion.test.js
 * Limitation des tentatives de connexion.
 *
 * L'horloge est passée en paramètre plutôt que lue dans la fonction :
 * un test qui doit attendre quinze minutes réelles pour vérifier
 * l'expiration d'une fenêtre ne serait jamais exécuté.
 */
const test = require("node:test");
const assert = require("node:assert");

const limiteur = require("../src/services/limiteurConnexion");
const { MAX_PAR_ADRESSE, SEUIL_PAR_COMPTE, FENETRE_MS, DELAI_MAX_MS } = limiteur;

test.beforeEach(() => limiteur.reinitialiser());

const T = 1_000_000_000_000; // instant de référence, arbitraire

test("une première tentative passe sans délai", () => {
  const r = limiteur.verifier("10.0.0.1", "a@b.fr", T);
  assert.strictEqual(r.autorise, true);
  assert.strictEqual(r.delaiMs, 0);
});

test("l'adresse est bloquée au-delà du nombre d'échecs toléré", () => {
  for (let i = 0; i < MAX_PAR_ADRESSE; i++) {
    limiteur.enregistrerEchec("10.0.0.1", `compte${i}@b.fr`, T + i);
  }
  const r = limiteur.verifier("10.0.0.1", "autre@b.fr", T + MAX_PAR_ADRESSE);
  assert.strictEqual(r.autorise, false);
  assert.ok(r.resteMs > 0);
});

test("changer de compte ne contourne pas le blocage par adresse", () => {
  // Le cas réel d'une attaque : essayer un mot de passe courant sur
  // beaucoup de comptes différents plutôt que beaucoup de mots de passe
  // sur un seul. Un compteur par compte seul ne verrait rien.
  for (let i = 0; i < MAX_PAR_ADRESSE; i++) {
    limiteur.enregistrerEchec("10.0.0.1", `victime${i}@b.fr`, T + i);
  }
  assert.strictEqual(limiteur.verifier("10.0.0.1", "victime99@b.fr", T).autorise, false);
});

test("une autre adresse n'est pas affectée", () => {
  for (let i = 0; i < MAX_PAR_ADRESSE + 5; i++) {
    limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T + i);
  }
  assert.strictEqual(limiteur.verifier("10.0.0.2", "a@b.fr", T).autorise, true);
});

test("le blocage court à partir du DERNIER échec", () => {
  // Ce qu'il faut comparer est l'instant ABSOLU de déblocage, et non le
  // temps restant : mesuré au même décalage après chaque échec, celui-ci
  // vaut évidemment la même chose. Une première version de ce test
  // comparait les deux « restants » et échouait sur du code correct.
  for (let i = 0; i < MAX_PAR_ADRESSE; i++) {
    limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T);
  }
  const instantTot = T + 1000;
  const debloquageTot = instantTot + limiteur.verifier("10.0.0.1", "a@b.fr", instantTot).resteMs;

  limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T + 60_000);
  const instantTard = T + 61_000;
  const debloquageTard =
    instantTard + limiteur.verifier("10.0.0.1", "a@b.fr", instantTard).resteMs;

  assert.ok(
    debloquageTard > debloquageTot,
    "un nouvel échec doit repousser l'instant de déblocage"
  );
  assert.strictEqual(debloquageTard - debloquageTot, 60_000, "repoussé d'exactement l'écart");
});

test("une tentative refusée ne prolonge PAS le blocage", () => {
  // Comportement délibéré : sinon un onglet resté ouvert qui réessaie
  // tout seul maintiendrait un utilisateur légitime dehors sans fin.
  // La route sort avant d'enregistrer quoi que ce soit.
  for (let i = 0; i < MAX_PAR_ADRESSE; i++) {
    limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T);
  }
  const premier = limiteur.verifier("10.0.0.1", "a@b.fr", T + 1000);
  // Dix consultations supplémentaires, sans enregistrement d'échec.
  for (let i = 0; i < 10; i++) limiteur.verifier("10.0.0.1", "a@b.fr", T + 1000);
  const dernier = limiteur.verifier("10.0.0.1", "a@b.fr", T + 1000);

  assert.strictEqual(dernier.resteMs, premier.resteMs);
});

test("les échecs sortis de la fenêtre sont oubliés", () => {
  for (let i = 0; i < MAX_PAR_ADRESSE + 5; i++) {
    limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T + i);
  }
  assert.strictEqual(limiteur.verifier("10.0.0.1", "a@b.fr", T).autorise, false);

  const apres = T + FENETRE_MS + 1000;
  assert.strictEqual(limiteur.verifier("10.0.0.1", "a@b.fr", apres).autorise, true);
});

/* ------------------------------------------------------------------ */

test("un compte n'est JAMAIS bloqué, seulement ralenti", () => {
  // Le point le plus important du module : bloquer un compte après N
  // échecs permettrait à n'importe qui de verrouiller l'administrateur
  // en saisissant de faux mots de passe. La protection deviendrait
  // l'attaque.
  for (let i = 0; i < 100; i++) {
    limiteur.enregistrerEchec(`10.0.0.${i % 250}`, "admin@societe.fr", T + i);
  }
  const r = limiteur.verifier("192.168.1.1", "admin@societe.fr", T + 200);
  assert.strictEqual(r.autorise, true, "l'administrateur doit pouvoir se connecter");
  assert.ok(r.delaiMs > 0, "mais avec un ralentissement");
});

test("le ralentissement augmente avec les échecs", () => {
  const delais = [];
  for (let i = 0; i < SEUIL_PAR_COMPTE + 4; i++) {
    limiteur.enregistrerEchec(`10.0.0.${i}`, "a@b.fr", T + i);
    delais.push(limiteur.verifier(`10.1.1.${i}`, "a@b.fr", T + i).delaiMs);
  }
  const actifs = delais.filter((d) => d > 0);
  assert.ok(actifs.length > 0, "un ralentissement doit finir par s'appliquer");
  for (let i = 1; i < actifs.length; i++) {
    assert.ok(actifs[i] >= actifs[i - 1], "le délai ne doit jamais diminuer");
  }
});

test("le ralentissement est plafonné", () => {
  for (let i = 0; i < 60; i++) {
    limiteur.enregistrerEchec(`10.0.${i}.1`, "a@b.fr", T + i);
  }
  const r = limiteur.verifier("192.168.1.1", "a@b.fr", T + 100);
  assert.ok(r.delaiMs <= DELAI_MAX_MS, `délai ${r.delaiMs} au-dessus du plafond`);
});

test("une connexion réussie efface les compteurs", () => {
  // Sans cela, celui qui s'est trompé trois fois avant de réussir
  // resterait ralenti un quart d'heure — puni d'avoir fini par entrer
  // le bon mot de passe.
  for (let i = 0; i < MAX_PAR_ADRESSE - 1; i++) {
    limiteur.enregistrerEchec("10.0.0.1", "a@b.fr", T + i);
  }
  limiteur.enregistrerSucces("10.0.0.1", "a@b.fr");

  const r = limiteur.verifier("10.0.0.1", "a@b.fr", T + 100);
  assert.strictEqual(r.autorise, true);
  assert.strictEqual(r.delaiMs, 0);
  assert.strictEqual(r.echecs, 0);
});

test("la casse de l'e-mail ne permet pas de contourner le compteur", () => {
  for (let i = 0; i < SEUIL_PAR_COMPTE + 2; i++) {
    limiteur.enregistrerEchec(`10.0.0.${i}`, "Admin@Societe.FR", T + i);
  }
  const r = limiteur.verifier("192.168.1.1", "admin@societe.fr", T + 100);
  assert.ok(r.delaiMs > 0, "« ADMIN@ » et « admin@ » désignent le même compte");
});

test("une adresse absente ne fait pas tomber le limiteur", () => {
  // `req.ip` peut être undefined derrière certaines configurations.
  assert.doesNotThrow(() => {
    limiteur.enregistrerEchec(undefined, undefined, T);
    limiteur.verifier(undefined, undefined, T);
  });
});
