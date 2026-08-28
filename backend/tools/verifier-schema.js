/**
 * tools/verifier-schema.js
 *
 * Script de VÉRIFICATION (lecture seule) — ne modifie jamais la base.
 *
 * Compare la structure réelle de la base MySQL avec les colonnes réellement
 * utilisées par le code de backend/src/. À lancer depuis le dossier backend :
 *
 *     node tools/verifier-schema.js
 *
 * Il lit les identifiants depuis backend/.env (DB_HOST, DB_USER, DB_PASS,
 * DB_NAME) et exécute SHOW COLUMNS sur chaque table.
 *
 * Sortie :
 *   - tables manquantes
 *   - colonnes attendues par le code mais absentes de la base  (= requêtes qui plantent)
 *   - colonnes présentes en base mais jamais lues par le code  (= informatif)
 *   - index uniques indispensables aux "ON DUPLICATE KEY UPDATE"
 *
 * Code de sortie 1 si au moins une incohérence bloquante est détectée.
 */

// `quiet: true` supprime la bannière publicitaire de dotenv 17
// (« tip: ... [www.vestauth.com] »). Message inoffensif — dotenv ne
// fait aucun appel réseau — mais une plateforme vendue ne doit pas
// afficher la réclame d'un tiers au démarrage.
require("dotenv").config({ quiet: true });
const mysql = require("mysql2/promise");

/**
 * Colonnes réellement référencées par le code, table par table.
 * Extrait manuellement de l'ensemble des requêtes de backend/src/ lors de
 * l'audit du 10/08/2026.
 */
const ATTENDU = {
  SITE: ["id_site", "nom", "ville", "agent_token"],
  TYPE_EQUIPEMENT: ["id_type", "libelle"],
  EQUIPEMENT: [
    "id_equipement", "id_site", "nom", "adresse_ip", "adresse_mac",
    "fabricant", "sys_descr", "os_detecte", "statut",
    "echecs_consecutifs", "derniere_decouverte",
  ],
  INTERFACE_RESEAU: ["id_interface", "id_equipement", "index_snmp"],
  SERVICE_DETECTE: ["id_equipement", "port", "nom_service", "date_detection"],
  RELEVE: [
    "id_equipement", "date_releve", "latence_ms", "cpu_pourcent",
    "ram_pourcent", "trafic_entrant_kbps", "trafic_sortant_kbps",
  ],
  ALERTE: [
    "id_alerte", "id_equipement", "type_alerte", "niveau", "message",
    "statut", "cause_code", "date_creation", "date_resolution",
  ],
  INCIDENT: [
    "id_incident", "id_alerte", "titre", "description", "statut",
    "date_ouverture", "date_fermeture",
  ],
  UTILISATEUR: [
    "id_utilisateur", "nom", "email", "mot_de_passe_hash", "role",
    "id_site", "telephone_whatsapp",
  ],
  LOG_ACTIVITE: [
    "id_log", "id_utilisateur", "action", "description",
    "adresse_ip_utilisateur", "date_log",
  ],
  VULNERABILITE_CONNUE: ["id_vuln", "cve_id", "service", "port", "severite", "description"],
  CONFIGURATION: ["cle", "valeur", "description"],
  PLAGE_SCAN: ["id_plage", "id_site", "cidr"],
  NOTIFICATION: ["id_notification", "id_alerte", "canal", "date_envoi"],
};

/**
 * Index uniques indispensables : sans eux, les "INSERT ... ON DUPLICATE KEY
 * UPDATE" du code créent des doublons au lieu de mettre à jour.
 */
const UNIQUES_REQUIS = [
  {
    table: "EQUIPEMENT",
    colonnes: ["id_site", "adresse_ip"],
    nom: "uniq_ip_site",
    usage: "routes/scan.js et /api/agent/push",
  },
  {
    table: "SERVICE_DETECTE",
    colonnes: ["id_equipement", "port"],
    nom: "uniq_equip_port",
    usage: "routes/scan.js (services détectés)",
  },
];

/**
 * Contraintes ABSENTES de la base, signalées mais volontairement non
 * appliquées : leur ajout est une décision, pas une correction.
 */
const UNIQUES_RECOMMANDES = [
  {
    table: "INCIDENT",
    colonnes: ["id_alerte"],
    nom: "uk_incident_alerte",
    raison: "escaladeIncidents() s'appuie sur une sous-requête NOT IN ; une contrainte serait un filet supplémentaire",
  },
  {
    table: "VULNERABILITE_CONNUE",
    colonnes: ["cve_id", "port"],
    nom: "uk_vuln_cve_port",
    raison: "sans elle, réexécuter le script d'insertion des CVE crée des doublons",
  },
];

async function main() {
  const manquantes = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME"].filter((c) => !process.env[c]);
  if (manquantes.length) {
    console.error(`Variables absentes de backend/.env : ${manquantes.join(", ")}`);
    process.exit(1);
  }

  let cx;
  try {
    cx = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectTimeout: 8000,
    });
  } catch (err) {
    console.error(`Connexion à MySQL impossible (${err.code || err.message}).`);
    console.error("Vérifiez que le serveur MySQL est démarré et que backend/.env est correct.");
    process.exit(1);
  }

  const [tablesRows] = await cx.query("SHOW TABLES");
  const clefTables = Object.keys(tablesRows[0] || {})[0];
  const tablesReelles = new Set(tablesRows.map((r) => String(r[clefTables]).toUpperCase()));

  let bloquant = 0;

  console.log(`Base : ${process.env.DB_NAME}`);
  console.log(`Tables présentes : ${tablesReelles.size}\n`);
  console.log("=".repeat(70));

  for (const [table, colonnesAttendues] of Object.entries(ATTENDU)) {
    if (!tablesReelles.has(table)) {
      console.log(`\n[TABLE MANQUANTE] ${table}`);
      console.log(`  -> Toute requête sur ${table} échouera (ER_NO_SUCH_TABLE).`);
      bloquant++;
      continue;
    }

    const [cols] = await cx.query(`SHOW COLUMNS FROM \`${table}\``);
    const reelles = cols.map((c) => c.Field);
    const setReelles = new Set(reelles.map((c) => c.toLowerCase()));

    const absentes = colonnesAttendues.filter((c) => !setReelles.has(c.toLowerCase()));
    const inutilisees = reelles.filter(
      (c) => !colonnesAttendues.some((a) => a.toLowerCase() === c.toLowerCase())
    );

    if (absentes.length === 0 && inutilisees.length === 0) {
      console.log(`\n[OK] ${table} — ${reelles.length} colonnes, cohérent avec le code.`);
      continue;
    }

    console.log(`\n[${absentes.length ? "PROBLEME" : "INFO"}] ${table}`);
    if (absentes.length) {
      bloquant++;
      console.log(`  COLONNES ATTENDUES PAR LE CODE MAIS ABSENTES : ${absentes.join(", ")}`);
      console.log(`  -> Les requêtes concernées échoueront (ER_BAD_FIELD_ERROR).`);
      console.log(`  -> Voir la section "Mise à niveau" en bas de backend/schema.sql.`);
    }
    if (inutilisees.length) {
      console.log(`  Colonnes en base jamais lues par le code (informatif) : ${inutilisees.join(", ")}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("\nIndex uniques requis par les 'ON DUPLICATE KEY UPDATE' :\n");

  for (const { table, colonnes, usage } of UNIQUES_REQUIS) {
    if (!tablesReelles.has(table)) continue;

    const [idx] = await cx.query(`SHOW INDEX FROM \`${table}\``);
    const parNom = {};
    for (const i of idx) {
      if (i.Non_unique === 0) {
        (parNom[i.Key_name] = parNom[i.Key_name] || []).push(i.Column_name.toLowerCase());
      }
    }
    const cible = colonnes.map((c) => c.toLowerCase()).sort().join(",");
    const trouve = Object.values(parNom).some((cols) => cols.slice().sort().join(",") === cible);

    if (trouve) {
      console.log(`  [OK] ${table} (${colonnes.join(", ")})`);
    } else {
      bloquant++;
      console.log(`  [MANQUANT] ${table} (${colonnes.join(", ")}) — utilisé par ${usage}`);
      console.log(`     Sans cet index, chaque scan DUPLIQUE les lignes au lieu de les mettre à jour.`);
      console.log(`     Correction : ALTER TABLE ${table} ADD UNIQUE KEY uk_${table.toLowerCase()} (${colonnes.join(", ")});`);
    }
  }

  console.log("\nContraintes RECOMMANDÉES (non bloquantes, à décider) :\n");

  for (const { table, colonnes, nom, raison } of UNIQUES_RECOMMANDES) {
    if (!tablesReelles.has(table)) continue;

    const [idx] = await cx.query(`SHOW INDEX FROM \`${table}\``);
    const parNom = {};
    for (const i of idx) {
      if (i.Non_unique === 0) {
        (parNom[i.Key_name] = parNom[i.Key_name] || []).push(i.Column_name.toLowerCase());
      }
    }
    const cible = colonnes.map((c) => c.toLowerCase()).sort().join(",");
    const trouve = Object.values(parNom).some((cols) => cols.slice().sort().join(",") === cible);

    if (trouve) {
      console.log(`  [présente] ${table} (${colonnes.join(", ")})`);
    } else {
      console.log(`  [absente]  ${table} (${colonnes.join(", ")}) — ${raison}`);
      console.log(`     Doublons actuels : SELECT ${colonnes.join(", ")}, COUNT(*) c FROM ${table} GROUP BY ${colonnes.join(", ")} HAVING c > 1;`);
      console.log(`     Si aucun : ALTER TABLE ${table} ADD UNIQUE KEY ${nom} (${colonnes.join(", ")});`);
    }
  }

  const tablesConnues = new Set(Object.keys(ATTENDU));
  const enTrop = [...tablesReelles].filter((t) => !tablesConnues.has(t));
  if (enTrop.length) {
    console.log(`\nTables en base non référencées par le code : ${enTrop.join(", ")}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    bloquant === 0
      ? "\nRESULTAT : aucune incohérence bloquante détectée.\n"
      : `\nRESULTAT : ${bloquant} incohérence(s) bloquante(s) à corriger.\n`
  );

  await cx.end();
  process.exit(bloquant === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Erreur inattendue :", err);
  process.exit(1);
});
