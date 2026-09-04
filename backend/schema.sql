-- =====================================================================
-- NetSecureManager — schéma de la base
--
-- RÈGLE : la base de données réelle fait foi. Ce fichier la décrit, il ne
-- la dicte pas. Aucune colonne existante n'est renommée ici.
--
-- ⚠ DEUX FICHIERS, DEUX USAGES — ne pas les confondre :
--
--   schema.sql    -> INSTALLATION NEUVE. Décrit la structure COMPLÈTE et
--                    finale. C'est le seul fichier à exécuter sur une
--                    base vide.
--   migrations/   -> MISE À NIVEAU d'une base EXISTANTE, dans l'ordre des
--                    dates. Ne jamais les rejouer sur une base neuve
--                    créée par schema.sql : les colonnes existent déjà.
--
-- Les deux doivent décrire la même structure finale. Ce n'était PAS le
-- cas jusqu'au 21/08/2026 : sept tables et dix-huit colonnes n'existaient
-- que dans les migrations. Une installation neuve produisait donc une
-- base sur laquelle le blocage web, l'acquittement des alertes et la
-- bande passante échouaient tous — sans message clair.
--
-- ⚠ ÉTAT DE VÉRIFICATION
-- Ce fichier reproduit la structure telle que vous l'avez relevée sur la base
-- en production. Il n'a PAS pu être confronté directement à MySQL lors de sa
-- rédaction (base sur localhost Windows, inaccessible depuis l'environnement
-- d'audit). Pour lever ce doute :
--
--     cd backend
--     node tools/introspecter-base.js     -> produit tools/schema-reel.sql
--
-- Ce fichier-là est la source de vérité (sortie brute de SHOW CREATE TABLE).
-- Toute divergence avec le présent schema.sql doit être tranchée EN FAVEUR
-- de schema-reel.sql.
--
-- Ce script ne supprime jamais la base ni aucune table : il est rejouable sur
-- une base existante sans perte de données (CREATE TABLE IF NOT EXISTS,
-- INSERT IGNORE). Aucun DROP.
--
-- Ordre imposé par les clés étrangères :
--   SITE -> TYPE_EQUIPEMENT -> UTILISATEUR -> EQUIPEMENT -> le reste
-- =====================================================================

CREATE DATABASE IF NOT EXISTS NetSecureManager
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- SITE — une agence / ville supervisée. Chaque site distant possède un
-- agent local qui pousse ses résultats via POST /api/agent/push.
--
-- Note : les identifiants SNMPv3 ne sont PAS ici mais dans PLAGE_SCAN,
-- où ils sont rattachés à une plage précise plutôt qu'au site entier.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SITE (
  id_site        INT AUTO_INCREMENT PRIMARY KEY,
  nom            VARCHAR(100) NOT NULL,
  ville          VARCHAR(100) NOT NULL,
  adresse        VARCHAR(255) DEFAULT NULL,
  -- Jeton propre à l'agent du site (routes/sites.js, server.js)
  agent_token    VARCHAR(128) DEFAULT NULL,
  -- NULL = site LOCAL, supervisé directement par le serveur central.
  -- Renseigné = site distant pris en charge par un agent. C'est ce champ
  -- qui dit au cycle central de ne PAS pinger ce site.
  dernier_push   DATETIME DEFAULT NULL,
  -- Ce que l'agent applique RÉELLEMENT en matière de blocage web.
  -- Distinct de POLITIQUE_WEB.version, qui est ce qu'on lui demande.
  -- Sans cet écart, l'interface annoncerait un blocage imaginaire.
  politique_version_appliquee INT DEFAULT NULL,
  politique_date_application  DATETIME DEFAULT NULL,
  politique_erreur            VARCHAR(255) DEFAULT NULL,
  date_creation  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_site_nom (nom)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- TYPE_EQUIPEMENT — nomenclature des types issus du fingerprinting.
-- Clé primaire : id_type (et non id_type_equipement).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS TYPE_EQUIPEMENT (
  id_type      INT AUTO_INCREMENT PRIMARY KEY,
  libelle      VARCHAR(60) NOT NULL,
  description  VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- UTILISATEUR — comptes de la plateforme.
-- id_site NULL = utilisateur global, destinataire des alertes de tous les
-- sites (cf. notificationService.getDestinataires).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS UTILISATEUR (
  id_utilisateur      INT AUTO_INCREMENT PRIMARY KEY,
  nom                 VARCHAR(100) NOT NULL,
  email               VARCHAR(150) NOT NULL,
  mot_de_passe_hash   VARCHAR(255) NOT NULL,
  role                ENUM('admin','operateur','lecteur') NOT NULL DEFAULT 'lecteur',
  id_site             INT DEFAULT NULL,
  date_creation       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_utilisateur_email (email),
  KEY idx_utilisateur_site (id_site),
  CONSTRAINT fk_utilisateur_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- EQUIPEMENT — machines découvertes sur le réseau.
--
-- La clé unique uniq_ip_site (id_site, adresse_ip) est INDISPENSABLE :
-- routes/scan.js et /api/agent/push font tous deux
-- "INSERT ... ON DUPLICATE KEY UPDATE". Sans elle, chaque scan crée des
-- doublons au lieu de mettre à jour les équipements existants.
--
-- Attention : la date de création s'appelle date_ajout (et non
-- date_creation, qui n'existe que sur ALERTE, SITE et UTILISATEUR).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS EQUIPEMENT (
  id_equipement        INT AUTO_INCREMENT PRIMARY KEY,
  id_site              INT NOT NULL,
  id_type              INT DEFAULT NULL,
  nom                  VARCHAR(150) DEFAULT NULL,
  -- D'où vient le nom : 'snmp' (la machine se nomme elle-même), 'dns'
  -- (résolution inverse — le réseau la reconnaît), 'netbios' (le poste
  -- l'annonce sur le réseau local).
  --
  -- Le nom ne doit JAMAIS venir de l'estimation nmap : celle-ci produit
  -- un modèle avec son taux de confiance (« 3Com OfficeConnect … (96%) »),
  -- pas un nom de machine. Sa place est os_detecte.
  nom_source           VARCHAR(20) DEFAULT NULL,
  -- Nom donné par l'exploitant, qui prime sur le nom découvert.
  --
  -- Colonne SÉPARÉE de `nom` et non modification de celui-ci : le scan
  -- réécrit `nom` à chaque passage, et un nom saisi à la main y serait
  -- effacé au scan suivant. Les deux coexistent — `nom` est ce que le
  -- réseau déclare, `nom_personnalise` ce que l'exploitant a décidé.
  nom_personnalise     VARCHAR(150) DEFAULT NULL,
  adresse_ip           VARCHAR(45) NOT NULL,
  -- Ajoutée après coup : renseignée depuis la table ARP.
  -- Requise par POST /api/equipements/:id/reveiller (Wake-on-LAN).
  adresse_mac          VARCHAR(17) DEFAULT NULL,
  fabricant            VARCHAR(100) DEFAULT NULL,
  -- D'où vient le fabricant : 'snmp' (l'équipement se décrit lui-même),
  -- 'oui' (déduit de l'adresse MAC — identifie la CARTE, pas la machine),
  -- 'nmap' (déduit du système, le moins fiable).
  fabricant_source     ENUM('snmp','oui','nmap') DEFAULT NULL,
  -- Quelle RÈGLE a décidé du type : 'snmp' (texte sysDescr), 'port'
  -- (port révélateur ouvert), 'nmap_device', 'nmap_os', 'fabricant' ou
  -- 'aucune'.
  --
  -- Sans cette trace, un type contesté par le client est indéfendable :
  -- on ne peut ni expliquer la décision, ni savoir quelle règle corriger.
  -- Le cas s'est présenté sur six équipements classés « imprimante » —
  -- impossible de dire si les ports d'impression avaient tranché, ou si
  -- nmap s'était trompé.
  type_source          VARCHAR(20) DEFAULT NULL,
  modele               VARCHAR(150) DEFAULT NULL,
  sys_descr            TEXT DEFAULT NULL,
  -- Ajoutée après coup : résultat de nmapFingerprint().
  os_detecte           VARCHAR(255) DEFAULT NULL,
  statut               ENUM('up','down','inconnu') NOT NULL DEFAULT 'inconnu',
  -- Ajoutée après coup : compteur d'échecs de ping consécutifs, comparé à
  -- CONFIGURATION.seuil_echecs_avant_alerte (monitoringService).
  echecs_consecutifs   INT NOT NULL DEFAULT 0,
  derniere_decouverte  DATETIME DEFAULT NULL,
  date_ajout           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Renseignées uniquement sur les commutateurs : disent si la table
  -- d'adresses MAC du switch est exploitable pour attribuer la bande
  -- passante à chaque port. Sans cette trace, on ne pourrait pas
  -- expliquer au client pourquoi SON switch ne donne rien.
  commutation_exploitable TINYINT(1) DEFAULT NULL,
  commutation_raison      VARCHAR(160) DEFAULT NULL,
  UNIQUE KEY uniq_ip_site (id_site, adresse_ip),
  KEY idx_equipement_statut (statut),
  KEY idx_equipement_type (id_type),
  CONSTRAINT fk_equipement_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE,
  CONSTRAINT fk_equipement_type FOREIGN KEY (id_type)
    REFERENCES TYPE_EQUIPEMENT (id_type) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- INTERFACE_RESEAU — interfaces SNMP d'un équipement (ifIndex, compteurs).
-- Aucune requête du code ne lit ni n'écrit cette table à ce jour.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS INTERFACE_RESEAU (
  id_interface     INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement    INT NOT NULL,
  -- ifIndex : seul identifiant stable d'une interface. Le nom (ifDescr)
  -- ne convient pas comme clé, il peut changer après une mise à jour du
  -- micrologiciel.
  index_snmp       INT NOT NULL,
  nom              VARCHAR(150) DEFAULT NULL,
  adresse_mac      VARCHAR(17) DEFAULT NULL,
  vlan             VARCHAR(20) DEFAULT NULL,
  etat_admin        ENUM('up','down','inconnu') DEFAULT 'inconnu',
  etat_operationnel ENUM('up','down','inconnu') DEFAULT 'inconnu',

  -- ── Bande passante ──
  -- vitesse_mbps rend le débit interprétable : 50 000 kbit/s valent 5 %
  -- d'un lien gigabit et 500 % d'un lien 10 Mbit/s.
  -- NULL et 0 ne veulent PAS dire la même chose : NULL = pas encore
  -- mesurable (il faut deux relevés), 0 = mesuré, aucun trafic.
  vitesse_mbps          INT DEFAULT NULL,
  trafic_entrant_kbps   FLOAT DEFAULT NULL,
  trafic_sortant_kbps   FLOAT DEFAULT NULL,
  date_trafic           DATETIME DEFAULT NULL,

  -- ── Attribution par port ──
  -- Quelle machine est branchée sur ce port. Permet de mesurer la
  -- consommation d'une machine qui n'expose aucun SNMP : le switch
  -- compte pour elle.
  -- nb_mac_vues > 1 => port NON attribuable (borne Wi-Fi, switch en
  -- cascade, hyperviseur). Attribuer le total à une seule machine
  -- afficherait un chiffre plausible et faux.
  id_equipement_connecte INT DEFAULT NULL,
  mac_connectee          VARCHAR(17) DEFAULT NULL,
  nb_mac_vues            INT NOT NULL DEFAULT 0,
  date_attribution       DATETIME DEFAULT NULL,

  date_maj         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                     ON UPDATE CURRENT_TIMESTAMP,
  -- INDISPENSABLE : le code fait ON DUPLICATE KEY UPDATE dessus. Sans
  -- cette contrainte, chaque scan recrée toutes les interfaces.
  UNIQUE KEY uniq_equip_ifindex (id_equipement, index_snmp),
  KEY idx_interface_equipement (id_equipement),
  KEY idx_interface_trafic (id_equipement, trafic_entrant_kbps),
  KEY idx_interface_connecte (id_equipement_connecte),
  CONSTRAINT fk_interface_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE,
  -- SET NULL et non CASCADE : supprimer une machine du parc ne doit pas
  -- effacer le PORT du switch, qui existe toujours.
  CONSTRAINT fk_interface_equipement_connecte FOREIGN KEY (id_equipement_connecte)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- SERVICE_DETECTE — ports ouverts trouvés par scanPorts().
--
-- La clé unique uniq_equip_port (id_equipement, port) est INDISPENSABLE :
-- routes/scan.js fait "ON DUPLICATE KEY UPDATE" dessus.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS SERVICE_DETECTE (
  id_service      INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  port            INT NOT NULL,
  nom_service     VARCHAR(60) DEFAULT NULL,
  date_detection  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_equip_port (id_equipement, port),
  KEY idx_service_port (port),
  CONSTRAINT fk_service_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- RELEVE — mesures périodiques (une ligne par équipement et par cycle cron).
-- Table à forte croissance : prévoir une purge (voir recommandations).
-- temperature_c existe en base mais n'est écrite par aucun code.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS RELEVE (
  id_releve             BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_equipement         INT NOT NULL,
  date_releve           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  latence_ms            FLOAT DEFAULT NULL,
  cpu_pourcent          FLOAT DEFAULT NULL,
  ram_pourcent          FLOAT DEFAULT NULL,
  trafic_entrant_kbps   FLOAT DEFAULT NULL,
  trafic_sortant_kbps   FLOAT DEFAULT NULL,
  temperature_c         DECIMAL(5,2) DEFAULT NULL,
  -- Index composite : sert GET /api/equipements/:id/releves
  KEY idx_releve_equipement_date (id_equipement, date_releve),
  CONSTRAINT fk_releve_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- ALERTE — anomalies détectées par la supervision.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ALERTE (
  id_alerte        INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement    INT NOT NULL,
  type_alerte      VARCHAR(60) NOT NULL,
  niveau           ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  message          TEXT DEFAULT NULL,
  -- 'traitee' = acquittée : l'opérateur a pris le problème en charge.
  -- ACQUITTER N'EST PAS SUPPRIMER : l'alerte reste comptée partout.
  statut           ENUM('active','traitee','resolue') NOT NULL DEFAULT 'active',
  -- Ajoutée après coup : code de cause probable renvoyé par diagnosePanne().
  -- Sert de clé dans services/suggestions.js
  -- (pare_feu_probable, injoignable_total, conflit_ip).
  cause_code       VARCHAR(60) DEFAULT NULL,
  date_creation    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_resolution  DATETIME DEFAULT NULL,
  -- Dédoublonnage : un problème persistant produit UNE alerte dont le
  -- compteur monte, au lieu d'une alerte par cycle de supervision.
  -- premiere_detection ne bouge jamais : c'est elle qui répond à
  -- « depuis quand ce serveur est-il tombé ? ».
  occurrences          INT NOT NULL DEFAULT 1,
  premiere_detection   DATETIME DEFAULT NULL,
  derniere_occurrence  DATETIME DEFAULT NULL,
  date_acquittement    DATETIME DEFAULT NULL,
  acquittee_par        INT DEFAULT NULL,
  KEY idx_alerte_statut (statut),
  KEY idx_alerte_dedoublonnage (id_equipement, type_alerte, statut),
  KEY idx_alerte_date (date_creation),
  KEY idx_alerte_equipement_type (id_equipement, type_alerte, statut),
  CONSTRAINT fk_alerte_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE,
  CONSTRAINT fk_alerte_acquittee_par FOREIGN KEY (acquittee_par)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- INCIDENT — escalade d'une alerte restée active trop longtemps.
--
-- Pas de contrainte UNIQUE sur id_alerte en base : l'unicité repose
-- uniquement sur la sous-requête "id_alerte NOT IN (SELECT ...)" de
-- escaladeIncidents(). Voir la recommandation en fin de fichier.
--
-- id_utilisateur_assigne existe en base mais n'est lue par aucun code.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS INCIDENT (
  id_incident             INT AUTO_INCREMENT PRIMARY KEY,
  id_alerte               INT NOT NULL,
  titre                   VARCHAR(200) NOT NULL,
  description             TEXT DEFAULT NULL,
  statut                  ENUM('ouvert','en_cours','ferme') NOT NULL DEFAULT 'ouvert',
  id_utilisateur_assigne  INT DEFAULT NULL,
  date_ouverture          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_fermeture          DATETIME DEFAULT NULL,
  KEY idx_incident_alerte (id_alerte),
  KEY idx_incident_statut (statut),
  KEY idx_incident_assigne (id_utilisateur_assigne),
  CONSTRAINT fk_incident_alerte FOREIGN KEY (id_alerte)
    REFERENCES ALERTE (id_alerte) ON DELETE CASCADE,
  CONSTRAINT fk_incident_assigne FOREIGN KEY (id_utilisateur_assigne)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- LOG_ACTIVITE — journal des actions utilisateur (GET /api/logs).
-- id_utilisateur NULL = action système.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS LOG_ACTIVITE (
  id_log                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_utilisateur         INT DEFAULT NULL,
  action                 VARCHAR(200) NOT NULL,
  description            TEXT DEFAULT NULL,
  adresse_ip_utilisateur VARCHAR(45) DEFAULT NULL,
  date_log               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_log_date (date_log),
  KEY idx_log_utilisateur (id_utilisateur),
  CONSTRAINT fk_log_utilisateur FOREIGN KEY (id_utilisateur)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- VULNERABILITE_CONNUE — CVE associées à un port/service.
-- Interrogée par GET /api/equipements/:id/vulnerabilites (WHERE port IN ...).
--
-- Sévérité : les valeurs sont 'faible','moyenne','haute','critique'
-- ('haute', pas 'elevee').
--
-- Pas de contrainte UNIQUE sur (cve_id, port) en base : réexécuter un script
-- d'insertion créerait des doublons. Voir la recommandation en fin de fichier.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS VULNERABILITE_CONNUE (
  id_vuln      INT AUTO_INCREMENT PRIMARY KEY,
  cve_id       VARCHAR(30) NOT NULL,
  service      VARCHAR(60) DEFAULT NULL,
  port         INT NOT NULL,
  severite     ENUM('faible','moyenne','haute','critique') NOT NULL DEFAULT 'moyenne',
  description  TEXT DEFAULT NULL,
  KEY idx_vuln_port (port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- CONFIGURATION — paramètres modifiables depuis l'interface.
-- Clé primaire : cle. routes/configuration.js fait
-- "UPDATE CONFIGURATION SET valeur = ? WHERE cle = ?".
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CONFIGURATION (
  cle          VARCHAR(60) PRIMARY KEY,
  valeur       VARCHAR(255) NOT NULL,
  description  VARCHAR(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- PLAGE_SCAN — plages CIDR à scanner par site.
-- C'est ici que vivent les identifiants SNMPv3 (et non dans SITE), parce
-- qu'ils sont propres à un sous-réseau et non à un site entier : un VLAN
-- d'imprimantes et un VLAN de serveurs n'ont pas les mêmes.
--
-- Lue par routes/scan.js à deux endroits :
--   • POST /scan/site      parcourt toutes les plages actives d'un site ;
--   • resoudreParametresScan  retrouve la communauté SNMP d'un CIDR donné,
--     de sorte qu'un scan lancé à la main hérite des paramètres déclarés.
--
-- Les clés SNMPv3 sont stockées en clair : elles doivent être renvoyées
-- au moteur de scan pour ouvrir la session. Elles sont masquées dans les
-- réponses de l'API pour les rôles non administrateurs (routes/plages.js),
-- mais un accès à la base les expose — à traiter le jour où le chiffrement
-- au repos deviendra une exigence client.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PLAGE_SCAN (
  id_plage          INT AUTO_INCREMENT PRIMARY KEY,
  id_site           INT NOT NULL,
  cidr              VARCHAR(20) NOT NULL,
  snmp_community    VARCHAR(100) DEFAULT 'public',
  snmp_version      ENUM('v1','v2c','v3') NOT NULL DEFAULT 'v2c',
  snmp_v3_username  VARCHAR(100) DEFAULT NULL,
  snmp_v3_auth_key  VARCHAR(255) DEFAULT NULL,
  snmp_v3_priv_key  VARCHAR(255) DEFAULT NULL,
  actif             BOOLEAN NOT NULL DEFAULT TRUE,
  KEY idx_plage_site (id_site),
  CONSTRAINT fk_plage_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- NOTIFICATION — trace des envois d'alertes.
-- Statut : 'envoye' / 'echec' ('envoye', pas 'envoyee').
--
-- La valeur 'whatsapp' de la colonne `canal` est CONSERVÉE bien que ce
-- canal ait été retiré : des installations existantes en contiennent
-- dans leur historique, et retirer la valeur de l'énumération rendrait
-- ces lignes illisibles. Une trace passée reste vraie même quand la
-- fonction qui l'a produite n'existe plus.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS NOTIFICATION (
  id_notification  INT AUTO_INCREMENT PRIMARY KEY,
  id_alerte        INT DEFAULT NULL,
  id_utilisateur   INT DEFAULT NULL,
  canal            ENUM('email','whatsapp') NOT NULL,
  destinataire     VARCHAR(150) DEFAULT NULL,
  statut           ENUM('envoye','echec') NOT NULL DEFAULT 'envoye',
  erreur           TEXT DEFAULT NULL,
  date_envoi       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notification_alerte (id_alerte),
  CONSTRAINT fk_notification_alerte FOREIGN KEY (id_alerte)
    REFERENCES ALERTE (id_alerte) ON DELETE CASCADE,
  CONSTRAINT fk_notification_utilisateur FOREIGN KEY (id_utilisateur)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- =====================================================================
-- Données de référence (idempotentes — INSERT IGNORE)
-- =====================================================================

INSERT IGNORE INTO TYPE_EQUIPEMENT (libelle, description) VALUES
  ('routeur',          'Routeur'),
  ('routeur/switch',   'Routeur ou commutateur réseau'),
  ('pare-feu',         'Pare-feu / firewall'),
  ('serveur',          'Serveur ou poste de travail'),
  ('imprimante',       'Imprimante réseau'),
  ('camera',           'Caméra IP'),
  ('telephonie',       'Téléphonie IP / VoIP'),
  ('equipement_snmp',  'Équipement répondant en SNMP, non identifié'),
  ('detecte_nmap',     'Identifié via signature nmap uniquement'),
  ('inconnu',          'Type non déterminé');

-- Les deux premières clés sont lues par monitoringService.getConfig().
-- ⚠ intervalle_scan_minutes existe en base et s'affiche dans l'écran
-- Configuration, mais AUCUN code ne la lit : les crons sont codés en dur
-- ("* * * * *" pour la supervision, "*/5 * * * *" pour l'escalade).
-- La modifier depuis l'interface n'a aujourd'hui aucun effet.
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('seuil_echecs_avant_alerte', '3',  'Nombre de pings consécutifs en échec avant de déclarer un équipement hors ligne'),
  ('seuil_escalade_minutes',    '15', 'Durée (minutes) au bout de laquelle une alerte active devient un incident'),
  ('intervalle_scan_minutes',   '5',  'Intervalle entre deux scans automatiques (non exploité par le code actuel)');


-- =====================================================================
-- RECOMMANDATIONS — À DÉCIDER, VOLONTAIREMENT NON APPLIQUÉES
--
-- Les deux contraintes ci-dessous sont absentes de la base. Elles ne sont
-- pas indispensables au fonctionnement actuel, mais constitueraient un
-- filet de sécurité. Décommenter en connaissance de cause.
--
-- ---------------------------------------------------------------------
-- 1) INCIDENT : unicité de id_alerte
--
-- escaladeIncidents() évite déjà les doublons via
--   "AND id_alerte NOT IN (SELECT id_alerte FROM INCIDENT)"
-- Cela fonctionne, mais reste vulnérable à une exécution concurrente
-- (deux cycles simultanés peuvent lire la même liste avant d'insérer).
-- Le verrou escaladeEnCours ajouté dans monitoringService.js couvre ce
-- cas au sein d'un processus ; une contrainte le couvrirait aussi entre
-- plusieurs instances du backend.
--
-- ⚠ Vérifier d'abord l'absence de doublons existants :
--   SELECT id_alerte, COUNT(*) c FROM INCIDENT GROUP BY id_alerte HAVING c > 1;
-- L'ALTER échouera tant qu'il en reste.
--
-- ALTER TABLE INCIDENT ADD UNIQUE KEY uk_incident_alerte (id_alerte);
--
-- ---------------------------------------------------------------------
-- 2) VULNERABILITE_CONNUE : unicité de (cve_id, port)
--
-- Sans cette contrainte, réexécuter le script d'insertion des CVE
-- dupliquera chaque ligne. GET /api/equipements/:id/vulnerabilites
-- afficherait alors la même vulnérabilité plusieurs fois.
--
-- ⚠ Vérifier d'abord l'absence de doublons existants :
--   SELECT cve_id, port, COUNT(*) c FROM VULNERABILITE_CONNUE
--     GROUP BY cve_id, port HAVING c > 1;
--
-- ALTER TABLE VULNERABILITE_CONNUE ADD UNIQUE KEY uk_vuln_cve_port (cve_id, port);
--
-- =====================================================================


-- =====================================================================
-- Mise à niveau d'une base ANTÉRIEURE
--
-- CREATE TABLE IF NOT EXISTS ne modifie PAS une table déjà existante.
-- Si votre base date d'avant certains ajouts, appliquer les lignes utiles
-- ci-dessous. MySQL 8.0 n'accepte pas "ADD COLUMN IF NOT EXISTS" :
-- relancer une ligne déjà appliquée renvoie ER_DUP_FIELDNAME, sans risque.
--
-- ⚠ Ces instructions n'ont de sens que si la colonne est réellement
-- absente. Lancer d'abord node tools/introspecter-base.js pour le savoir.
--
-- ALTER TABLE EQUIPEMENT ADD COLUMN adresse_mac VARCHAR(17) DEFAULT NULL;
-- ALTER TABLE EQUIPEMENT ADD COLUMN os_detecte VARCHAR(255) DEFAULT NULL;
-- ALTER TABLE EQUIPEMENT ADD COLUMN echecs_consecutifs INT NOT NULL DEFAULT 0;
-- ALTER TABLE EQUIPEMENT ADD UNIQUE KEY uniq_ip_site (id_site, adresse_ip);
--
-- ALTER TABLE ALERTE ADD COLUMN cause_code VARCHAR(60) DEFAULT NULL;
--
-- ALTER TABLE SITE ADD COLUMN agent_token VARCHAR(128) DEFAULT NULL;
--
-- La colonne telephone_whatsapp n'est plus déclarée : le canal WhatsApp
-- a été retiré (voir notificationService.js). Sur une base existante,
-- elle peut rester en place sans effet — la supprimer effacerait des
-- numéros sans rien apporter.
--
-- ALTER TABLE SERVICE_DETECTE ADD UNIQUE KEY uniq_equip_port (id_equipement, port);
-- =====================================================================


-- =====================================================================
-- TABLES AJOUTÉES APRÈS LA VERSION INITIALE
--
-- Elles étaient créées uniquement par les fichiers de migrations/, donc
-- ABSENTES d'une installation neuve : `schema.sql` seul produisait une
-- base sur laquelle la moitié des fonctions échouait.
--
-- Règle désormais tenue :
--   • schema.sql     -> installation NEUVE, complète
--   • migrations/    -> mise à niveau d'une base EXISTANTE
-- Les deux doivent décrire la même structure finale.
-- =====================================================================


-- ---------------------------------------------------------------------
-- OUI_FABRICANT — registre IEEE des préfixes d'adresses MAC.
--
-- Alimenté par `node tools/importer-oui.js`. Volumineux (~53 000
-- lignes) : il n'est pas embarqué dans ce fichier, mais dans
-- backend/data/oui-ieee.json.gz, importable sans accès Internet.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS OUI_FABRICANT (
  prefixe    CHAR(6) PRIMARY KEY,
  fabricant  VARCHAR(150) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- CATEGORIE_WEB — thèmes de blocage (publicité, streaming…).
--
-- nb_domaines et date_import sont affichés dans l'interface : une
-- catégorie cochée mais vide ne bloque rien, et une liste importée il y
-- a deux ans ne vaut plus grand-chose. Le dire évite une case cochée
-- rassurante devant un blocage inexistant.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS CATEGORIE_WEB (
  id_categorie   INT AUTO_INCREMENT PRIMARY KEY,
  code           VARCHAR(40) NOT NULL,
  libelle        VARCHAR(120) NOT NULL,
  description    VARCHAR(255) DEFAULT NULL,
  source         VARCHAR(255) DEFAULT NULL,
  nb_domaines    INT NOT NULL DEFAULT 0,
  date_import    DATETIME DEFAULT NULL,
  UNIQUE KEY uniq_categorie_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- DOMAINE_CATEGORIE — les domaines de chaque catégorie.
-- Table volumineuse : une liste « publicité » sérieuse compte 100 000 à
-- 300 000 entrées. D'où VARCHAR(253), longueur maximale d'un domaine.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS DOMAINE_CATEGORIE (
  id_domaine     BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_categorie   INT NOT NULL,
  domaine        VARCHAR(253) NOT NULL,
  UNIQUE KEY uniq_categorie_domaine (id_categorie, domaine),
  KEY idx_domaine (domaine),
  CONSTRAINT fk_domaine_categorie FOREIGN KEY (id_categorie)
    REFERENCES CATEGORIE_WEB (id_categorie) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- POLITIQUE_WEB — une politique de blocage par site.
--
-- id_site NULL = politique par défaut, appliquée aux sites qui n'en ont
-- pas de propre. Même convention que UTILISATEUR.id_site.
--
-- `version` est la clé de la distribution : l'agent l'annonce à chaque
-- cycle, et le serveur ne renvoie la liste complète — plusieurs
-- mégaoctets — que si elle a changé.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS POLITIQUE_WEB (
  id_politique      INT AUTO_INCREMENT PRIMARY KEY,
  id_site           INT DEFAULT NULL,
  nom               VARCHAR(120) NOT NULL,
  active            TINYINT(1) NOT NULL DEFAULT 0,
  message_blocage   VARCHAR(255) DEFAULT NULL,
  version           INT NOT NULL DEFAULT 1,
  date_maj          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_politique_site (id_site),
  CONSTRAINT fk_politique_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS POLITIQUE_CATEGORIE (
  id_politique   INT NOT NULL,
  id_categorie   INT NOT NULL,
  PRIMARY KEY (id_politique, id_categorie),
  CONSTRAINT fk_polcat_politique FOREIGN KEY (id_politique)
    REFERENCES POLITIQUE_WEB (id_politique) ON DELETE CASCADE,
  CONSTRAINT fk_polcat_categorie FOREIGN KEY (id_categorie)
    REFERENCES CATEGORIE_WEB (id_categorie) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- POLITIQUE_DOMAINE — ajouts et exceptions manuels.
--
-- action = 'autoriser' est la soupape indispensable : les listes
-- publiques bloquent régulièrement un domaine dont l'entreprise a
-- besoin. Sans exception praticable, l'administrateur désactive toute la
-- catégorie — et c'est ainsi qu'un filtrage est abandonné.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS POLITIQUE_DOMAINE (
  id_regle       INT AUTO_INCREMENT PRIMARY KEY,
  id_politique   INT NOT NULL,
  domaine        VARCHAR(253) NOT NULL,
  action         ENUM('bloquer','autoriser') NOT NULL DEFAULT 'bloquer',
  commentaire    VARCHAR(255) DEFAULT NULL,
  date_creation  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_politique_domaine (id_politique, domaine),
  CONSTRAINT fk_poldom_politique FOREIGN KEY (id_politique)
    REFERENCES POLITIQUE_WEB (id_politique) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- STAT_BLOCAGE — comptage AGRÉGÉ, jamais nominatif.
--
-- Une ligne par (site, jour, catégorie). Rien d'autre.
--
-- Ce qui n'y figure pas, et ne doit JAMAIS y figurer : l'adresse IP du
-- poste, le domaine demandé, l'heure précise, l'utilisateur. Chacun de
-- ces champs, seul, transformerait un indicateur de politique en journal
-- de navigation.
--
-- La plateforme est ainsi INCAPABLE de répondre à « quels sites a
-- consultés Untel » : la donnée n'existe pas. C'est une propriété du
-- schéma, pas une intention.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS STAT_BLOCAGE (
  id_stat        BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_site        INT NOT NULL,
  jour           DATE NOT NULL,
  id_categorie   INT DEFAULT NULL,
  nb_requetes    INT NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_stat (id_site, jour, id_categorie),
  KEY idx_stat_jour (jour),
  CONSTRAINT fk_stat_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE,
  CONSTRAINT fk_stat_categorie FOREIGN KEY (id_categorie)
    REFERENCES CATEGORIE_WEB (id_categorie) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- Catégories de départ, sans domaines. Les listes s'importent avec :
--   node tools/importer-listes-web.js <categorie> --recommandee --remplacer
INSERT INTO CATEGORIE_WEB (code, libelle, description) VALUES
  ('publicite',      'Publicité et pistage',   'Régies publicitaires et traceurs. La catégorie la plus rentable : elle accélère la navigation et réduit la bande passante consommée.'),
  ('reseaux_sociaux','Réseaux sociaux',        'Facebook, X, TikTok, Instagram et leurs domaines techniques.'),
  ('streaming',      'Vidéo et streaming',     'Plateformes vidéo et musicales. Attention aux outils de visioconférence, souvent classés ici à tort.'),
  ('adulte',         'Contenu adulte',         'Sites pour adultes.'),
  ('jeux',           'Jeux en ligne',          'Plateformes de jeu et de pari.'),
  ('malveillant',    'Sites malveillants',     'Hameçonnage et logiciels malveillants. À activer partout : cette catégorie protège, elle ne restreint pas.'),
  ('contournement',  'Contournement (VPN, proxy)', 'Services de VPN et de proxy web. Sans cette catégorie, la politique se contourne par un simple site web.')
ON DUPLICATE KEY UPDATE libelle = VALUES(libelle), description = VALUES(description);
