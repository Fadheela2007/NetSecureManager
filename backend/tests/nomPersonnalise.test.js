/**
 * tests/nomPersonnalise.test.js
 * Nettoyage et validation d'un nom saisi par l'exploitant.
 *
 * La saisie libre est la seule donnée du produit qui vient directement
 * d'un humain : c'est donc la seule qui reçoive n'importe quoi.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  nettoyerNomPersonnalise,
  validerNomPersonnalise,
  nomAffiche,
  LONGUEUR_MAX,
} = require("../src/services/nomPersonnaliseService");

test("un nom ordinaire traverse le nettoyage sans dommage", () => {
  assert.strictEqual(nettoyerNomPersonnalise("Imprimante comptabilité"), "Imprimante comptabilité");
});

test("les accents, apostrophes et tirets sont conservés", () => {
  // Les retirer donnerait « Camera d entree » — une correction que
  // personne n'a demandée, sur des noms français parfaitement valides.
  const noms = ["Caméra d'entrée", "Salle-de-réunion", "Poste n°12", "Bureau (étage 2)"];
  for (const nom of noms) {
    assert.strictEqual(nettoyerNomPersonnalise(nom), nom);
  }
});

test("les espaces superflus sont réduits", () => {
  // « Imprimante   RH » et « Imprimante RH » désignent la même machine :
  // les garder distincts crée des doublons invisibles à l'œil.
  assert.strictEqual(nettoyerNomPersonnalise("  Imprimante   RH  "), "Imprimante RH");
});

test("les caractères de contrôle deviennent des espaces", () => {
  // Cas réel : un nom collé depuis un tableur emporte une tabulation ou
  // un retour à la ligne. Laissé tel quel, il casse l'alignement de la
  // liste et peut faire passer un nom pour deux lignes dans un export.
  assert.strictEqual(nettoyerNomPersonnalise("Imprimante\tRH\nétage 2"), "Imprimante RH étage 2");
  assert.strictEqual(nettoyerNomPersonnalise("Salle\r\nréunion"), "Salle réunion");
});

test("les caractères invisibles collés d'une page web sont retirés", () => {
  // Espace de largeur nulle : deux noms rigoureusement identiques à
  // l'écran deviennent impossibles à rapprocher.
  assert.strictEqual(nettoyerNomPersonnalise("Bureau​comptable"), "Bureau comptable");
  assert.strictEqual(nettoyerNomPersonnalise("﻿Imprimante"), "Imprimante");
});

test("une chaîne vide vaut effacement, pas nom vide", () => {
  // C'est ainsi qu'on revient au nom découvert automatiquement : il n'y
  // a pas de route de suppression séparée à retenir.
  for (const vide of ["", "   ", "\t\n", null, undefined]) {
    assert.strictEqual(nettoyerNomPersonnalise(vide), null, JSON.stringify(vide));
  }
});

test("un nom trop long est coupé, jamais rejeté", () => {
  const long = "A".repeat(400);
  const nettoye = nettoyerNomPersonnalise(long);
  assert.strictEqual(nettoye.length, LONGUEUR_MAX);
  // Couper vaut mieux que refuser : la colonne est bornée, et un refus
  // ferait perdre la saisie entière pour un dépassement.
  assert.strictEqual(validerNomPersonnalise(nettoye), null);
});

test("une valeur non textuelle ne fait pas tomber la route", () => {
  // Un client mal écrit peut envoyer un nombre ou un objet.
  assert.strictEqual(nettoyerNomPersonnalise(42), "42");
  assert.strictEqual(typeof nettoyerNomPersonnalise({}), "string");
});

/* ------------------------------------------------------------------ */

test("effacer le nom est toujours autorisé", () => {
  assert.strictEqual(validerNomPersonnalise(null), null);
});

test("un nom fait uniquement de ponctuation est refusé", () => {
  // Il n'identifie rien et rend la ligne plus difficile à lire qu'une
  // case vide.
  for (const nom of ["...", "---", "???", "***"]) {
    assert.ok(validerNomPersonnalise(nom), `« ${nom} » devrait être refusé`);
  }
});

test("un nom contenant au moins un caractère utile est accepté", () => {
  for (const nom of ["A", "12", "Poste n°1", "Caméra"]) {
    assert.strictEqual(validerNomPersonnalise(nom), null, nom);
  }
});

/* ------------------------------------------------------------------ */

test("le nom personnalisé prime sur le nom découvert", () => {
  // Y compris sur SNMP : c'est une décision humaine, elle l'emporte sur
  // une découverte automatique.
  const eq = { nom_personnalise: "Imprimante RH", nom: "KMBFD6FC", adresse_ip: "192.168.0.233" };
  assert.strictEqual(nomAffiche(eq), "Imprimante RH");
});

test("à défaut de nom personnalisé, le nom découvert s'affiche", () => {
  const eq = { nom_personnalise: null, nom: "KMBFD6FC", adresse_ip: "192.168.0.233" };
  assert.strictEqual(nomAffiche(eq), "KMBFD6FC");
});

test("sans aucun nom, l'adresse identifie encore l'équipement", () => {
  const eq = { nom_personnalise: null, nom: null, adresse_ip: "192.168.0.18" };
  assert.strictEqual(nomAffiche(eq), "192.168.0.18");
});

test("un nom personnalisé vide en base ne masque pas le nom découvert", () => {
  // Une base ancienne peut contenir une chaîne vide plutôt que NULL.
  // Sans ce nettoyage à l'affichage, l'équipement paraîtrait sans nom
  // alors qu'il en a un.
  const eq = { nom_personnalise: "   ", nom: "KMBFD6FC", adresse_ip: "192.168.0.233" };
  assert.strictEqual(nomAffiche(eq), "KMBFD6FC");
});

test("un équipement absent ne fait pas tomber l'affichage", () => {
  assert.strictEqual(nomAffiche(null), "");
  assert.strictEqual(nomAffiche(undefined), "");
});
