-- =====================================================================
-- Attribution de la bande passante par port de switch
--
-- À exécuter dans MySQL Workbench. Aucun DROP, aucune perte de données.
--
-- ─────────────────────────────────────────────────────────────────────
-- LE PROBLÈME
--
-- La mesure de bande passante interrogeait chaque machine en SNMP. Or
-- un poste Windows n'active pas SNMP par défaut : sur un parc courant,
-- neuf machines sur dix n'étaient pas mesurables et la page « Bande
-- passante » restait vide. Une fonction qui ne montre rien passe pour
-- une fonction qui ne marche pas.
--
-- LA SOLUTION
--
-- On cherchait SNMP au mauvais endroit. Le poste n'a pas besoin de
-- savoir ce qu'il consomme : le SWITCH le sait déjà. Le compteur du
-- port 12 EST la consommation de la machine branchée sur le port 12.
--
-- Il ne manquait que la correspondance port ↔ machine, que tout
-- commutateur administrable expose en SNMP (BRIDGE-MIB). Ces colonnes
-- la stockent.
--
-- CE QUI NE CHANGE PAS : le SNMP direct reste prioritaire quand il
-- existe. Il mesure ce qui traverse la carte réseau de la machine ;
-- le port y ajoute le trafic de diffusion qu'elle subit sans l'avoir
-- demandé. L'écart est faible, mais le premier reste plus juste.
-- ─────────────────────────────────────────────────────────────────────
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) Quelle machine est branchée sur ce port
--
-- NULL a un sens précis et doit être distingué de « aucune machine » :
--   NULL + nb_mac_vues = 0  -> port vide, ou switch non interrogé
--   NULL + nb_mac_vues = 1  -> une machine vue, mais inconnue du parc
--                              (éteinte au scan, ou muette au ping)
--   NULL + nb_mac_vues > 1  -> plusieurs machines : NON ATTRIBUABLE
--
-- Le troisième cas est le plus important. Un port qui porte une borne
-- Wi-Fi, un switch en cascade ou un hyperviseur agrège le trafic de
-- plusieurs machines. L'attribuer à l'une d'elles afficherait « le poste
-- de la comptabilité consomme 400 Mbit/s » pour le trafic de tout un
-- étage. Un chiffre faux et plausible est pire que pas de chiffre.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN id_equipement_connecte INT NULL AFTER date_trafic;

ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN mac_connectee VARCHAR(17) NULL AFTER id_equipement_connecte;

ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN nb_mac_vues INT NOT NULL DEFAULT 0 AFTER mac_connectee;

ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN date_attribution DATETIME NULL AFTER nb_mac_vues;


-- ---------------------------------------------------------------------
-- 2) Clé étrangère
--
-- ON DELETE SET NULL et non CASCADE : supprimer une machine du parc ne
-- doit pas effacer le PORT du switch, qui existe toujours. On perd
-- seulement le lien.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD CONSTRAINT fk_interface_equipement_connecte
  FOREIGN KEY (id_equipement_connecte) REFERENCES EQUIPEMENT (id_equipement)
  ON DELETE SET NULL;


-- ---------------------------------------------------------------------
-- 3) Index
--
-- La requête centrale du classement part d'un équipement et cherche le
-- port qui le porte : « quelle interface a id_equipement_connecte = X ».
-- Sans index, chaque ligne du classement balaie toute la table des
-- interfaces.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD KEY idx_interface_connecte (id_equipement_connecte);


-- ---------------------------------------------------------------------
-- 4) Diagnostic par switch
--
-- Tous les switches ne se prêtent pas à l'exercice. Un switch non
-- administrable n'expose rien ; certains modèles ne publient pas la
-- table de correspondance des ports. Sans trace de la raison, on ne
-- pourrait pas expliquer au client pourquoi SON switch ne donne rien.
-- ---------------------------------------------------------------------
ALTER TABLE EQUIPEMENT
  ADD COLUMN commutation_exploitable TINYINT(1) NULL;

ALTER TABLE EQUIPEMENT
  ADD COLUMN commutation_raison VARCHAR(160) NULL;


-- =====================================================================
-- CONTRÔLE — après la migration, puis DEUX scans avec inventaire
--
-- Deux scans : l'inventaire des interfaces ne tourne qu'un cycle sur
-- douze par défaut, et l'attribution le suit.
--
--   SELECT sw.nom AS switch_nom, i.nom AS port, i.nb_mac_vues,
--          eq.nom AS machine, eq.adresse_ip,
--          ROUND(i.trafic_entrant_kbps, 1) AS entrant_kbps
--   FROM INTERFACE_RESEAU i
--   JOIN EQUIPEMENT sw ON sw.id_equipement = i.id_equipement
--   LEFT JOIN EQUIPEMENT eq ON eq.id_equipement = i.id_equipement_connecte
--   WHERE i.nb_mac_vues > 0
--   ORDER BY sw.nom, i.index_snmp;
--
-- Rien du tout ? Regardez d'abord si un switch a été interrogé :
--
--   SELECT nom, adresse_ip, commutation_exploitable, commutation_raison
--   FROM EQUIPEMENT
--   WHERE commutation_exploitable IS NOT NULL;
--
-- Causes possibles, dans l'ordre :
--   1. Aucun switch administrable sur le parc. C'est une limite réelle
--      du produit, à dire au client : sans switch SNMP, la mesure par
--      port est impossible — il n'existe alors aucun endroit du réseau
--      qui connaisse la réponse.
--   2. La communauté SNMP du switch n'est pas « public ». Renseignez-la
--      dans Plages réseau.
--   3. Le switch expose la table d'adresses mais pas la correspondance
--      des ports (colonne commutation_raison). Cas connu sur du matériel
--      d'entrée de gamme.
-- =====================================================================
