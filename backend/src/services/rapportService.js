/**
 * rapportService.js
 * Collecte des données et génération du rapport PDF de supervision.
 *
 * Extrait de routes/rapports.js pour être partagé entre :
 *   - la route GET /api/rapport/pdf (téléchargement à la demande)
 *   - le planificateur d'envoi par e-mail (rapportPlanifieService)
 *
 * Le périmètre est passé EXPLICITEMENT (`portee`), pas déduit d'un objet
 * `req` : le planificateur n'a pas de requête HTTP. C'est la seule raison
 * de ce paramètre — la règle de cloisonnement reste la même que partout
 * ailleurs (null = global, sinon un site précis).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * LA MISE EN PAGE, REFAITE LE 17/09 — ET POURQUOI ÇA COMPTE
 *
 * La version précédente écrivait une ligne de texte par équipement :
 *
 *     ● SVR-SAP — 192.168.0.250 — Dell — up — dispo. 99.31 %
 *
 * C'est lisible pour trois machines. À soixante-treize, l'œil n'a aucun
 * repère vertical : rien ne s'aligne, on ne peut ni comparer deux lignes
 * ni balayer une colonne. Le document ressemble à une sortie de console
 * imprimée — et un dirigeant à qui l'on remet ça le repose.
 *
 * Ce rapport est souvent la SEULE chose de la plateforme qu'un dirigeant
 * regardera vraiment, et la seule qui circule hors de l'écran : elle est
 * imprimée, transférée, montrée en réunion. Sa mise en page n'est pas de
 * la décoration, c'est le dernier maillon du travail.
 *
 * D'où de vrais tableaux : en-tête sur fond sombre, colonnes alignées,
 * lignes alternées, et l'en-tête RÉPÉTÉ en haut de chaque page — sans
 * quoi la page 3 d'un tableau est une grille de chiffres sans titre.
 *
 * ── CE QUI N'A PAS CHANGÉ ──
 *
 * Aucune donnée n'est ajoutée, retirée ni arrondie. Les mises en garde
 * restent, et elles restent VISIBLES : les taux sont des majorants, une
 * couverture de collecte insuffisante est signalée en rouge, et « état
 * inconnu » garde son explication. Un rapport plus beau qui dirait moins
 * la vérité serait une régression.
 * ═══════════════════════════════════════════════════════════════════════
 */

const PDFDocument = require("pdfkit");
const db = require("../db");
const { calculerDisponibiliteLot } = require("./disponibiliteService");

/** Formate un taux, en distinguant « non fiable » de « 100 % ». */
function formaterTaux(d) {
  if (!d) return "—";
  if (!d.fiable) return `${d.taux_indicatif?.toFixed(2) ?? "—"} % (indicatif)`;
  return `${d.taux_disponibilite.toFixed(2)} %`;
}

/**
 * Rassemble tout ce dont le rapport a besoin.
 *
 * @param {object} options
 * @param {number|null} options.portee   site de rattachement, null = global
 * @param {number|null} [options.idSite] filtre supplémentaire demandé
 */
async function collecterDonnees({ portee = null, idSite = null } = {}) {
  const [equipements] = await db.query(
    `SELECT * FROM EQUIPEMENT
     WHERE (? IS NULL OR id_site = ?) AND (? IS NULL OR id_site = ?)`,
    [idSite, idSite, portee, portee]
  );

  const [alertes] = await db.query(
    `SELECT a.*, e.adresse_ip, e.nom FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE a.date_creation >= NOW() - INTERVAL 30 DAY
       AND (? IS NULL OR COALESCE(a.id_site, e.id_site) = ?)
     ORDER BY a.date_creation DESC`,
    [portee, portee]
  );

  // 3 requêtes au total quel que soit le nombre d'équipements.
  const dispos = await calculerDisponibiliteLot(equipements, 30);

  return { equipements, alertes, dispos };
}

/* ═════════════════════════ LA BOÎTE À OUTILS ═════════════════════════
   Volontairement minuscule et sans dépendance : pdfkit ne fournit pas de
   tableau utilisable tel quel, et ajouter une bibliothèque pour dessiner
   des rectangles serait payer cher une chose qui tient en trente lignes.
   ═══════════════════════════════════════════════════════════════════ */

const COULEURS = {
  encre: "#1f2430",
  doux: "#6b7280",
  ligne: "#dcdfe5",
  entete: "#232b3a",
  alternee: "#f5f6f8",
  ok: "#1f7a4d",
  crit: "#b3261e",
  attention: "#a1691a",
  accent: "#8a6d1f",
};

const HAUTEUR_ENTETE = 20;
const HAUTEUR_LIGNE = 17;
/** Place réservée en bas de page pour le pied de page. */
const RESERVE_PIED = 30;

function largeurUtile(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/**
 * Le pied de page, dessiné sur CHAQUE page.
 *
 * Pas de « page 2 sur 7 » : connaître le total exigerait de garder toutes
 * les pages en mémoire (`bufferPages`), et la route de téléchargement
 * construit son document elle-même, en flux. Un numéro seul suffit à
 * remettre en ordre des feuilles tombées par terre — c'est tout ce qu'on
 * lui demande.
 */
function piedDePage(doc, numero) {
  const y = doc.page.height - doc.page.margins.bottom - 14;
  const x0 = doc.page.margins.left;
  doc
    .moveTo(x0, y - 6)
    .lineTo(x0 + largeurUtile(doc), y - 6)
    .lineWidth(0.5)
    .strokeColor(COULEURS.ligne)
    .stroke();
  doc.fontSize(7.5).fillColor(COULEURS.doux).font("Helvetica");
  doc.text("NetSecureManager — rapport de supervision", x0, y, {
    width: largeurUtile(doc) / 2,
    lineBreak: false,
  });
  doc.text(`Page ${numero}`, x0 + largeurUtile(doc) / 2, y, {
    width: largeurUtile(doc) / 2,
    align: "right",
    lineBreak: false,
  });
}

/**
 * Coupe un texte pour qu'il tienne dans une largeur donnée.
 *
 * POURQUOI À LA MAIN. L'option `ellipsis` de pdfkit ne s'applique que si
 * une HAUTEUR est fournie en plus de la largeur ; sans elle, le texte
 * passe à la ligne malgré `lineBreak: false`, la cellule déborde sur la
 * ligne suivante et tout le tableau se décale. Constaté à l'essai sur
 * « Kyocera Document Solutions ».
 *
 * On mesure donc nous-mêmes, avec la police et la taille en cours. C'est
 * exact, et ça ne dépend d'aucun comportement implicite.
 */
function couper(doc, texte, largeur) {
  if (doc.widthOfString(texte) <= largeur) return texte;
  let coupe = texte;
  while (coupe.length > 1 && doc.widthOfString(`${coupe}…`) > largeur) {
    coupe = coupe.slice(0, -1);
  }
  return `${coupe.trimEnd()}…`;
}

/** Dessine la ligne d'en-tête d'un tableau et renvoie le y suivant. */
function enteteTableau(doc, colonnes, y) {
  const x0 = doc.page.margins.left;
  doc.rect(x0, y, largeurUtile(doc), HAUTEUR_ENTETE).fill(COULEURS.entete);

  let x = x0;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");
  for (const c of colonnes) {
    doc.text(couper(doc, c.titre.toUpperCase(), c.largeur - 12), x + 6, y + 6.5, {
      width: c.largeur - 12,
      align: c.align || "left",
      lineBreak: false,
    });
    x += c.largeur;
  }
  doc.font("Helvetica");
  return y + HAUTEUR_ENTETE;
}

/**
 * Une ligne. Chaque cellule est une chaîne, ou { texte, couleur, gras }.
 *
 * `lineBreak: false` et `ellipsis: true` : un nom de machine trop long est
 * coupé par des points de suspension au lieu de passer à la ligne. Une
 * seule cellule qui déborde décalerait toutes les bordures du tableau, et
 * c'est exactement l'effet « sortie de console » qu'on corrige ici.
 */
function ligneTableau(doc, colonnes, cellules, y, index) {
  const x0 = doc.page.margins.left;

  if (index % 2 === 1) {
    doc.rect(x0, y, largeurUtile(doc), HAUTEUR_LIGNE).fill(COULEURS.alternee);
  }
  doc
    .moveTo(x0, y + HAUTEUR_LIGNE)
    .lineTo(x0 + largeurUtile(doc), y + HAUTEUR_LIGNE)
    .lineWidth(0.5)
    .strokeColor(COULEURS.ligne)
    .stroke();

  let x = x0;
  colonnes.forEach((c, i) => {
    const brut = cellules[i];
    const cellule = brut && typeof brut === "object" ? brut : { texte: brut };
    const texte =
      cellule.texte === null || cellule.texte === undefined || cellule.texte === ""
        ? "—"
        : String(cellule.texte);

    doc
      .font(cellule.gras ? "Helvetica-Bold" : "Helvetica")
      .fontSize(8.5)
      .fillColor(cellule.couleur || COULEURS.encre);

    // La mesure se fait APRÈS avoir choisi la police et la taille : en gras,
    // le même texte est plus large.
    doc.text(couper(doc, texte, c.largeur - 12), x + 6, y + 4.5, {
      width: c.largeur - 12,
      align: c.align || "left",
      lineBreak: false,
    });
    x += c.largeur;
  });

  doc.font("Helvetica");
  return y + HAUTEUR_LIGNE;
}

/**
 * Dessine un tableau complet, en gérant les sauts de page.
 *
 * L'EN-TÊTE EST REDESSINÉ APRÈS CHAQUE SAUT. Sans cela, la deuxième page
 * d'un tableau de soixante-treize lignes est une grille de valeurs dont
 * plus personne ne sait ce qu'elles désignent — le défaut le plus courant
 * des rapports générés, et le plus facile à éviter.
 *
 * @returns {number} le y après la dernière ligne
 */
function tableau(doc, { colonnes, lignes }, y, surNouvellePage) {
  let curseur = enteteTableau(doc, colonnes, y);

  lignes.forEach((cellules, index) => {
    const basUtile = doc.page.height - doc.page.margins.bottom - RESERVE_PIED;
    if (curseur + HAUTEUR_LIGNE > basUtile) {
      doc.addPage();
      surNouvellePage();
      curseur = enteteTableau(doc, colonnes, doc.page.margins.top);
    }
    curseur = ligneTableau(doc, colonnes, cellules, curseur, index);
  });

  return curseur;
}

/** Un titre de section, avec son filet. */
function titreSection(doc, texte, y) {
  const x0 = doc.page.margins.left;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COULEURS.encre);
  doc.text(texte, x0, y, { lineBreak: false });
  doc.font("Helvetica");
  return y + 18;
}

/** Une note en petit, sous un titre ou un tableau. */
function note(doc, texte, y, couleur = COULEURS.doux) {
  const x0 = doc.page.margins.left;
  doc.font("Helvetica").fontSize(7.5).fillColor(couleur);
  doc.text(texte, x0, y, { width: largeurUtile(doc), align: "left" });
  return doc.y + 4;
}

/**
 * Les quatre chiffres du résumé, en cartouches.
 *
 * Un dirigeant qui ouvre ce document lit ces quatre nombres et referme.
 * Ils doivent donc être lisibles à un mètre, et le reste du rapport est
 * la justification de ces quatre-là.
 */
function cartouches(doc, valeurs, y) {
  const x0 = doc.page.margins.left;
  const largeur = largeurUtile(doc);
  const ecart = 8;
  const largeurCarte = (largeur - ecart * (valeurs.length - 1)) / valeurs.length;
  const hauteur = 46;

  valeurs.forEach((v, i) => {
    const x = x0 + i * (largeurCarte + ecart);
    doc.roundedRect(x, y, largeurCarte, hauteur, 4).lineWidth(0.7).strokeColor(COULEURS.ligne).stroke();

    doc.font("Helvetica-Bold").fontSize(17).fillColor(v.couleur || COULEURS.encre);
    doc.text(String(v.valeur), x, y + 8, { width: largeurCarte, align: "center", lineBreak: false });

    doc.font("Helvetica").fontSize(7.5).fillColor(COULEURS.doux);
    doc.text(v.libelle.toUpperCase(), x, y + 30, {
      width: largeurCarte,
      align: "center",
      lineBreak: false,
    });
  });

  return y + hauteur + 14;
}

const LIBELLE_STATUT = {
  up: { texte: "En ligne", couleur: COULEURS.ok },
  down: { texte: "Hors ligne", couleur: COULEURS.crit },
  inconnu: { texte: "Inconnu", couleur: COULEURS.doux },
};

/**
 * Les types d'alerte, en français lisible.
 *
 * La base stocke des clés techniques — `equipement_down`, `cpu_eleve` —
 * et c'est très bien : elles sont stables, elles servent aux règles et aux
 * requêtes. Mais un rapport qui les affiche telles quelles demande à son
 * lecteur de parler la langue de la base de données.
 *
 * La traduction est un LIBELLÉ D'AFFICHAGE, pas une réécriture : la clé
 * inconnue retombe sur elle-même, tirets bas remplacés par des espaces.
 * Aucune alerte ne peut donc disparaître du rapport faute d'être traduite.
 */
const LIBELLE_TYPE = {
  equipement_down: "Équipement injoignable",
  agent_muet: "Agent sans nouvelles",
  agent_jamais_connecte: "Agent jamais connecté",
  cpu_eleve: "Charge processeur élevée",
  ram_elevee: "Mémoire vive saturée",
  certificat_expire: "Certificat expiré",
  certificat_expire_bientot: "Certificat bientôt expiré",
};

function libelleType(type) {
  return LIBELLE_TYPE[type] || String(type || "").replace(/_/g, " ");
}

const LIBELLE_NIVEAU = {
  critical: { texte: "Critique", couleur: COULEURS.crit },
  warning: { texte: "Avertissement", couleur: COULEURS.attention },
  info: { texte: "Information", couleur: COULEURS.doux },
};

function dateCourte(valeur) {
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Écrit le contenu du rapport dans un document pdfkit déjà ouvert.
 * Séparé de la génération pour que la route puisse diffuser en flux
 * (`doc.pipe(res)`) et le planificateur produire un Buffer, sans dupliquer
 * la mise en page.
 */
function composerPdf(doc, { equipements, alertes, dispos }, { titreSuffixe = "" } = {}) {
  const x0 = doc.page.margins.left;
  let page = 1;

  /* Le pied de page ne peut pas être posé par un écouteur « pageAdded »
     seul : la première page existe déjà quand on entre ici. On numérote
     donc à la main, ce qui a l'avantage d'être lisible. */
  const nouvellePage = () => {
    page += 1;
    piedDePage(doc, page);
  };

  // Le pied de la première page est posé tout de suite : dessiné à la fin,
  // il atterrirait sur la DERNIÈRE page, qui a déjà le sien.
  piedDePage(doc, 1);

  /* ── BANDEAU DE TÊTE ── */
  doc.rect(x0, doc.page.margins.top, largeurUtile(doc), 3).fill(COULEURS.accent);

  let y = doc.page.margins.top + 16;
  doc.font("Helvetica-Bold").fontSize(16).fillColor(COULEURS.encre);
  doc.text("Rapport de supervision réseau", x0, y, { lineBreak: false });

  y += 20;
  doc.font("Helvetica").fontSize(9).fillColor(COULEURS.doux);
  doc.text(
    `NetSecureManager${titreSuffixe ? ` — ${titreSuffixe}` : ""}   ·   généré le ${new Date().toLocaleString("fr-FR")}`,
    x0,
    y,
    { lineBreak: false }
  );
  y += 24;

  /* ── LES QUATRE CHIFFRES ── */
  const enLigne = equipements.filter((e) => e.statut === "up").length;
  const horsLigne = equipements.filter((e) => e.statut === "down").length;
  const inconnus = equipements.filter((e) => e.statut === "inconnu").length;
  const actives = alertes.filter((a) => a.statut === "active").length;

  y = cartouches(
    doc,
    [
      { valeur: equipements.length, libelle: "Équipements" },
      { valeur: enLigne, libelle: "En ligne", couleur: COULEURS.ok },
      { valeur: horsLigne, libelle: "Hors ligne", couleur: horsLigne > 0 ? COULEURS.crit : COULEURS.encre },
      { valeur: alertes.length, libelle: "Alertes 30 j", couleur: actives > 0 ? COULEURS.attention : COULEURS.encre },
    ],
    y
  );

  if (inconnus > 0) {
    y = note(
      doc,
      `${inconnus} équipement(s) à l'état inconnu : leur état n'est pas observable (agent muet, site jamais scanné). ` +
        "Ce n'est pas la même chose qu'une panne constatée, et ils ne sont comptés ni en ligne ni hors ligne.",
      y
    );
    y += 4;
  }

  /* ── TABLEAU DES ÉQUIPEMENTS ── */
  y = titreSection(doc, "Équipements", y);

  const couverture =
    equipements.length > 0 ? dispos.get(Number(equipements[0].id_equipement)) : null;

  if (couverture && couverture.couverture_pourcent < 80) {
    y = note(
      doc,
      `Attention : la supervision n'a collecté que ${couverture.couverture_pourcent} % de la période. ` +
        "Les taux de disponibilité ci-dessous sont indicatifs.",
      y,
      COULEURS.crit
    );
  }

  y = note(
    doc,
    "Disponibilité calculée sur 30 jours à partir des alertes d'indisponibilité. Les interruptions " +
      "plus courtes que le seuil d'alerte ne sont pas comptabilisées : ces taux sont des majorants.",
    y
  );
  y += 2;

  const colonnesEquipements = [
    { titre: "Nom", largeur: 150 },
    { titre: "Adresse IP", largeur: 92 },
    { titre: "Fabricant", largeur: 108 },
    { titre: "État", largeur: 68 },
    { titre: "Disponibilité 30 j", largeur: 97, align: "right" },
  ];

  if (equipements.length === 0) {
    y = note(doc, "Aucun équipement dans ce périmètre.", y + 4);
  } else {
    /* Tri par état : ce qui ne va pas se lit en premier. Une liste par
       ordre d'insertion oblige à parcourir soixante-treize lignes pour
       trouver les deux qui posent problème. */
    const rang = { down: 0, inconnu: 1, up: 2 };
    const tries = [...equipements].sort(
      (a, b) => (rang[a.statut] ?? 3) - (rang[b.statut] ?? 3)
    );

    const lignes = tries.map((eq) => {
      const d = dispos.get(Number(eq.id_equipement));
      const etat = LIBELLE_STATUT[eq.statut] || { texte: eq.statut, couleur: COULEURS.doux };
      return [
        { texte: eq.nom || eq.nom_personnalise || "—", gras: true },
        eq.adresse_ip,
        eq.fabricant,
        { texte: etat.texte, couleur: etat.couleur, gras: eq.statut === "down" },
        formaterTaux(d),
      ];
    });

    y = tableau(doc, { colonnes: colonnesEquipements, lignes }, y, nouvellePage);
    y += 18;
  }

  /* ── TABLEAU DES ALERTES ── */
  const basUtile = doc.page.height - doc.page.margins.bottom - RESERVE_PIED;
  if (y + HAUTEUR_ENTETE + HAUTEUR_LIGNE * 2 > basUtile) {
    doc.addPage();
    nouvellePage();
    y = doc.page.margins.top;
  }

  y = titreSection(doc, "Alertes des 30 derniers jours", y);

  if (alertes.length === 0) {
    y = note(doc, "Aucune alerte sur cette période.", y);
  } else {
    const colonnesAlertes = [
      { titre: "Date", largeur: 96 },
      { titre: "Équipement", largeur: 142 },
      { titre: "Type", largeur: 122 },
      { titre: "Niveau", largeur: 88 },
      { titre: "État", largeur: 67 },
    ];

    const MAX = 40;
    const lignes = alertes.slice(0, MAX).map((a) => {
      const niveau = LIBELLE_NIVEAU[a.niveau] || { texte: a.niveau, couleur: COULEURS.doux };
      return [
        dateCourte(a.date_creation),
        a.nom || a.adresse_ip || "site",
        libelleType(a.type_alerte),
        { texte: niveau.texte, couleur: niveau.couleur, gras: a.niveau === "critical" },
        {
          texte: a.statut === "active" ? "Active" : "Résolue",
          couleur: a.statut === "active" ? COULEURS.crit : COULEURS.ok,
        },
      ];
    });

    y = tableau(doc, { colonnes: colonnesAlertes, lignes }, y, nouvellePage);

    if (alertes.length > MAX) {
      y = note(doc, `… et ${alertes.length - MAX} autre(s) alerte(s) non détaillée(s).`, y + 6);
    }
  }

}

/**
 * Génère le PDF complet en mémoire.
 * @returns {Promise<Buffer>}
 */
function genererPdfBuffer(donnees, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const morceaux = [];
      doc.on("data", (c) => morceaux.push(c));
      doc.on("end", () => resolve(Buffer.concat(morceaux)));
      doc.on("error", reject);

      composerPdf(doc, donnees, options);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { collecterDonnees, composerPdf, genererPdfBuffer, formaterTaux };
