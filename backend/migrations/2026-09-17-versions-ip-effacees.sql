-- ---------------------------------------------------------------------
-- 2026-09-17 — Effacer les « versions » qui sont en réalité des adresses IP.
--
-- CE QUI S'ÉTAIT PASSÉ
--
-- Un serveur MySQL qui refuse une connexion n'envoie pas sa poignée de
-- main : il envoie un paquet d'erreur, du type « Host '192.168.0.191' is
-- not allowed to connect to this MySQL server ». Le lecteur de version y
-- cherchait la première suite de chiffres pointés et enregistrait
-- « 192.168.0.191 » comme numéro de version.
--
-- La fiche de l'équipement affichait donc « MySQL 192.168.0.191 » —
-- l'adresse de la machine qui a fait le scan, présentée comme une version
-- du logiciel. Le lecteur est corrigé (versionService.lireMysql, deux
-- garde-fous), mais la ligne déjà écrite reste en base : un correctif de
-- code ne réécrit pas le passé.
--
-- POURQUOI EFFACER PLUTÔT QUE CORRIGER
--
-- On ne peut pas déduire la vraie version : le serveur ne l'a jamais
-- dite. La seule valeur exacte est donc l'absence de valeur. Une colonne
-- vide se lit « on ne sait pas », ce qui est la vérité ; « 192.168.0.191 »
-- se lit comme un fait, et c'en est un faux.
--
-- CE QUI EST EFFACÉ, ET RIEN D'AUTRE
--
-- Seules les lignes MySQL/MariaDB dont la version a EXACTEMENT la forme
-- de quatre groupes de chiffres séparés par des points. Le port, le nom
-- du service et la date de détection ne bougent pas : ceux-là ont été
-- constatés, ils restent vrais. On n'efface que ce qui a été inventé.
--
-- L'interrogation correspondante au NVD est retirée elle aussi : laissée
-- en place, elle ferait croire que ce logiciel a été confronté aux
-- failles publiées — alors qu'on a interrogé une adresse IP.
-- ---------------------------------------------------------------------

-- Les deux tables peuvent manquer sur une base antérieure aux migrations
-- du 10/09 : une migration doit pouvoir se rejouer sur n'importe quel
-- schéma sans casser la chaîne.
SET @tableServices := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE table_schema = DATABASE() AND table_name = 'SERVICE_DETECTE'
);
SET @colonneVersion := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'SERVICE_DETECTE'
    AND column_name = 'version'
);

SET @sql := IF(@tableServices > 0 AND @colonneVersion > 0,
  'UPDATE SERVICE_DETECTE
      SET produit = NULL,
          version = NULL,
          version_source = NULL,
          banniere = NULL,
          date_version = NULL
    WHERE produit IN (''MySQL'', ''MariaDB'')
      AND version REGEXP ''^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$''',
  'SELECT "SERVICE_DETECTE absente ou sans colonne version : rien a effacer"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @tableInterrogations := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE table_schema = DATABASE() AND table_name = 'INTERROGATION_FAILLES'
);

SET @sqlInterrogation := IF(@tableInterrogations > 0,
  'DELETE FROM INTERROGATION_FAILLES
    WHERE produit IN (''MySQL'', ''MariaDB'')
      AND version REGEXP ''^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$''',
  'SELECT "INTERROGATION_FAILLES absente : rien a effacer"');
PREPARE stmt2 FROM @sqlInterrogation; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- Et les failles éventuellement enregistrées sous cette fausse version.
-- Il n'y en a pas dans le cas constaté — le NVD ne connaît évidemment
-- aucune adresse IP — mais la migration ne suppose pas : elle nettoie.
SET @tableFailles := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE table_schema = DATABASE() AND table_name = 'FAILLE_LOGICIEL'
);

SET @sqlFailles := IF(@tableFailles > 0,
  'DELETE FROM FAILLE_LOGICIEL
    WHERE produit IN (''MySQL'', ''MariaDB'')
      AND version REGEXP ''^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$''',
  'SELECT "FAILLE_LOGICIEL absente : rien a effacer"');
PREPARE stmt3 FROM @sqlFailles; EXECUTE stmt3; DEALLOCATE PREPARE stmt3;

-- ---------------------------------------------------------------------
-- LA VERSION REVIENDRA D'ELLE-MÊME SI ELLE EXISTE.
--
-- Le prochain scan réinterrogera le port 3306. Si le serveur accepte la
-- connexion, il annoncera sa version et la colonne se remplira
-- normalement. S'il la refuse à nouveau, la colonne restera vide — et
-- c'est exactement ce qu'il faut afficher quand personne n'a rien dit.
-- ---------------------------------------------------------------------
