/**
 * tools/corriger-oui.js
 * Correctif ponctuel : la table OUI_FABRICANT existait déjà sur ce serveur
 * avec une structure antérieure (colonne "prefixe" au lieu de "oui", pas
 * de "date_maj"). Comme elle est vide, on la fait correspondre au schéma
 * attendu sans perte de données.
 *
 * À supprimer une fois exécuté — c'est un correctif, pas un outil permanent.
 *
 *   node tools\corriger-oui.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const db = require("../src/db");

(async () => {
  const [colonnes] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OUI_FABRICANT'`
  );
  const noms = colonnes.map((c) => c.COLUMN_NAME);
  console.log("Colonnes actuelles :", noms.join(", "));

  if (noms.includes("oui")) {
    console.log("Déjà correcte — rien à faire.");
    process.exit(0);
  }
  if (!noms.includes("prefixe")) {
    console.error("Ni « oui » ni « prefixe » trouvée — structure inattendue, correction manuelle requise.");
    process.exit(1);
  }

  await db.query("ALTER TABLE OUI_FABRICANT CHANGE COLUMN prefixe oui CHAR(6) NOT NULL");
  console.log("✓ prefixe → oui");

  if (!noms.includes("date_maj")) {
    await db.query(
      "ALTER TABLE OUI_FABRICANT ADD COLUMN date_maj DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
    );
    console.log("✓ date_maj ajoutée");
  }

  console.log("Terminé. Lancez maintenant : node tools\\importer-oui.js");
  process.exit(0);
})().catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
