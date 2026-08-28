/**
 * routes/scan.js
 * API exposée au frontend React pour lancer un scan et récupérer les équipements.
 */

const express = require("express");
const router = express.Router();
const db = require("../db");
const { getSuggestion } = require("../services/suggestions");
const { requireRole } = require("../middleware/requireRole");
const {
  clauseSite,
  siteAutorise,
  verifierAccesEquipement,
  verifierAccesAlerte,
  verifierAccesIncident,
} = require("../middleware/porteeSite");
const {
  scanRange, scanPorts, wakeOnLan, snmpMetrics, tableCommutation,
} = require("../services/discoveryService");
const {
  construireCorrespondance,
  attribuer,
} = require("../services/attributionPortService");
const { calculerDisponibilite } = require("../services/disponibiliteService");
const { chargerRegistre, resoudreAvecRegistre, etatRegistre } = require("../services/ouiService");
const { determinerType } = require("../services/typeService");
const {
  nettoyerNomPersonnalise,
  validerNomPersonnalise,
} = require("../services/nomPersonnaliseService");

/**
 * Vrai si l'erreur MySQL est « colonne inconnue » (ER_BAD_FIELD_ERROR, 1054).
 *
 * Sert à distinguer une migration non exécutée d'une vraie panne. Une
 * migration en retard doit dégrader l'affichage, jamais faire tomber une
 * page : la plateforme est vendue, et un écran en erreur 500 pendant une
 * démonstration coûte plus cher qu'une colonne manquante.
 *
 * Le repli reste volontairement étroit : seule cette erreur précise est
 * rattrapée, tout le reste continue de remonter.
 */
function colonneManquante(err) {
  return !!err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054);
}

/**
 * Enregistre l'inventaire des interfaces SNMP d'un équipement.
 *
 * Appelée uniquement pendant un scan, jamais depuis le cycle de supervision :
 * voir la note sur `avecInventaire` dans discoveryService.snmpMetrics().
 *
 * Ne remonte jamais d'erreur : un équipement sans SNMP, ou une base dont la
 * table INTERFACE_RESEAU n'a pas encore reçu la colonne index_snmp, ne doit
 * pas faire échouer le scan.
 *
 * Limite connue : snmpTable() ouvre une session v1/v2c. Les équipements
 * configurés en SNMPv3 uniquement ne renverront pas d'interfaces.
 */
async function enregistrerInterfaces(idEquipement, ip, communaute) {
  try {
    const metrics = await snmpMetrics(ip, communaute, { avecInventaire: true });
    const interfaces = (metrics.interfaces || []).filter((i) => i.nom);
    if (interfaces.length === 0) return 0;

    for (const iface of interfaces) {
      await db.query(
        `INSERT INTO INTERFACE_RESEAU
           (id_equipement, index_snmp, nom, adresse_mac, etat_admin, etat_operationnel)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           nom = VALUES(nom),
           adresse_mac = VALUES(adresse_mac),
           etat_admin = VALUES(etat_admin),
           etat_operationnel = VALUES(etat_operationnel)`,
        [
          idEquipement,
          iface.index,
          iface.nom,
          iface.adresseMac,
          iface.etatAdmin,
          iface.etatOperationnel,
        ]
      );
    }
    // ── ATTRIBUTION PAR PORT ──
    //
    // Ne concerne que les commutateurs. On ne le tente donc que si
    // l'équipement a plus de quelques interfaces : interroger la table
    // d'adresses d'un poste ou d'une imprimante coûterait trois
    // interrogations SNMP par machine pour un résultat toujours vide.
    //
    // Le seuil est volontairement bas (4) : un petit switch 5 ports
    // compte peu d'interfaces, et le rater priverait justement les
    // petits parcs de la fonction.
    if (interfaces.length >= 4) {
      await attribuerPorts(idEquipement, ip, communaute).catch((e) =>
        console.error(`Attribution des ports de ${ip} ignorée:`, e.message)
      );
    }

    return interfaces.length;
  } catch (err) {
    console.error(`Inventaire des interfaces de ${ip} ignoré:`, err.message);
    return 0;
  }
}

/**
 * Mémorise qu'une colonne d'attribution manque, pour ne le signaler
 * qu'UNE fois par démarrage plutôt qu'une fois par port, par switch et
 * par scan. Repart à false au redémarrage du serveur, donc après une
 * migration.
 */
let colonneAttributionAbsente = false;

/**
 * Relie chaque port d'un switch à la machine qui y est branchée.
 *
 * C'est ce qui rend la bande passante mesurable pour les machines qui
 * n'exposent aucun SNMP — c'est-à-dire la grande majorité d'un parc.
 * Voir services/attributionPortService.js pour la logique et, surtout,
 * pour ce que le service refuse d'attribuer.
 */
async function attribuerPorts(idSwitch, ip, communaute) {
  const table = await tableCommutation(ip, communaute);

  // On note le résultat MÊME en cas d'échec : sans cette trace, on ne
  // pourrait pas expliquer au client pourquoi son switch ne donne rien,
  // et on chercherait le défaut dans la plateforme.
  await db
    .query(
      "UPDATE EQUIPEMENT SET commutation_exploitable = ?, commutation_raison = ? WHERE id_equipement = ?",
      [table.exploitable ? 1 : 0, table.raison, idSwitch]
    )
    .catch(() => {
      /* migration 2026-08-21 non passée : on continue sans trace */
    });

  if (!table.exploitable) return 0;

  const correspondance = construireCorrespondance(table);

  // Le rattachement se fait sur TOUT le parc, pas seulement le site du
  // switch : une machine peut avoir été découverte depuis un autre
  // point du réseau. La MAC est unique, elle suffit à trancher.
  const [equipements] = await db.query(
    "SELECT id_equipement, adresse_mac FROM EQUIPEMENT WHERE adresse_mac IS NOT NULL"
  );

  const attributions = attribuer(correspondance, equipements);

  let n = 0;
  for (const a of attributions) {
    // Migration 2026-08-21 non passée : inutile de réessayer pour les 47
    // ports suivants, ni de journaliser 48 fois la même ligne. On sort
    // au premier échec de ce type.
    //
    // Sans cette sortie, un switch 48 ports produisait 48 messages
    // d'erreur identiques à CHAQUE scan — le genre de bruit qui apprend
    // à ne plus lire la console.
    if (colonneAttributionAbsente) break;
    try {
      // UPDATE et jamais INSERT : le port doit déjà exister, il vient
      // d'être inventorié juste au-dessus. Un INSERT créerait des ports
      // fantômes pour des interfaces que le switch n'a pas déclarées.
      const [r] = await db.query(
        `UPDATE INTERFACE_RESEAU
         SET id_equipement_connecte = ?, mac_connectee = ?, nb_mac_vues = ?,
             date_attribution = NOW()
         WHERE id_equipement = ? AND index_snmp = ?`,
        [a.id_equipement, a.adresse_mac, a.nb_mac, idSwitch, a.index_snmp]
      );
      n += r.affectedRows;
    } catch (err) {
      if (colonneManquante(err)) {
        colonneAttributionAbsente = true;
        console.warn(
          "\n⚠  Attribution par port DÉSACTIVÉE : colonnes absentes de INTERFACE_RESEAU.\n" +
            "   La bande passante ne sera mesurée que sur les équipements exposant SNMP.\n" +
            "   Pour l'activer : backend/migrations/2026-08-21-attribution-par-port.sql\n"
        );
        break;
      }
      console.error(`Attribution du port ${a.index_snmp} ignorée:`, err.message);
    }
  }
  return n;
}

async function logActivite(req, action, description) {
  try {
    await db.query(
      "INSERT INTO LOG_ACTIVITE (id_utilisateur, action, description, adresse_ip_utilisateur) VALUES (?, ?, ?, ?)",
      [req.user?.id || null, action, description, req.ip]
    );
  } catch (err) {
    console.error("Erreur log activité:", err.message);
  }
}

// Cache des types d'équipement, chargé une seule fois pour éviter une requête
// par équipement scanné. Le référentiel TYPE_EQUIPEMENT est statique.
let cacheTypes = null;

async function getIdType(libelle) {
  if (!cacheTypes) {
    const [rows] = await db.query("SELECT id_type, libelle FROM TYPE_EQUIPEMENT");
    cacheTypes = new Map(rows.map((r) => [r.libelle, r.id_type]));
  }
  if (!libelle) return cacheTypes.get("inconnu") ?? null;
  return cacheTypes.get(libelle) ?? cacheTypes.get("inconnu") ?? null;
}

/**
 * Détermine les paramètres SNMP à utiliser pour un scan.
 * Si la plage est enregistrée dans PLAGE_SCAN pour ce site, ses paramètres
 * font foi (y compris les identifiants SNMPv3, qui ne peuvent pas être saisis
 * depuis le formulaire). Sinon, on retombe sur la communauté du formulaire.
 */
async function resoudreParametresScan(idSite, cidr, communauteFormulaire) {
  const [plages] = await db.query(
    "SELECT * FROM PLAGE_SCAN WHERE id_site = ? AND cidr = ? AND actif = TRUE",
    [idSite, cidr]
  );
  const plage = plages[0];

  if (!plage) {
    return { options: { cidr, snmpCommunity: communauteFormulaire || "public" }, plage: null };
  }

  if (plage.snmp_version === "v3" && plage.snmp_v3_username) {
    return {
      options: {
        cidr,
        snmpV3: {
          username: plage.snmp_v3_username,
          authKey: plage.snmp_v3_auth_key,
          privKey: plage.snmp_v3_priv_key || undefined,
        },
      },
      plage,
    };
  }

  return {
    options: { cidr, snmpCommunity: plage.snmp_community || communauteFormulaire || "public" },
    plage,
  };
}

router.post("/scan", requireRole("admin", "operateur"), async (req, res) => {
  const { id_site, cidr, snmp_community } = req.body;
  if (!id_site || !cidr) {
    return res.status(400).json({ error: "id_site et cidr sont requis" });
  }
  if (!siteAutorise(req, id_site)) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à scanner ce site" });
  }

  try {
    const { options, plage } = await resoudreParametresScan(id_site, cidr, snmp_community);

    const equipements = await scanRange(options);
    await logActivite(req, "scan_lance", `Scan de ${cidr} sur le site ${id_site}`);

    if (plage) {
      // Colonne optionnelle selon l'ancienneté du schéma : on n'échoue pas dessus.
      await db
        .query("UPDATE PLAGE_SCAN SET dernier_scan = NOW() WHERE id_plage = ?", [plage.id_plage])
        .catch(() => {});
    }

    for (const eq of equipements) {
      // L'échec d'un seul équipement ne doit pas annuler tout le scan.
      try {
        const idType = await getIdType(eq.type_detecte);

        await db.query(
          // `type_source` est enregistré au même titre que le type :
          // savoir QUELLE règle a décidé est ce qui permet de défendre
          // une classification devant un client, ou de corriger la bonne
          // règle quand elle se trompe.
          // `type_source` et `nom_source` sont enregistrés au même titre
          // que la valeur qu'ils expliquent : savoir QUELLE règle a
          // décidé est ce qui permet de défendre une classification
          // devant un client, ou de corriger la bonne règle quand elle
          // se trompe.
          //
          // `nom = COALESCE(VALUES(nom), nom)` et non `VALUES(nom)` :
          // la résolution de nom passe par le réseau et échoue par
          // intermittence — poste éteint, pare-feu momentané, perte d'un
          // paquet UDP. Écraser franchement effacerait un nom correct au
          // premier scan malchanceux. On ne remplace donc que par mieux,
          // jamais par du vide.
          `INSERT INTO EQUIPEMENT (id_site, id_type, type_source, nom, nom_source,
                                   adresse_ip, adresse_mac,
                                   fabricant, fabricant_source, sys_descr, os_detecte,
                                   statut, derniere_decouverte)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'up', NOW())
           ON DUPLICATE KEY UPDATE
             id_type = VALUES(id_type), type_source = VALUES(type_source),
             nom = COALESCE(VALUES(nom), nom),
             nom_source = COALESCE(VALUES(nom_source), nom_source),
             adresse_mac = VALUES(adresse_mac),
             fabricant = VALUES(fabricant), fabricant_source = VALUES(fabricant_source),
             sys_descr = VALUES(sys_descr), os_detecte = VALUES(os_detecte),
             statut = 'up', derniere_decouverte = NOW()`,
          [id_site, idType, eq.type_source ?? null, eq.nom, eq.nom_source ?? null,
           eq.adresse_ip, eq.adresse_mac,
           eq.fabricant, eq.fabricant_source ?? null, eq.sys_descr, eq.os_detecte]
        );

        const [rows] = await db.query(
          "SELECT id_equipement FROM EQUIPEMENT WHERE id_site = ? AND adresse_ip = ?",
          [id_site, eq.adresse_ip]
        );
        if (rows.length === 0) {
          console.error(`Équipement ${eq.adresse_ip} introuvable après insertion — services ignorés`);
          continue;
        }
        const idEquipement = rows[0].id_equipement;

        // Les ports ont déjà été scannés par scanRange, qui en a besoin
        // AVANT d'insérer pour classer l'équipement (un port 9100 ouvert
        // suffit à reconnaître une imprimante). On réutilise le résultat
        // plutôt que de scanner une seconde fois.
        const services = eq.services ?? (await scanPorts(eq.adresse_ip));

        // ── UNE SEULE REQUÊTE POUR TOUS LES PORTS ──
        //
        // Chaque port ouvert donnait lieu à son propre INSERT. Sur un
        // parc de 44 machines exposant chacune jusqu'à 19 ports
        // surveillés, cela faisait près de 800 allers-retours vers MySQL
        // par scan — et 9 000 sur un parc de 500 machines.
        //
        // Le coût n'est pas dans l'écriture mais dans la latence : même
        // à 1 ms par requête, on perd une seconde par scan pour un
        // travail qui tient en 44 requêtes groupées.
        if (services.length > 0) {
          await db.query(
            `INSERT INTO SERVICE_DETECTE (id_equipement, port, nom_service)
             VALUES ${services.map(() => "(?, ?, ?)").join(", ")}
             ON DUPLICATE KEY UPDATE nom_service = VALUES(nom_service), date_detection = NOW()`,
            services.flatMap((s) => [idEquipement, s.port, s.nom_service])
          );
        }

        // Inventaire des interfaces : seulement ici, pas dans le cron.
        await enregistrerInterfaces(idEquipement, eq.adresse_ip, options.snmpCommunity || "public");
      } catch (errEq) {
        console.error(`Erreur d'enregistrement pour ${eq.adresse_ip}:`, errEq.message);
      }
    }

    res.json({ message: "Scan terminé", nb_equipements: equipements.length, equipements });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur pendant le scan", details: err.message });
  }
});

/**
 * POST /api/equipements/resoudre-fabricants
 *
 * Renseigne le fabricant des équipements DÉJÀ en base à partir de leur
 * adresse MAC, sans relancer de scan. C'est ce qui permet de passer d'un
 * coup de « Inconnu » partout à un parc identifié, sans attendre le
 * prochain balayage.
 *
 * Ne touche JAMAIS un fabricant obtenu par SNMP : celui-ci est plus fiable
 * que l'OUI (voir la note de priorité dans discoveryService).
 *
 * Paramètre `remplacer_nmap` (défaut true) : écrase aussi les fabricants
 * déduits de nmap, qui sont en réalité des éditeurs d'OS.
 */
router.post("/equipements/resoudre-fabricants", requireRole("admin", "operateur"), async (req, res) => {
  const remplacerNmap = req.body?.remplacer_nmap !== false;
  const portee = clauseSite(req, "e.id_site");

  try {
    const registre = await chargerRegistre();

    const [equipements] = await db.query(
      `SELECT e.id_equipement, e.adresse_ip, e.adresse_mac, e.fabricant,
              e.fabricant_source, e.id_type, t.libelle AS type_libelle
       FROM EQUIPEMENT e
       LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
       WHERE e.adresse_mac IS NOT NULL AND ${portee.clause}`,
      portee.params
    );

    const bilan = {
      examines: equipements.length,
      resolus: 0,
      types_enrichis: 0,
      mac_aleatoires: 0,
      oui_inconnus: 0,
      conserves_snmp: 0,
    };

    for (const eq of equipements) {
      // Le fabricant SNMP fait foi : on n'y touche pas.
      if (eq.fabricant_source === "snmp") {
        bilan.conserves_snmp++;
        continue;
      }
      // Un fabricant déjà résolu par OUI n'a pas besoin d'être refait,
      // sauf si le registre a changé — c'est bien le cas ici, on recalcule.
      if (eq.fabricant_source === "nmap" && !remplacerNmap) continue;

      const r = resoudreAvecRegistre(eq.adresse_mac, registre);

      if (r.aleatoire) {
        bilan.mac_aleatoires++;
        // Marqué explicitement : « pas identifiable » n'est pas « pas encore
        // regardé ». Sans cela, chaque rattrapage réessaierait pour rien.
        await db.query(
          "UPDATE EQUIPEMENT SET fabricant = NULL, fabricant_source = 'mac_aleatoire' WHERE id_equipement = ?",
          [eq.id_equipement]
        );
        continue;
      }

      if (!r.fabricant) {
        bilan.oui_inconnus++;
        continue;
      }

      let idType = eq.id_type;
      if (r.type_suggere && (!eq.type_libelle || ["inconnu", "detecte_nmap"].includes(eq.type_libelle))) {
        const nouveau = await getIdType(r.type_suggere);
        if (nouveau && nouveau !== eq.id_type) {
          idType = nouveau;
          bilan.types_enrichis++;
        }
      }

      await db.query(
        "UPDATE EQUIPEMENT SET fabricant = ?, fabricant_source = 'oui', id_type = ? WHERE id_equipement = ?",
        [r.fabricant, idType, eq.id_equipement]
      );
      bilan.resolus++;
    }

    await logActivite(
      req,
      "fabricants_resolus",
      `Résolution OUI : ${bilan.resolus} fabricant(s) identifié(s) sur ${bilan.examines} équipement(s)`
    );

    const etat = await etatRegistre();
    res.json({ ...bilan, registre: etat });
  } catch (err) {
    console.error("Résolution des fabricants impossible:", err);
    res.status(500).json({ error: "Résolution impossible", details: err.message });
  }
});

/**
 * POST /api/equipements/reclasser-types
 *
 * Rejoue la classification sur les équipements DÉJÀ en base, sans rescan.
 *
 * Tout ce dont `determinerType()` a besoin est déjà stocké : `sys_descr`
 * pour le texte SNMP, `os_detecte` pour le résultat nmap, les ports dans
 * SERVICE_DETECTE, et `fabricant` pour la déduction par constructeur. Un
 * nouveau balayage réseau n'apporterait rien de plus.
 *
 * Seule limite : les équipements découverts AVANT l'ajout des ports 9100,
 * 515, 631 et 554 n'ont pas ces ports dans SERVICE_DETECTE. La déduction
 * par port ne s'appliquera à eux qu'après un prochain scan. Le bilan le
 * signale.
 */
router.post("/equipements/reclasser-types", requireRole("admin", "operateur"), async (req, res) => {
  const portee = clauseSite(req, "e.id_site");

  try {
    const [equipements] = await db.query(
      `SELECT e.id_equipement, e.adresse_ip, e.sys_descr, e.os_detecte,
              e.fabricant, e.id_type, t.libelle AS type_actuel
       FROM EQUIPEMENT e
       LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
       WHERE ${portee.clause}`,
      portee.params
    );

    // Tous les ports en une requête plutôt qu'une par équipement.
    const [tousServices] = await db.query(
      `SELECT s.id_equipement, s.port
       FROM SERVICE_DETECTE s
       JOIN EQUIPEMENT e ON e.id_equipement = s.id_equipement
       WHERE ${portee.clause}`,
      portee.params
    );
    const portsParEquipement = new Map();
    for (const s of tousServices) {
      if (!portsParEquipement.has(s.id_equipement)) portsParEquipement.set(s.id_equipement, []);
      portsParEquipement.get(s.id_equipement).push(s.port);
    }

    const bilan = {
      examines: equipements.length,
      modifies: 0,
      inchanges: 0,
      passes_en_inconnu: 0,
      sans_port_scanne: 0,
      par_type: {},
      par_source: {},
    };

    for (const eq of equipements) {
      const ports = portsParEquipement.get(eq.id_equipement) || [];
      if (ports.length === 0) bilan.sans_port_scanne++;

      const { type, source } = determinerType({
        sysDescr: eq.sys_descr,
        sysName: null, // non conservé en base
        osDetecte: eq.os_detecte,
        nmapDeviceType: null, // non conservé en base
        ports,
        fabricant: eq.fabricant,
      });

      bilan.par_type[type] = (bilan.par_type[type] || 0) + 1;
      bilan.par_source[source] = (bilan.par_source[source] || 0) + 1;

      if (type === eq.type_actuel) {
        // Le type ne change pas, mais la SOURCE peut être inconnue en
        // base (équipements enregistrés avant que cette trace existe).
        // On la renseigne quand même : sans elle, un reclassement laisse
        // la moitié du parc sans explication de son type.
        await db
          .query("UPDATE EQUIPEMENT SET type_source = ? WHERE id_equipement = ?", [
            source,
            eq.id_equipement,
          ])
          .catch(() => {});
        bilan.inchanges++;
        continue;
      }

      const idType = await getIdType(type);
      if (!idType) continue;

      await db.query("UPDATE EQUIPEMENT SET id_type = ?, type_source = ? WHERE id_equipement = ?", [
        idType,
        source,
        eq.id_equipement,
      ]);
      bilan.modifies++;

      // Un équipement qui passe d'une catégorie affirmée à « inconnu » est
      // une correction volontaire : on préfère l'absence de réponse à une
      // réponse fausse. Compté à part pour que ce ne soit pas une surprise.
      if (type === "inconnu" && eq.type_actuel && eq.type_actuel !== "inconnu") {
        bilan.passes_en_inconnu++;
      }
    }

    await logActivite(
      req,
      "types_reclasses",
      `Reclassement : ${bilan.modifies} type(s) corrigé(s) sur ${bilan.examines} équipement(s)`
    );

    res.json(bilan);
  } catch (err) {
    console.error("Reclassement des types impossible:", err);
    res.status(500).json({ error: "Reclassement impossible", details: err.message });
  }
});

/**
 * GET /api/bande-passante/classement?heures=24&limite=20
 *
 * Les plus gros consommateurs sur la période. Le classement se fait sur la
 * MOYENNE et non sur le pic : un pic isolé de sauvegarde ne doit pas
 * masquer une machine qui sature le lien en permanence. Le pic est
 * néanmoins renvoyé, il répond à une autre question.
 */
router.get("/bande-passante/classement", async (req, res) => {
  let heures = Number(req.query.heures);
  if (!Number.isFinite(heures) || heures <= 0) heures = 24;
  heures = Math.min(Math.floor(heures), 24 * 30);

  let limite = Number(req.query.limite);
  if (!Number.isFinite(limite) || limite <= 0) limite = 20;
  limite = Math.min(Math.floor(limite), 100);

  const portee = clauseSite(req, "e.id_site");

  const [rows] = await db.query(
    `SELECT e.id_equipement, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip, e.statut, e.fabricant,
            t.libelle AS type_equipement, s.nom AS site_nom,
            AVG(r.trafic_entrant_kbps) AS moy_entrant,
            AVG(r.trafic_sortant_kbps) AS moy_sortant,
            MAX(r.trafic_entrant_kbps) AS pic_entrant,
            MAX(r.trafic_sortant_kbps) AS pic_sortant,
            COUNT(r.id_releve) AS releves
     FROM RELEVE r
     JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
     LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
     LEFT JOIN SITE s ON s.id_site = e.id_site
     WHERE r.date_releve >= NOW() - INTERVAL ${heures} HOUR
       AND (r.trafic_entrant_kbps IS NOT NULL OR r.trafic_sortant_kbps IS NOT NULL)
       AND ${portee.clause}
     GROUP BY e.id_equipement, e.nom_personnalise, e.nom, e.adresse_ip, e.statut, e.fabricant, t.libelle, s.nom
     ORDER BY (COALESCE(AVG(r.trafic_entrant_kbps),0) + COALESCE(AVG(r.trafic_sortant_kbps),0)) DESC
     LIMIT ${limite}`,
    portee.params
  );

  // ── REPLI : LA MESURE PAR PORT DE SWITCH ──
  //
  // Le classement ci-dessus ne voit que les équipements qui exposent
  // SNMP. Sur un parc courant, c'est une machine sur dix.
  //
  // Pour toutes les autres, le switch connaît déjà la réponse : le
  // compteur du port sur lequel la machine est branchée EST sa
  // consommation. On complète donc le classement avec ces mesures, en
  // écartant les équipements déjà présents — le SNMP direct reste
  // prioritaire, il mesure la carte réseau plutôt que la prise.
  const dejaClasses = new Set(rows.map((r) => r.id_equipement));

  const [parPort] = await db
    .query(
      `SELECT e.id_equipement, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip, e.statut, e.fabricant,
              t.libelle AS type_equipement, s.nom AS site_nom,
              i.trafic_entrant_kbps AS moy_entrant,
              i.trafic_sortant_kbps AS moy_sortant,
              i.trafic_entrant_kbps AS pic_entrant,
              i.trafic_sortant_kbps AS pic_sortant,
              i.date_trafic,
              sw.nom AS switch_nom, i.nom AS port_nom
       FROM INTERFACE_RESEAU i
       JOIN EQUIPEMENT e ON e.id_equipement = i.id_equipement_connecte
       JOIN EQUIPEMENT sw ON sw.id_equipement = i.id_equipement
       LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
       LEFT JOIN SITE s ON s.id_site = e.id_site
       WHERE i.id_equipement_connecte IS NOT NULL
         AND i.nb_mac_vues = 1
         AND (i.trafic_entrant_kbps IS NOT NULL OR i.trafic_sortant_kbps IS NOT NULL)
         AND ${portee.clause}
       ORDER BY COALESCE(i.trafic_entrant_kbps, 0) + COALESCE(i.trafic_sortant_kbps, 0) DESC
       LIMIT ${limite}`,
      portee.params
    )
    // Migration 2026-08-21 non passée : le classement se limite au SNMP
    // direct, exactement comme avant. Aucune erreur affichée.
    .catch(() => [[]]);

  // Combien d'équipements pourraient figurer au classement mais n'ont
  // aucune mesure ? Sans ce chiffre, un classement vide ressemble à une
  // panne alors qu'il traduit simplement l'absence de SNMP sur le parc.
  const porteeTotal = clauseSite(req, "id_site");
  const [[couverture]] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(EXISTS (
              SELECT 1 FROM RELEVE r2
              WHERE r2.id_equipement = EQUIPEMENT.id_equipement
                AND r2.date_releve >= NOW() - INTERVAL ${heures} HOUR
                AND r2.trafic_entrant_kbps IS NOT NULL
            )) AS avec_mesure
     FROM EQUIPEMENT WHERE ${porteeTotal.clause}`,
    porteeTotal.params
  );

  res.json({
    periode_heures: heures,
    couverture: {
      equipements: Number(couverture.total || 0),
      avec_mesure: Number(couverture.avec_mesure || 0),
    },
    classement: [
      ...rows.map((r) => ({
        ...r,
        source: "snmp",
        moy_entrant: r.moy_entrant === null ? null : Number(r.moy_entrant),
        moy_sortant: r.moy_sortant === null ? null : Number(r.moy_sortant),
        pic_entrant: r.pic_entrant === null ? null : Number(r.pic_entrant),
        pic_sortant: r.pic_sortant === null ? null : Number(r.pic_sortant),
        // Le total d'un switch est la somme de ses ports, pas son débit de
        // transit : le frontend doit pouvoir le signaler.
        total_cumule_ports:
          r.type_equipement === "routeur/switch" || r.type_equipement === "routeur",
      })),
      ...parPort
        .filter((r) => !dejaClasses.has(r.id_equipement))
        .map((r) => ({
          ...r,
          // L'interface affiche la source. Sans elle, un client comparant
          // deux machines mesurées différemment conclurait à une
          // incohérence du produit — alors que les deux chiffres sont
          // justes, simplement pas obtenus au même endroit.
          source: "port",
          moy_entrant: r.moy_entrant === null ? null : Number(r.moy_entrant),
          moy_sortant: r.moy_sortant === null ? null : Number(r.moy_sortant),
          pic_entrant: r.pic_entrant === null ? null : Number(r.pic_entrant),
          pic_sortant: r.pic_sortant === null ? null : Number(r.pic_sortant),
          // La mesure du port est un instantané, pas une moyenne sur la
          // période : la nuance est dite dans l'interface plutôt que
          // masquée derrière une colonne au même intitulé.
          instantane: true,
          releves: 1,
          total_cumule_ports: false,
        })),
    ].sort(
      (a, b) =>
        (b.moy_entrant ?? 0) + (b.moy_sortant ?? 0) - ((a.moy_entrant ?? 0) + (a.moy_sortant ?? 0))
    ),
  });
});

/**
 * GET /api/equipements/:id/bande-passante?heures=24
 * Historique du débit d'un équipement, pour le graphique de sa fiche.
 */
router.get("/equipements/:id/bande-passante", async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  let heures = Number(req.query.heures);
  if (!Number.isFinite(heures) || heures <= 0) heures = 24;
  heures = Math.min(Math.floor(heures), 24 * 30);

  const [historique] = await db.query(
    `SELECT date_releve, trafic_entrant_kbps, trafic_sortant_kbps
     FROM RELEVE
     WHERE id_equipement = ? AND date_releve >= NOW() - INTERVAL ${heures} HOUR
       AND (trafic_entrant_kbps IS NOT NULL OR trafic_sortant_kbps IS NOT NULL)
     ORDER BY date_releve ASC`,
    [req.params.id]
  );

  // Détail par port : c'est ce qui permet de dire QUEL port d'un switch
  // sature, une fois qu'on sait que le switch sature.
  const [interfaces] = await db.query(
    `SELECT nom, index_snmp, vitesse_mbps, etat_operationnel,
            trafic_entrant_kbps, trafic_sortant_kbps, date_trafic
     FROM INTERFACE_RESEAU
     WHERE id_equipement = ?
     ORDER BY index_snmp`,
    [req.params.id]
  ).catch(() => [[]]);

  res.json({ periode_heures: heures, historique, interfaces });
});

/** État du registre OUI, pour diagnostic. */
router.get("/oui/etat", async (req, res) => {
  res.json(await etatRegistre());
});

router.get("/equipements", async (req, res) => {
  const { id_site } = req.query;
  const portee = clauseSite(req, "e.id_site");
  const [rows] = await db.query(
    `SELECT e.*, t.libelle AS type_libelle
     FROM EQUIPEMENT e
     LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
     WHERE (? IS NULL OR e.id_site = ?) AND ${portee.clause}`,
    [id_site || null, id_site || null, ...portee.params]
  );
  res.json(rows);
});

/**
 * PATCH /api/equipements/:id/nom
 * body : { nom_personnalise: "Imprimante comptabilité" }  ou  { nom_personnalise: null }
 *
 * Les noms découverts sont techniquement corrects et humainement
 * illisibles : « KMBFD6FC », « NPI4DDD0A ». Cette route permet à
 * l'exploitant de nommer ses équipements comme il les désigne
 * réellement.
 *
 * Le nom personnalisé va dans SA PROPRE colonne, jamais dans `nom` :
 * celle-ci est réécrite à chaque scan, et une saisie manuelle y serait
 * effacée sans explication au passage suivant.
 *
 * Envoyer une chaîne vide ou null efface le nom personnalisé et fait
 * réapparaître le nom découvert — il n'y a donc pas de route de
 * suppression séparée à retenir.
 */
router.patch("/equipements/:id/nom", requireRole("admin", "operateur"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Identifiant d'équipement invalide" });
  }

  const nom = nettoyerNomPersonnalise(req.body?.nom_personnalise);
  const probleme = validerNomPersonnalise(nom);
  if (probleme) return res.status(400).json({ error: probleme });

  // Le cloisonnement est appliqué DANS la requête, comme pour
  // l'acquittement des alertes : impossible de renommer l'équipement
  // d'un site auquel on n'a pas accès, même en forgeant l'identifiant.
  const portee = clauseSite(req, "id_site");
  const [resultat] = await db.query(
    `UPDATE EQUIPEMENT SET nom_personnalise = ?
     WHERE id_equipement = ? AND ${portee.clause}`,
    [nom, id, ...portee.params]
  );

  if (resultat.affectedRows === 0) {
    // Même réponse que l'équipement n'existe pas ou qu'il appartienne à
    // un autre site : distinguer les deux révélerait l'existence
    // d'équipements hors de la portée de l'utilisateur.
    return res.status(404).json({ error: "Équipement introuvable" });
  }

  await logActivite(
    req,
    "equipement_renomme",
    nom
      ? `Équipement ${id} renommé « ${nom} »`
      : `Nom personnalisé de l'équipement ${id} effacé`
  );

  res.json({ id_equipement: id, nom_personnalise: nom });
});

/**
 * PATCH /api/alertes/acquitter
 *
 * Acquittement de masse. body : { ids: [1, 2, 3] }
 *
 * ACQUITTER N'EST PAS SUPPRIMER. L'alerte passe en « traitee » et reste
 * en base : elle continue d'alimenter le taux de disponibilité et les
 * graphiques. Elle sort simplement de la file de tri quotidienne.
 *
 * Une alerte acquittée dont le problème persiste continue d'incrémenter
 * son compteur d'occurrences sans ressortir : l'opérateur a dit qu'il
 * s'en occupait, on ne le harcèle pas.
 */
router.patch("/alertes/acquitter", requireRole("admin", "operateur"), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) {
    return res.status(400).json({ error: "Aucune alerte sélectionnée" });
  }

  const portee = clauseSite(req, "COALESCE(a.id_site, e.id_site)");
  const placeholders = ids.map(() => "?").join(",");

  // Le cloisonnement est appliqué dans la requête elle-même : impossible
  // d'acquitter l'alerte d'un site auquel on n'a pas accès, même en
  // forgeant les identifiants.
  const [result] = await db.query(
    `UPDATE ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     SET a.statut = 'traitee', a.date_acquittement = NOW(), a.acquittee_par = ?
     WHERE a.id_alerte IN (${placeholders})
       AND a.statut = 'active'
       AND ${portee.clause}`,
    [req.user?.id || null, ...ids, ...portee.params]
  );

  await logActivite(req, "alertes_acquittees", `${result.affectedRows} alerte(s) acquittée(s)`);
  res.json({ acquittees: result.affectedRows, demandees: ids.length });
});

/** Réouvre une alerte acquittée à tort. */
router.patch("/alertes/reactiver", requireRole("admin", "operateur"), async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length === 0) return res.status(400).json({ error: "Aucune alerte sélectionnée" });

  const portee = clauseSite(req, "COALESCE(a.id_site, e.id_site)");
  const placeholders = ids.map(() => "?").join(",");
  const [result] = await db.query(
    `UPDATE ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     SET a.statut = 'active', a.date_acquittement = NULL, a.acquittee_par = NULL
     WHERE a.id_alerte IN (${placeholders}) AND a.statut = 'traitee' AND ${portee.clause}`,
    [...ids, ...portee.params]
  );
  res.json({ reactivees: result.affectedRows });
});

router.get("/alertes", async (req, res) => {
  const { statut } = req.query;
  // LEFT JOIN : les alertes d'agent muet ne sont rattachées à aucun
  // équipement (id_equipement NULL). Un INNER JOIN les ferait disparaître.
  const portee = clauseSite(req, "COALESCE(a.id_site, e.id_site)");
  const [rows] = await db.query(
    `SELECT a.*, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip, e.statut AS statut_equipement,
            COALESCE(a.id_site, e.id_site) AS id_site,
            s.nom AS site_nom, u.nom AS acquittee_par_nom,
            t.libelle AS type_equipement
     FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
     LEFT JOIN SITE s ON s.id_site = COALESCE(a.id_site, e.id_site)
     LEFT JOIN UTILISATEUR u ON u.id_utilisateur = a.acquittee_par
     WHERE (? IS NULL OR a.statut = ?) AND ${portee.clause}
     ORDER BY
       FIELD(a.niveau, 'critical', 'warning', 'info'),
       a.derniere_occurrence DESC, a.date_creation DESC`,
    [statut || null, statut || null, ...portee.params]
  ).catch((err) => {
    // Migration 2026-08-18-alertes-acquittement non passée : la colonne
    // derniere_occurrence n'existe pas encore. La liste des alertes est
    // une page centrale de la plateforme — elle doit s'afficher, même
    // triée seulement par date de création.
    if (!colonneManquante(err)) throw err;
    return db.query(
      // `e.nom` NU, et non COALESCE(nom_personnalise, nom) comme dans
      // la requête principale : ce repli existe précisément pour le cas
      // où une colonne manque. Y référencer une colonne récente le
      // ferait échouer à son tour, et la page Alertes — l'une des plus
      // consultées — tomberait au lieu de s'afficher en mode dégradé.
      `SELECT a.*, e.nom, e.adresse_ip, e.statut AS statut_equipement,
              COALESCE(a.id_site, e.id_site) AS id_site,
              s.nom AS site_nom, t.libelle AS type_equipement
       FROM ALERTE a
       LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
       LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
       LEFT JOIN SITE s ON s.id_site = COALESCE(a.id_site, e.id_site)
       WHERE (? IS NULL OR a.statut = ?) AND ${portee.clause}
       ORDER BY FIELD(a.niveau, 'critical', 'warning', 'info'), a.date_creation DESC`,
      [statut || null, statut || null, ...portee.params]
    );
  });
  const enrichies = rows.map((a) => ({ ...a, suggestions: getSuggestion(a.cause_code) }));
  res.json(enrichies);
});

/**
 * GET /api/alertes/resume
 * Compteurs par statut et par niveau, pour le tableau de bord.
 * Une seule requête plutôt que de faire compter le frontend sur une liste
 * qu'il faudrait charger entièrement.
 */
router.get("/alertes/resume", async (req, res) => {
  const portee = clauseSite(req, "COALESCE(a.id_site, e.id_site)");
  const [rows] = await db.query(
    `SELECT a.statut, a.niveau, COUNT(*) AS nb, SUM(a.occurrences) AS occurrences
     FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE ${portee.clause}
     GROUP BY a.statut, a.niveau`,
    portee.params
  ).catch((err) => {
    // Sans la colonne occurrences, le compte des alertes reste juste :
    // seul le cumul des répétitions est indisponible.
    if (!colonneManquante(err)) throw err;
    return db.query(
      `SELECT a.statut, a.niveau, COUNT(*) AS nb, NULL AS occurrences
       FROM ALERTE a
       LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
       WHERE ${portee.clause}
       GROUP BY a.statut, a.niveau`,
      portee.params
    );
  });

  const resume = {
    active: { total: 0, critical: 0, warning: 0, info: 0, occurrences: 0 },
    traitee: { total: 0, critical: 0, warning: 0, info: 0, occurrences: 0 },
    resolue: { total: 0, critical: 0, warning: 0, info: 0, occurrences: 0 },
  };
  for (const r of rows) {
    const bloc = resume[r.statut];
    if (!bloc) continue;
    bloc.total += Number(r.nb);
    bloc[r.niveau] = (bloc[r.niveau] || 0) + Number(r.nb);
    bloc.occurrences += Number(r.occurrences || 0);
  }
  res.json(resume);
});

// Appelée par AlertesPage.jsx ("Marquer résolue"). Cette route était absente
// côté backend : le frontend recevait un 404 et l'alerte restait active.
router.patch("/alertes/:id/resoudre", requireRole("admin", "operateur"), async (req, res) => {
  const acces = await verifierAccesAlerte(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const [result] = await db.query(
    `UPDATE ALERTE SET statut = 'resolue', date_resolution = NOW()
     WHERE id_alerte = ? AND statut = 'active'`,
    [req.params.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Alerte introuvable ou déjà résolue" });
  }
  await logActivite(req, "alerte_resolue", `Alerte #${req.params.id} marquée résolue`);
  res.json({ message: "Alerte résolue" });
});

router.get("/incidents", async (req, res) => {
  const { statut } = req.query;
  const portee = clauseSite(req, "COALESCE(a.id_site, e.id_site)");
  const [rows] = await db.query(
    `SELECT i.*, a.type_alerte, a.niveau, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip,
            COALESCE(a.id_site, e.id_site) AS id_site,
            u.nom AS assigne_nom, u.email AS assigne_email
     FROM INCIDENT i
     JOIN ALERTE a ON a.id_alerte = i.id_alerte
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     LEFT JOIN UTILISATEUR u ON u.id_utilisateur = i.id_utilisateur_assigne
     WHERE (? IS NULL OR i.statut = ?) AND ${portee.clause}
     ORDER BY i.date_ouverture DESC`,
    [statut || null, statut || null, ...portee.params]
  );
  res.json(rows);
});

/**
 * Assigne un incident à un utilisateur, ou le désassigne si id_utilisateur
 * vaut null. La colonne INCIDENT.id_utilisateur_assigne est en ON DELETE SET
 * NULL : supprimer un compte ne supprime pas ses incidents.
 */
router.patch("/incidents/:id/assigner", requireRole("admin", "operateur"), async (req, res) => {
  const { id_utilisateur } = req.body;

  const acces = await verifierAccesIncident(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  if (id_utilisateur !== null && id_utilisateur !== undefined) {
    const [users] = await db.query(
      "SELECT id_utilisateur FROM UTILISATEUR WHERE id_utilisateur = ?",
      [id_utilisateur]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
  }

  const cible = id_utilisateur || null;
  const [result] = await db.query(
    "UPDATE INCIDENT SET id_utilisateur_assigne = ? WHERE id_incident = ?",
    [cible, req.params.id]
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Incident introuvable" });
  }

  await logActivite(
    req,
    "incident_assigne",
    cible
      ? `Incident #${req.params.id} assigné à l'utilisateur #${cible}`
      : `Incident #${req.params.id} désassigné`
  );
  res.json({ message: cible ? "Incident assigné" : "Incident désassigné" });
});

// NOTE : GET /api/utilisateurs vivait ici. Elle a été déplacée dans
// routes/utilisateurs.js avec le reste du CRUD, en conservant exactement le
// même périmètre (comptes du site + comptes globaux) pour ne pas casser le
// menu d'assignation d'IncidentsPage.

router.patch("/incidents/:id", requireRole("admin", "operateur"), async (req, res) => {
  const { statut } = req.body;
  if (!["ouvert", "en_cours", "ferme"].includes(statut)) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  const acces = await verifierAccesIncident(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const dateFerme = statut === "ferme" ? ", date_fermeture = NOW()" : "";
  await db.query(
    `UPDATE INCIDENT SET statut = ?${dateFerme} WHERE id_incident = ?`,
    [statut, req.params.id]
  );
  await logActivite(req, "incident_modifie", `Incident #${req.params.id} passé à "${statut}"`);
  res.json({ message: "Incident mis à jour" });
});

router.get("/equipements/:id/services", async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const [rows] = await db.query(
    "SELECT port, nom_service, date_detection FROM SERVICE_DETECTE WHERE id_equipement = ? ORDER BY port",
    [req.params.id]
  );
  res.json(rows);
});

router.get("/equipements/:id/interfaces", async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  // Projection explicite, jamais SELECT * : la fiche d'équipement est
  // consultable par tous les rôles, et une colonne ajoutée un jour à
  // INTERFACE_RESEAU ne doit pas se retrouver exposée sans décision.
  //
  // Le tri se fait sur index_snmp et non sur le nom : « Gi0/10 » se place
  // entre « Gi0/1 » et « Gi0/2 » dans un tri alphabétique, ce qui donne un
  // ordre de ports incompréhensible sur un switch.
  const [rows] = await db
    .query(
      `SELECT id_interface, index_snmp, nom, adresse_mac, vlan,
              etat_admin, etat_operationnel,
              vitesse_mbps, trafic_entrant_kbps, trafic_sortant_kbps, date_trafic
       FROM INTERFACE_RESEAU
       WHERE id_equipement = ?
       ORDER BY index_snmp, nom`,
      [req.params.id]
    )
    // Repli tant que la migration 2026-08-18-bande-passante n'est pas
    // passée : la fiche continue d'afficher les interfaces sans le débit,
    // plutôt que de renvoyer une erreur sur une colonne inconnue.
    .catch(() =>
      db.query(
        `SELECT id_interface, nom, adresse_mac, vlan, etat_admin, etat_operationnel
         FROM INTERFACE_RESEAU
         WHERE id_equipement = ?
         ORDER BY nom`,
        [req.params.id]
      )
    );
  res.json(rows);
});

/**
 * Taux de disponibilité sur une période (paramètre `jours`, 30 par défaut).
 * La réponse porte toujours son propre niveau de fiabilité : voir
 * services/disponibiliteService.js pour la méthode et ses limites.
 */
router.get("/equipements/:id/disponibilite", async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const resultat = await calculerDisponibilite(req.params.id, req.query.jours);
  if (!resultat) {
    return res.status(404).json({ error: "Équipement introuvable" });
  }
  res.json(resultat);
});

router.get("/equipements/:id/releves", async (req, res) => {
  // INTERVAL n'accepte pas de placeholder préparé de façon fiable : on valide
  // et on borne la valeur nous-mêmes avant de l'injecter.
  let heures = Number(req.query.heures);
  if (!Number.isFinite(heures) || heures <= 0) heures = 24;
  heures = Math.min(Math.floor(heures), 24 * 30);

  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const [rows] = await db.query(
    `SELECT date_releve, cpu_pourcent, ram_pourcent, latence_ms, trafic_entrant_kbps, trafic_sortant_kbps
     FROM RELEVE
     WHERE id_equipement = ? AND date_releve >= NOW() - INTERVAL ${heures} HOUR
     ORDER BY date_releve ASC`,
    [req.params.id]
  );
  res.json(rows);
});

router.post("/equipements/:id/reveiller", requireRole("admin", "operateur"), async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const [rows] = await db.query("SELECT adresse_mac, nom, adresse_ip FROM EQUIPEMENT WHERE id_equipement = ?", [req.params.id]);
  const eq = rows[0];

  if (!eq) {
    return res.status(404).json({ error: "Équipement introuvable" });
  }
  if (!eq.adresse_mac) {
    return res.status(400).json({ error: "Adresse MAC inconnue pour cet équipement — rescannez-le d'abord (via ARP)" });
  }

  try {
    await wakeOnLan(eq.adresse_mac);
    res.json({ message: `Paquet de réveil envoyé à ${eq.nom || eq.adresse_ip}` });
  } catch (err) {
    res.status(500).json({ error: "Échec de l'envoi du paquet de réveil", details: err.message });
  }
});

router.get("/equipements/:id/vulnerabilites", async (req, res) => {
  const acces = await verifierAccesEquipement(req, req.params.id);
  if (!acces.ok) return res.status(acces.statut).json({ error: acces.erreur });

  const [services] = await db.query(
    "SELECT port, nom_service FROM SERVICE_DETECTE WHERE id_equipement = ?",
    [req.params.id]
  );

  if (services.length === 0) {
    return res.json([]);
  }

  const ports = services.map((s) => s.port);
  const placeholders = ports.map(() => "?").join(",");
  const [vulns] = await db.query(
    `SELECT * FROM VULNERABILITE_CONNUE WHERE port IN (${placeholders})`,
    ports
  );

  res.json(vulns);
});

router.get("/logs", requireRole("admin"), async (req, res) => {
  // Un admin rattaché à un site ne voit que l'activité des comptes de son
  // site (et celle des comptes globaux). Un admin global voit tout.
  const portee = clauseSite(req, "u.id_site");
  const [rows] = await db.query(
    `SELECT l.*, u.nom, u.email FROM LOG_ACTIVITE l
     LEFT JOIN UTILISATEUR u ON u.id_utilisateur = l.id_utilisateur
     WHERE ${portee.clause} OR u.id_site IS NULL OR l.id_utilisateur IS NULL
     ORDER BY l.date_log DESC LIMIT 200`,
    portee.params
  );
  res.json(rows);
});

router.get("/recherche", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json({ equipements: [], alertes: [], incidents: [] });
  }
  const terme = `%${q.trim()}%`;
  const pEq = clauseSite(req, "id_site");
  const pAl = clauseSite(req, "COALESCE(a.id_site, e.id_site)");

  const [equipements] = await db.query(
    `SELECT id_equipement, nom, adresse_ip, fabricant, statut FROM EQUIPEMENT
     WHERE (nom LIKE ? OR adresse_ip LIKE ? OR fabricant LIKE ?)
       AND ${pEq.clause}
     LIMIT 10`,
    [terme, terme, terme, ...pEq.params]
  );

  const [alertes] = await db.query(
    `SELECT a.id_alerte, a.message, a.niveau, a.statut, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip FROM ALERTE a
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE (a.message LIKE ? OR e.nom LIKE ? OR e.adresse_ip LIKE ?)
       AND ${pAl.clause}
     LIMIT 10`,
    [terme, terme, terme, ...pAl.params]
  );

  const [incidents] = await db.query(
    `SELECT i.id_incident, i.titre, i.statut, COALESCE(e.nom_personnalise, e.nom) AS nom, e.adresse_ip FROM INCIDENT i
     JOIN ALERTE a ON a.id_alerte = i.id_alerte
     LEFT JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
     WHERE (i.titre LIKE ? OR e.nom LIKE ? OR e.adresse_ip LIKE ?)
       AND ${pAl.clause}
     LIMIT 10`,
    [terme, terme, terme, ...pAl.params]
  );

  res.json({ equipements, alertes, incidents });
});

module.exports = router;