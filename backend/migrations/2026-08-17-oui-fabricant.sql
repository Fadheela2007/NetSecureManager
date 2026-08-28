-- =====================================================================
-- Identification du fabricant par adresse MAC (registre OUI de l'IEEE)
--
-- Deux ajouts de structure, aucune suppression, aucun DROP.
-- À exécuter AVANT le premier import du registre.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) La table du registre
--
-- 53 559 entrées après import, soit ~3 Mo. La clé primaire sur `oui`
-- rend la recherche immédiate, mais le serveur charge de toute façon la
-- table entière en mémoire une fois par heure : la résolution pendant un
-- scan ne fait donc aucune requête.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS OUI_FABRICANT (
  oui        CHAR(6) NOT NULL PRIMARY KEY,
  fabricant  VARCHAR(120) NOT NULL,
  date_maj   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
               ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 2) La provenance du fabricant
--
-- Un fabricant issu de SNMP est le constructeur déclaré de l'équipement.
-- Un fabricant issu de l'OUI est celui de la CARTE réseau — un serveur
-- Dell équipé d'une carte Intel remontera « Intel ». La nuance compte
-- pour un administrateur réseau, d'où cette colonne, que l'interface
-- utilise pour l'afficher discrètement.
--
-- 'mac_aleatoire' : l'équipement a une adresse MAC aléatoire (smartphone
-- récent). Marqué explicitement pour ne pas le réexaminer à chaque
-- rattrapage, et pour ne pas laisser croire à une identification.
-- ---------------------------------------------------------------------
ALTER TABLE EQUIPEMENT
  ADD COLUMN fabricant_source ENUM('snmp','oui','nmap','mac_aleatoire') NULL AFTER fabricant;


-- ---------------------------------------------------------------------
-- 3) Renseigner la provenance des données existantes
--
-- Les équipements déjà identifiés l'ont été par SNMP ou nmap. On ne peut
-- pas les distinguer avec certitude a posteriori, mais `sys_descr`
-- renseigné est un marqueur fiable de SNMP.
--
-- Important : cela protège ces fabricants du rattrapage OUI, qui ne
-- touche jamais à une valeur d'origine SNMP.
-- ---------------------------------------------------------------------
-- Note : `id_equipement > 0` est là pour le « safe update mode » de MySQL
-- Workbench, qui refuse tout UPDATE dont le WHERE ne porte pas sur une
-- colonne indexée (Error Code 1175). La condition est vraie pour toutes
-- les lignes : le résultat est identique, et la requête passe partout
-- sans avoir à désactiver le garde-fou.
UPDATE EQUIPEMENT
SET fabricant_source = 'snmp'
WHERE id_equipement > 0
  AND fabricant IS NOT NULL
  AND fabricant <> ''
  AND sys_descr IS NOT NULL
  AND sys_descr <> ''
  AND fabricant_source IS NULL;

UPDATE EQUIPEMENT
SET fabricant_source = 'nmap'
WHERE id_equipement > 0
  AND fabricant IS NOT NULL
  AND fabricant <> ''
  AND (sys_descr IS NULL OR sys_descr = '')
  AND fabricant_source IS NULL;


-- =====================================================================
-- IMPORT DU REGISTRE — après les étapes ci-dessus
--
--   cd backend
--   node tools/importer-oui.js
--
-- Utilise la graine embarquée data/oui-ieee.json.gz : AUCUN accès
-- Internet requis. Comptez quelques secondes pour 53 559 entrées.
--
-- Autres sources possibles :
--   node tools/importer-oui.js --fichier /chemin/oui.csv
--   node tools/importer-oui.js --telecharger
--
-- L'import est idempotent : le relancer met à jour et complète, sans
-- jamais supprimer.
-- =====================================================================


-- =====================================================================
-- ÉTAT DES LIEUX — avant / après
-- =====================================================================

-- Combien d'équipements peuvent espérer être identifiés ?
-- C'est le potentiel de la fonctionnalité sur VOTRE parc.
SELECT
  COUNT(*) AS total,
  SUM(fabricant IS NOT NULL AND fabricant <> '') AS avec_fabricant,
  SUM(adresse_mac IS NOT NULL AND adresse_mac <> '') AS avec_mac,
  SUM((fabricant IS NULL OR fabricant = '')
      AND adresse_mac IS NOT NULL AND adresse_mac <> '') AS identifiables_par_oui
FROM EQUIPEMENT;

-- Après le rattrapage : répartition par provenance
SELECT COALESCE(fabricant_source, 'non renseigné') AS provenance,
       COUNT(*) AS equipements
FROM EQUIPEMENT
GROUP BY fabricant_source
ORDER BY equipements DESC;

-- Les fabricants les plus représentés
SELECT fabricant, COUNT(*) AS equipements
FROM EQUIPEMENT
WHERE fabricant IS NOT NULL AND fabricant <> ''
GROUP BY fabricant
ORDER BY equipements DESC
LIMIT 20;

-- Combien d'adresses MAC aléatoires (smartphones) sur le parc ?
-- Ces équipements ne seront JAMAIS identifiables par OUI.
SELECT COUNT(*) AS mac_aleatoires
FROM EQUIPEMENT
WHERE adresse_mac IS NOT NULL
  AND CONV(SUBSTRING(REPLACE(REPLACE(adresse_mac,':',''),'-',''), 1, 2), 16, 10) & 2 = 2;


-- =====================================================================
-- RATTRAPAGE SANS RESCAN
--
-- Depuis l'interface : page Équipements, bouton « Identifier les
-- fabricants » (visible tant qu'il reste des équipements sans fabricant).
--
-- Ou par API, réservé aux rôles admin et opérateur :
--   POST /api/equipements/resoudre-fabricants
--
-- La réponse détaille : résolus, types précisés, MAC aléatoires, OUI
-- absents du registre, et fabricants SNMP conservés.
--
-- Diagnostic du registre chargé :
--   GET /api/oui/etat
-- =====================================================================
