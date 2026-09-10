-- ---------------------------------------------------------------------
-- 2026-09-10 — L'intérieur des postes : logiciels installés et processus.
--
-- CE QUI CHANGE, ET POURQUOI IL FALLAIT UN AGENT
--
-- Un scan réseau, quel qu'il soit, ne voit que ce qu'une machine EXPOSE.
-- Il ne peut pas voir ce qui tourne à l'intérieur : la documentation des
-- outils de découverte le dit sans ambiguïté — sans agent, on n'a « pas
-- accès à l'API Windows ni aux exécutables cachés », alors qu'un agent
-- local remonte « les logiciels installés et les processus en cours,
-- détails que les scans distants manquent ».
--
-- Aucune plateforme n'y échappe : les processus visibles dans Zabbix
-- viennent du Zabbix agent, ceux de CheckMK de l'agent CheckMK, ceux de
-- Nagios de NRPE. La plateforme a donc désormais deux agents, et ils ne
-- font pas le même métier :
--
--   agent de SITE   un par réseau. Scanne la plage, remonte le SNMP.
--                   Existe parce qu'un réseau privé distant n'est pas
--                   joignable depuis le central.
--   agent de POSTE  un par machine à suivre. Remonte ce que seule la
--                   machine elle-même peut savoir.
--
-- TROIS TABLES, CHACUNE POUR UNE DURÉE DE VIE DIFFÉRENTE
--
-- Un logiciel installé reste des mois : on garde son historique, avec la
-- date de première et de dernière observation. Un processus dure parfois
-- trois secondes : en garder l'historique ferait une table de plusieurs
-- millions de lignes par semaine, pour une information périmée à la
-- lecture. On garde donc, pour les processus, une PHOTOGRAPHIE remplacée
-- à chaque envoi — et la date de cette photographie, sans laquelle on
-- lirait un instantané d'il y a trois jours en croyant voir maintenant.
--
-- CE QUE LA PLATEFORME DOIT DIRE, ET QUI EST TOUJOURS LE MÊME PRINCIPE
--
-- Une machine sans logiciels listés n'est pas une machine sans logiciels :
-- c'est une machine sans agent de poste. `dernier_inventaire_poste` sur
-- EQUIPEMENT existe pour distinguer les deux. Sans cette colonne, un parc
-- entier sans agent afficherait des fiches vides d'apparence normale.
--
-- LA VIE PRIVÉE N'EST PAS UN DÉTAIL DE CONFIGURATION
--
-- La liste des programmes qu'une personne fait tourner sur son poste dit
-- beaucoup d'elle. L'agent ne remonte donc PAS le nom de l'utilisateur
-- par défaut : la colonne existe, elle reste vide tant que l'exploitant
-- n'active pas explicitement `COLLECTER_UTILISATEUR=1`. C'est un choix
-- que le client doit poser consciemment, pas un réglage qu'il découvre.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS LOGICIEL_INSTALLE (
  id_logiciel     INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  nom             VARCHAR(200) NOT NULL,
  version         VARCHAR(80)  DEFAULT NULL,
  editeur         VARCHAR(150) DEFAULT NULL,
  date_installation DATE       DEFAULT NULL,
  -- Première et dernière observation : ce couple permet de répondre à
  -- « depuis quand ce logiciel est-il là ? » et « est-il toujours là ? »
  -- sans conserver une ligne par envoi.
  premiere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  derniere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_logiciel (id_equipement, nom, version),
  KEY idx_logiciel_nom (nom, version),
  CONSTRAINT fk_logiciel_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS PROCESSUS_OBSERVE (
  id_processus    INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  nom             VARCHAR(200) NOT NULL,
  -- Combien d'exemplaires tournaient au moment de la photographie. Un
  -- navigateur en compte vingt : les lister vingt fois n'apprendrait rien
  -- et remplirait l'écran.
  occurrences     INT NOT NULL DEFAULT 1,
  memoire_ko      BIGINT DEFAULT NULL,
  -- Vide par défaut, et c'est délibéré : voir l'en-tête de cette
  -- migration. Ne se remplit que si l'exploitant l'a explicitement activé.
  utilisateur     VARCHAR(120) DEFAULT NULL,
  date_releve     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_processus (id_equipement, nom),
  CONSTRAINT fk_processus_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quand cette machine a-t-elle été inventoriée de l'intérieur, et par
-- quelle version de l'agent. Sans ces deux colonnes, une fiche vide ne
-- se distingue pas d'une machine sans agent.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'EQUIPEMENT'
    AND column_name = 'dernier_inventaire_poste'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE EQUIPEMENT
     ADD COLUMN dernier_inventaire_poste DATETIME DEFAULT NULL
       COMMENT "dernier envoi d un agent de poste ; NULL = aucun agent installe",
     ADD COLUMN agent_poste_version VARCHAR(20) DEFAULT NULL
       COMMENT "version de l agent installe sur cette machine"',
  'SELECT "colonnes d inventaire de poste deja presentes"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
