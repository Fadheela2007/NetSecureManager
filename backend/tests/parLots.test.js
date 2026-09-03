/**
 * tests/parLots.test.js
 *
 * parLots borne le nombre de machines interrogées simultanément pendant
 * un scan. Une erreur ici ne changerait RIEN aux résultats — le scan
 * rendrait les mêmes équipements — mais changerait la charge envoyée sur
 * le réseau du client : des centaines de connexions simultanées au lieu
 * de quelques dizaines.
 *
 * C'est le pire type de défaut : invisible chez nous, visible chez eux.
 * D'où ces tests, dont le principal vérifie que la limite n'est jamais
 * dépassée, même transitoirement.
 */

const test = require("node:test");
const assert = require("node:assert");
const { parLots } = require("../src/services/parLots");

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Traitement instrumenté : mesure le nombre d'appels EN COURS à chaque
 * instant, et retient le maximum atteint.
 */
function traceur(dureeMs = 5) {
  const etat = { encours: 0, max: 0, appels: 0 };
  const fn = async (element) => {
    etat.appels++;
    etat.encours++;
    etat.max = Math.max(etat.max, etat.encours);
    await attendre(dureeMs);
    etat.encours--;
    return element;
  };
  return { fn, etat };
}

// ─────────────────────────────────────────────────────────────────────
test("jamais plus de N traitements simultanés", async () => {
  const { fn, etat } = traceur();
  await parLots([...Array(50).keys()], 5, fn);

  assert.strictEqual(etat.max, 5, `pointe observée : ${etat.max}, attendu 5`);
  assert.strictEqual(etat.appels, 50, "tous les éléments doivent être traités");
});

test("la limite tient même si les durées sont très inégales", async () => {
  // Cas réaliste : une machine muette prend 15 s (nmap), sa voisine
  // répond en SNMP en 50 ms. Si le code lançait un nouvel élément dès
  // qu'un se termine sans compter, la limite sauterait.
  const etat = { encours: 0, max: 0 };
  await parLots([...Array(40).keys()], 5, async (i) => {
    etat.encours++;
    etat.max = Math.max(etat.max, etat.encours);
    await attendre(i % 7 === 0 ? 40 : 1);
    etat.encours--;
    return i;
  });

  assert.ok(etat.max <= 5, `pointe observée : ${etat.max}, ne doit pas dépasser 5`);
});

test("une machine lente n'immobilise pas les autres places", async () => {
  // C'EST LE TEST QUI JUSTIFIE LA FILE D'ATTENTE.
  //
  // 10 éléments, 5 en parallèle. Quatre sont lents (100 ms), six sont
  // rapides (1 ms).
  //
  //   • en lots figés : le premier lot contient des lents, il coûte
  //     100 ms ; le second aussi. Total ≈ 200 ms.
  //   • en file d'attente : les places libérées par les rapides sont
  //     reprises aussitôt. Total ≈ 100 ms, le temps du plus lent.
  //
  // Le seuil est placé à 160 ms : largement au-dessus du comportement
  // attendu, largement en dessous de l'ancien. Il ne peut donc ni échouer
  // sur une machine chargée, ni réussir si l'on revenait aux lots.
  const lents = new Set([0, 1, 2, 3]);
  const debut = Date.now();

  await parLots([...Array(10).keys()], 5, async (i) => {
    await attendre(lents.has(i) ? 100 : 1);
    return i;
  });

  const duree = Date.now() - debut;
  assert.ok(duree < 160, `durée ${duree} ms : les places libérées ne sont pas reprises`);
});

test("l'ordre des résultats suit l'ordre d'entrée, pas l'ordre d'achèvement", async () => {
  // Sans cette garantie, la liste des équipements changerait d'ordre à
  // chaque scan du même réseau, selon qui a répondu le plus vite.
  const entree = [50, 10, 30, 1, 40, 5];
  const resultats = await parLots(entree, 3, async (ms) => {
    await attendre(ms);
    return ms;
  });

  assert.deepStrictEqual(resultats, entree);
});

test("le dernier lot incomplet est bien traité", async () => {
  // 13 éléments par lots de 5 : deux lots pleins et un lot de 3. Une
  // erreur de borne ferait perdre les trois dernières machines de la
  // plage — silencieusement.
  const resultats = await parLots([...Array(13).keys()], 5, async (i) => i * 2);

  assert.strictEqual(resultats.length, 13);
  assert.strictEqual(resultats[12], 24);
});

test("une liste vide ne fait rien et ne plante pas", async () => {
  const { fn, etat } = traceur();
  const r = await parLots([], 5, fn);

  assert.deepStrictEqual(r, []);
  assert.strictEqual(etat.appels, 0);
});

test("une entrée invalide est traitée comme une liste vide", async () => {
  assert.deepStrictEqual(await parLots(null, 5, async () => 1), []);
  assert.deepStrictEqual(await parLots(undefined, 5, async () => 1), []);
});

// ─────────────────────────────────────────────────────────────────────
test("une taille de lot invalide retombe sur 1, sans boucle infinie", async () => {
  // `i += 0` ne progresse jamais : le scan se figerait sans message, et
  // le cycle de supervision avec lui. Un scan lent se remarque ; un
  // serveur figé se remarque bien plus tard et bien plus mal.
  for (const mauvaise of [0, -3, NaN, undefined, "cinq"]) {
    const { fn, etat } = traceur(1);
    const r = await parLots([1, 2, 3], mauvaise, fn);

    assert.strictEqual(r.length, 3, `taille ${mauvaise} : tous les éléments traités`);
    assert.strictEqual(etat.max, 1, `taille ${mauvaise} : un seul à la fois`);
  }
});

test("une taille décimale est arrondie vers le bas", async () => {
  const { fn, etat } = traceur();
  await parLots([...Array(20).keys()], 5.9, fn);

  assert.strictEqual(etat.max, 5, "5,9 doit donner 5, jamais 6");
});

test("une taille supérieure au nombre d'éléments ne pose pas de problème", async () => {
  const { fn, etat } = traceur();
  const r = await parLots([1, 2], 100, fn);

  assert.strictEqual(r.length, 2);
  assert.strictEqual(etat.max, 2, "on ne traite que ce qui existe");
});

// ─────────────────────────────────────────────────────────────────────
test("l'avancement est notifié à chaque machine terminée, sans dépasser le total", async () => {
  // CONTRAT MODIFIÉ VOLONTAIREMENT, ET NON TEST AJUSTÉ POUR PASSER.
  //
  // Tant que parLots découpait en lots figés, l'avancement ne pouvait
  // être connu qu'à la fin d'un lot : il sautait de 5 en 5. Avec une file
  // d'attente, il n'y a plus de lot — chaque machine se termine pour son
  // propre compte, et l'avancement se compte une par une.
  //
  // C'est meilleur pour l'usage réel : sur une plage large, la barre de
  // progression avançait par à-coups en restant figée le temps de la
  // machine la plus lente du lot. Elle avance maintenant régulièrement.
  const etapes = [];
  await parLots([...Array(13).keys()], 5, async (i) => i, (traites, total) =>
    etapes.push([traites, total])
  );

  assert.strictEqual(etapes.length, 13, "une notification par machine");
  assert.deepStrictEqual(etapes[0], [1, 13]);
  assert.deepStrictEqual(etapes[12], [13, 13]);

  // Le compteur ne recule jamais et ne dépasse jamais le total : c'est ce
  // qui compte pour l'affichage, quel que soit l'ordre d'achèvement.
  const compteurs = etapes.map(([traites]) => traites);
  assert.deepStrictEqual(compteurs, [...Array(13).keys()].map((i) => i + 1));
});

test("l'avancement est facultatif", async () => {
  await assert.doesNotReject(() => parLots([1, 2, 3], 2, async (i) => i));
  await assert.doesNotReject(() => parLots([1, 2, 3], 2, async (i) => i, null));
  await assert.doesNotReject(() => parLots([1, 2, 3], 2, async (i) => i, "pas une fonction"));
});

// ─────────────────────────────────────────────────────────────────────
test("un traitement qui lève interrompt tout : la capture doit être en amont", async () => {
  // Promise.all rejette dès le premier échec, et les autres promesses du
  // lot sont abandonnées. C'est pourquoi discoveryService capture les
  // erreurs DANS analyserHote (qui renvoie null) et non autour du lot :
  // sinon une seule machine capricieuse ferait perdre les quatre autres.
  //
  // Ce test fixe ce contrat pour qu'il ne se perde pas à la prochaine
  // relecture.
  await assert.rejects(
    () =>
      parLots([1, 2, 3, 4], 2, async (i) => {
        if (i === 2) throw new Error("hôte capricieux");
        return i;
      }),
    /hôte capricieux/
  );
});

test("un traitement qui capture ses erreurs laisse passer le reste du lot", async () => {
  // C'est le comportement réel de discoveryService : l'hôte en échec
  // renvoie null, ses voisins sont analysés normalement.
  const resultats = await parLots([1, 2, 3, 4], 2, async (i) => {
    try {
      if (i === 2) throw new Error("SNMP muet");
      return i;
    } catch {
      return null;
    }
  });

  assert.deepStrictEqual(resultats, [1, null, 3, 4]);
  assert.deepStrictEqual(resultats.filter(Boolean), [1, 3, 4]);
});
