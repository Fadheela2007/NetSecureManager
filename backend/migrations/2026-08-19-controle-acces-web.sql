-- =====================================================================
-- Contrôle des accès web par blocage DNS
--
-- À exécuter dans MySQL Workbench, DANS CET ORDRE.
-- Aucun DROP, aucune table existante modifiée.
--
-- ─────────────────────────────────────────────────────────────────────
-- CE QUE CE SCHÉMA NE STOCKE PAS, ET C'EST VOLONTAIRE
--
-- Aucune table ne relie une requête DNS à une personne, à un poste ou à
-- une adresse IP. Il n'y a nulle part d'historique de navigation.
--
-- La consigne était : « faire respecter une politique d'entreprise, pas
-- tracer les personnes ». Ce n'est pas qu'une intention, c'est une
-- propriété du schéma : même en le voulant, l'application ne PEUT PAS
-- répondre à « quels sites a visités Untel ». La donnée n'existe pas.
--
-- Un client qui demande cette fonction demande un outil de surveillance
-- des employés — produit différent, obligations légales différentes
-- (information des salariés, déclaration, proportionnalité). Mieux vaut
-- que le schéma rende la dérive impossible que reposer sur la discipline
-- de celui qui écrira la prochaine requête.
--
-- Le seul comptage conservé est AGRÉGÉ : « 1 240 requêtes bloquées dans
-- la catégorie streaming, sur le site de Douala, le 19 août ». Sans IP,
-- sans nom de domaine, sans horaire fin. C'est suffisant pour montrer
-- que la politique fonctionne, insuffisant pour désigner quelqu'un.
-- ─────────────────────────────────────────────────────────────────────
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) CATEGORIE_WEB — les thèmes de blocage (publicité, streaming…)
--
-- `source` et `date_import` documentent la provenance : une liste
-- publique importée le 3 mars n'a pas la même valeur qu'une liste
-- maintenue à la main. L'interface l'affiche pour que personne ne croie
-- bloquer « toute la publicité » avec une liste de 2023.
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
-- 2) DOMAINE_CATEGORIE — les domaines de chaque catégorie
--
-- C'est la table volumineuse : une liste « publicité » sérieuse compte
-- 100 000 à 300 000 entrées. D'où VARCHAR(253) (longueur maximale d'un
-- nom de domaine) et un index sur le domaine seul, pour répondre à
-- « dans quelles catégories se trouve ce domaine ? » sans balayage.
--
-- ON DELETE CASCADE : supprimer une catégorie doit emporter ses
-- domaines, sinon un réimport laisserait des orphelins invisibles.
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
-- 3) POLITIQUE_WEB — une politique par site
--
-- id_site NULL = politique par défaut, appliquée aux sites qui n'en ont
-- pas de propre. Même convention que UTILISATEUR.id_site : un seul
-- modèle mental pour toute la plateforme.
--
-- `version` est la clé de tout le mécanisme de distribution. L'agent
-- l'envoie à chaque cycle ; le serveur ne renvoie la liste complète —
-- qui peut peser plusieurs mégaoctets — que si elle a changé. Sans ce
-- compteur, chaque agent retéléchargerait 300 000 domaines toutes les
-- cinq minutes.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS POLITIQUE_WEB (
  id_politique      INT AUTO_INCREMENT PRIMARY KEY,
  id_site           INT DEFAULT NULL,
  nom               VARCHAR(120) NOT NULL,
  active            TINYINT(1) NOT NULL DEFAULT 0,
  -- Ce que voit l'utilisateur bloqué. Une page qui dit « bloqué par la
  -- politique de l'entreprise, contactez le service informatique » évite
  -- une bonne partie des tickets « internet ne marche pas ».
  message_blocage   VARCHAR(255) DEFAULT NULL,
  version           INT NOT NULL DEFAULT 1,
  date_maj          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_politique_site (id_site),
  CONSTRAINT fk_politique_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 4) POLITIQUE_CATEGORIE — quelles catégories cette politique bloque
-- ---------------------------------------------------------------------
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
-- 5) POLITIQUE_DOMAINE — ajouts et exceptions manuels
--
-- action = 'autoriser' est la soupape indispensable. Les listes
-- publiques bloquent régulièrement un domaine dont l'entreprise a
-- besoin : un fournisseur classé « publicité » parce qu'il héberge aussi
-- des bandeaux, une plateforme de visioconférence classée « streaming ».
-- Sans exception, l'administrateur devrait désactiver toute la catégorie
-- pour un seul domaine — et c'est exactement ce qui fait abandonner un
-- filtrage.
--
-- Une règle manuelle l'emporte TOUJOURS sur une catégorie : voir
-- services/politiqueWebService.js, qui applique et teste cette règle.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS POLITIQUE_DOMAINE (
  id_regle       INT AUTO_INCREMENT PRIMARY KEY,
  id_politique   INT NOT NULL,
  domaine        VARCHAR(253) NOT NULL,
  action         ENUM('bloquer','autoriser') NOT NULL DEFAULT 'bloquer',
  -- Pourquoi cette exception existe. Six mois plus tard, personne ne se
  -- souvient pourquoi « cdn-truc.net » est autorisé, et personne n'ose
  -- l'enlever. Le champ est court exprès : une phrase, pas un roman.
  commentaire    VARCHAR(255) DEFAULT NULL,
  date_creation  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_politique_domaine (id_politique, domaine),
  CONSTRAINT fk_poldom_politique FOREIGN KEY (id_politique)
    REFERENCES POLITIQUE_WEB (id_politique) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 6) STAT_BLOCAGE — comptage AGRÉGÉ, jamais nominatif
--
-- Une ligne par (site, jour, catégorie). Rien d'autre.
--
-- Ce qui n'y figure pas, et qui ne doit jamais y figurer : l'adresse IP
-- du poste, le nom de domaine demandé, l'heure précise, l'utilisateur.
-- Chacun de ces champs, seul, transformerait un indicateur de politique
-- en journal de navigation.
--
-- La granularité au jour est un choix, pas une limite technique : à
-- l'heure près, sur un petit site, « 14 h 03 : 1 requête bloquée en
-- catégorie adulte » désigne quelqu'un aussi sûrement qu'un nom.
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


-- ---------------------------------------------------------------------
-- 7) Suivi de l'application côté agent
--
-- Sans ces colonnes, l'interface afficherait « politique active » dès
-- l'enregistrement — alors que l'agent ne l'a peut-être jamais reçue, ou
-- n'a pas pu recharger son résolveur. Annoncer un blocage qui n'a pas
-- lieu est pire que de ne rien annoncer : le client le découvre en
-- constatant qu'un site interdit s'ouvre.
--
-- Si une colonne existe déjà : ER_DUP_FIELDNAME (1060), ignorer.
-- ---------------------------------------------------------------------
ALTER TABLE SITE
  ADD COLUMN politique_version_appliquee INT DEFAULT NULL;

ALTER TABLE SITE
  ADD COLUMN politique_date_application DATETIME DEFAULT NULL;

ALTER TABLE SITE
  ADD COLUMN politique_erreur VARCHAR(255) DEFAULT NULL;


-- ---------------------------------------------------------------------
-- 8) Catégories de départ, sans domaines
--
-- Les listes elles-mêmes s'importent avec :
--   node tools\importer-listes-web.js <categorie> <fichier.txt>
--
-- Elles ne sont volontairement PAS embarquées dans cette migration :
-- une liste de blocage se périme (six mois suffisent à la rendre
-- douteuse), et un fichier SQL de 300 000 INSERT serait ingérable en
-- relecture comme en exécution.
-- ---------------------------------------------------------------------
INSERT INTO CATEGORIE_WEB (code, libelle, description) VALUES
  ('publicite',      'Publicité et pistage',   'Régies publicitaires et traceurs. La catégorie la plus rentable : elle accélère la navigation et réduit la bande passante consommée.'),
  ('reseaux_sociaux','Réseaux sociaux',        'Facebook, X, TikTok, Instagram et leurs domaines techniques.'),
  ('streaming',      'Vidéo et streaming',     'Plateformes vidéo et musicales. Attention aux outils de visioconférence, souvent classés ici à tort.'),
  ('adulte',         'Contenu adulte',         'Sites pour adultes.'),
  ('jeux',           'Jeux en ligne',          'Plateformes de jeu et de pari.'),
  ('malveillant',    'Sites malveillants',     'Hameçonnage et distribution de logiciels malveillants. À activer partout : cette catégorie protège, elle ne restreint pas.'),
  ('contournement',  'Contournement (VPN, proxy)', 'Services de VPN et de proxy web. Sans cette catégorie, la politique se contourne par un simple site web.')
ON DUPLICATE KEY UPDATE libelle = VALUES(libelle), description = VALUES(description);


-- =====================================================================
-- CONTRÔLE FINAL
--
--   SELECT code, libelle, nb_domaines, date_import FROM CATEGORIE_WEB;
--
-- Doit renvoyer 7 lignes, toutes avec nb_domaines = 0 et date_import
-- NULL tant qu'aucune liste n'a été importée. C'est l'état normal après
-- cette migration.
-- =====================================================================
