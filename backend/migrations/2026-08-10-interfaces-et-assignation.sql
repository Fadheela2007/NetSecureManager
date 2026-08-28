-- =====================================================================
-- Migration — exploitation de INTERFACE_RESEAU et INCIDENT.id_utilisateur_assigne
--
-- À exécuter dans MySQL Workbench, DANS CET ORDRE.
-- Aucun DROP, aucune perte de données.
--
-- Les étapes 1 et 2 sont OBLIGATOIRES : sans elles, l'inventaire des
-- interfaces ne s'enregistrera pas (l'erreur est attrapée et journalisée,
-- le scan continue, mais la table restera vide).
--
-- L'étape 3 est une VÉRIFICATION, pas une modification.
-- L'étape 4 est FACULTATIVE.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- ÉTAPE 1 (obligatoire) — colonne index_snmp sur INTERFACE_RESEAU
--
-- Pourquoi : l'index SNMP (ifIndex) est le seul identifiant stable d'une
-- interface sur un équipement. Le nom (ifDescr) ne convient pas comme clé :
-- il peut être dupliqué ou changer après une mise à jour du firmware.
--
-- Si la colonne existe déjà, MySQL renvoie ER_DUP_FIELDNAME : ignorer.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN index_snmp INT NULL AFTER id_equipement;


-- ---------------------------------------------------------------------
-- ÉTAPE 2 (obligatoire) — clé unique pour le ON DUPLICATE KEY UPDATE
--
-- Pourquoi : routes/scan.js fait
--   INSERT INTO INTERFACE_RESEAU ... ON DUPLICATE KEY UPDATE
-- Sans cette contrainte, chaque scan RECRÉE toutes les interfaces au lieu
-- de les mettre à jour : la table grossit indéfiniment.
--
-- Vérifier d'abord l'absence de doublons (doit renvoyer 0 ligne) :
--   SELECT id_equipement, index_snmp, COUNT(*) c
--   FROM INTERFACE_RESEAU
--   GROUP BY id_equipement, index_snmp HAVING c > 1;
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD UNIQUE KEY uniq_equip_ifindex (id_equipement, index_snmp);


-- ---------------------------------------------------------------------
-- ÉTAPE 3 (VÉRIFICATION — ne modifie rien)
--
-- Le code écrit les chaînes 'up', 'down' ou 'inconnu' dans etat_admin et
-- etat_operationnel, par cohérence avec EQUIPEMENT.statut qui est un
-- ENUM('up','down','inconnu').
--
-- Lancer cette requête et vérifier le type réel des deux colonnes :
-- ---------------------------------------------------------------------
SHOW COLUMNS FROM INTERFACE_RESEAU LIKE 'etat_%';

-- Si le résultat indique un type NUMÉRIQUE (int, tinyint) au lieu de
-- enum/varchar, DEUX options — me le signaler et je choisis avec vous :
--
--   Option A — aligner la base sur le code (recommandé, lisible) :
--     ALTER TABLE INTERFACE_RESEAU
--       MODIFY etat_admin        ENUM('up','down','inconnu') DEFAULT 'inconnu',
--       MODIFY etat_operationnel ENUM('up','down','inconnu') DEFAULT 'inconnu';
--
--   Option B — garder les codes SNMP bruts (1=up, 2=down) et adapter le
--   code : dans discoveryService.js, la fonction etatInterface() renverrait
--   le nombre au lieu de la chaîne.


-- ---------------------------------------------------------------------
-- ÉTAPE 4 (FACULTATIVE) — colonne VLAN
--
-- La colonne `vlan` existe déjà dans INTERFACE_RESEAU et l'interface
-- l'affiche si elle est renseignée. Mais AUCUN code ne la remplit :
-- le VLAN d'un port ne figure pas dans IF-MIB. Il se lit dans
-- Q-BRIDGE-MIB (dot1qVlanStaticTable) ou dans une MIB propriétaire selon
-- le constructeur — donc pas de collecte générique possible.
--
-- Rien à exécuter ici. La colonne reste utilisable si vous alimentez le
-- VLAN manuellement ; sinon elle affichera « — ».
-- ---------------------------------------------------------------------


-- =====================================================================
-- CONTRÔLE FINAL — après les étapes 1 et 2, puis un scan
--
-- Doit renvoyer des lignes si l'équipement scanné répond en SNMP v1/v2c :
--
--   SELECT e.adresse_ip, i.index_snmp, i.nom, i.etat_admin, i.etat_operationnel
--   FROM INTERFACE_RESEAU i
--   JOIN EQUIPEMENT e ON e.id_equipement = i.id_equipement
--   ORDER BY e.adresse_ip, i.index_snmp;
--
-- Table vide après un scan ? Causes possibles, dans l'ordre :
--   1. Les étapes 1 et 2 n'ont pas été exécutées (voir la console du
--      backend : "Inventaire des interfaces de <ip> ignoré: ...").
--   2. L'équipement ne répond pas en SNMP, ou seulement en SNMPv3
--      (limite connue : l'inventaire utilise une session v1/v2c).
--   3. L'équipement n'expose pas IF-MIB (rare, mais possible sur du
--      matériel grand public).
-- =====================================================================


-- =====================================================================
-- AUCUNE MIGRATION REQUISE pour l'assignation des incidents
--
-- INCIDENT.id_utilisateur_assigne existe déjà. Les routes
-- PATCH /api/incidents/:id/assigner et GET /api/utilisateurs
-- l'utilisent directement.
--
-- Vérification facultative de la clé étrangère (souhaitable pour que la
-- suppression d'un compte n'efface pas ses incidents) :
--
--   SELECT CONSTRAINT_NAME, DELETE_RULE
--   FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = 'NetSecureManager' AND TABLE_NAME = 'INCIDENT';
--
-- Si aucune contrainte ne porte sur id_utilisateur_assigne :
--   ALTER TABLE INCIDENT
--     ADD CONSTRAINT fk_incident_assigne
--     FOREIGN KEY (id_utilisateur_assigne)
--     REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL;
-- =====================================================================
