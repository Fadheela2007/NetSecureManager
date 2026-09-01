/**
 * tests/reinitialisationPortee.test.js
 * Qui peut effacer quoi, et sur quel site.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POURQUOI CE FICHIER EST LE PLUS IMPORTANT DU DOSSIER
 *
 * La réinitialisation est la seule fonction de la plateforme qui détruit
 * des données. La règle testée ici décide de son périmètre — et elle
 * reçoit une valeur envoyée par le CLIENT, donc par quiconque sait
 * fabriquer une requête.
 *
 * La règle tient en une phrase : le paramètre peut RESTREINDRE la portée,
 * jamais l'ÉLARGIR. La portée vient du jeton signé par le serveur ; le
 * paramètre n'est qu'une demande.
 *
 * Une erreur ici ne se verrait pas à l'écran. Elle se verrait le jour où
 * l'administrateur d'une agence effacerait le parc du siège.
 * ─────────────────────────────────────────────────────────────────────
 */
const test = require("node:test");
const assert = require("node:assert");
const { resoudrePortee } = require("../src/routes/reinitialisation");

/** Un administrateur de plateforme : aucune restriction de site. */
const global = { user: { id: 1, role: "admin", id_site: null } };
/** Un administrateur rattaché à l'agence (site 2). */
const agence = { user: { id: 2, role: "admin", id_site: 2 } };

/* ═════════════════════════════════════════════════════════════════════
   SANS SITE DEMANDÉ — on garde la portée du compte
   ═════════════════════════════════════════════════════════════════════ */

test("administrateur global sans précision : toute la plateforme", () => {
  assert.deepStrictEqual(resoudrePortee(global, undefined), { site: null });
});

test("administrateur rattaché sans précision : son site, jamais tout", () => {
  // Le point crucial : l'absence de paramètre ne doit PAS être lue comme
  // « tous les sites ». Ce serait une élévation de privilège par omission.
  assert.deepStrictEqual(resoudrePortee(agence, undefined), { site: 2 });
  assert.deepStrictEqual(resoudrePortee(agence, null), { site: 2 });
  assert.deepStrictEqual(resoudrePortee(agence, ""), { site: 2 });
});

/* ═════════════════════════════════════════════════════════════════════
   AVEC UN SITE DEMANDÉ — restreindre, oui ; élargir, non
   ═════════════════════════════════════════════════════════════════════ */

test("un administrateur global peut viser un site précis", () => {
  assert.deepStrictEqual(resoudrePortee(global, 2), { site: 2 });
  // Un identifiant transmis en texte, comme le fait un formulaire.
  assert.deepStrictEqual(resoudrePortee(global, "1"), { site: 1 });
});

test("un administrateur rattaché peut viser SON site", () => {
  assert.deepStrictEqual(resoudrePortee(agence, 2), { site: 2 });
});

test("un administrateur rattaché NE PEUT PAS viser un autre site", () => {
  // Le scénario redouté : l'admin de l'agence efface le parc du siège en
  // changeant un chiffre dans la requête.
  const r = resoudrePortee(agence, 1);
  assert.ok(r.erreur, "la demande doit être refusée");
  assert.strictEqual(r.site, undefined, "aucune portée ne doit être rendue");
  // On ne dit pas « interdit » mais « introuvable » : confirmer qu'un
  // site existe renseigne déjà quelqu'un qui n'a pas à le savoir.
  assert.match(r.erreur, /introuvable/i);
});

/* ═════════════════════════════════════════════════════════════════════
   VALEURS ABERRANTES — refusées, jamais interprétées
   ═════════════════════════════════════════════════════════════════════ */

test("un identifiant invalide est refusé, pas converti", () => {
  // Chacune de ces valeurs vaut 0 ou NaN une fois passée dans Number().
  // Les laisser filer donnerait une clause SQL sur un site inexistant —
  // ou, pire, sur aucun site du tout.
  for (const mauvais of ["abc", 0, -3, 2.5, "2; DROP TABLE", [], {}, true]) {
    const r = resoudrePortee(global, mauvais);
    assert.ok(r.erreur, `${JSON.stringify(mauvais)} aurait dû être refusé`);
  }
});

test("un tableau contenant un identifiant valide est quand même refusé", () => {
  // `Number(["2"])` vaut 2 : sans liste blanche, un tableau passerait.
  // C'est le genre de valeur qu'un client mal écrit envoie sans le vouloir.
  assert.ok(resoudrePortee(global, ["2"]).erreur);
});

test("le refus ne dépend pas du rôle : la forme est vérifiée d'abord", () => {
  // Un administrateur rattaché qui envoie une valeur absurde reçoit une
  // erreur de FORME, pas un accès élargi par accident.
  const r = resoudrePortee(agence, "n'importe quoi");
  assert.ok(r.erreur);
  assert.strictEqual(r.site, undefined);
});
