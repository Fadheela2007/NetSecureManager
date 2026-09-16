-- ---------------------------------------------------------------------
-- 2026-09-14 — Ce que chaque machine cherche à joindre.
--
-- CE QUE ÇA APPORTE, ET QUE RIEN D'AUTRE NE PEUT APPORTER
--
-- Voir les programmes à l'intérieur d'un poste sans qu'un agent y tourne
-- est impossible. Mais une machine, avant de faire quoi que ce soit sur
-- le réseau, doit demander un nom — toujours. Le résolveur du site, que
-- la plateforme héberge déjà pour le blocage web, voit donc passer ce
-- que chaque machine cherche à joindre.
--
-- Ce n'est pas la liste des logiciels installés : c'est la liste de ce
-- que la machine FAIT. Pour la sécurité, c'est la plus utile des deux —
-- un logiciel installé et jamais lancé ne risque rien, un outil de prise
-- de contrôle lancé depuis une clé USB, si. Et cela couvre CE QU'AUCUN
-- AGENT NE COUVRIRA : les téléphones, les imprimantes, les caméras, les
-- machines de passage.
--
-- ---------------------------------------------------------------------
-- CE QUE CETTE MIGRATION RENVERSE, ET COMMENT ELLE LE COMPENSE
--
-- L'en-tête de agent/dnsGuard.js portait cette décision :
--
--   « dnsmasq est configuré SANS log-queries, délibérément : cette
--     option transformerait la machine de l'agent en journal de
--     navigation complet du site, horodaté et associé à l'IP de chaque
--     poste. »
--
-- Elle était juste. On ne la contourne pas en silence : on la remplace
-- par un dispositif qui obtient le même service sans le même risque.
--
--   1. RIEN N'EST ACTIVÉ PAR DÉFAUT. `SITE.observation_dns` vaut 0. Un
--      site qui ne l'active pas se comporte exactement comme avant.
--   2. L'AGRÉGATION SE FAIT SUR L'AGENT, avant tout envoi. Le journal
--      complet ne quitte jamais la machine qui l'a produit.
--   3. SEUL LE DOMAINE ENREGISTRABLE EST CONSERVÉ. « clinique.cm », pas
--      « dossiers-medicaux.clinique.cm ». Le second en dit trop.
--   4. AUCUNE HEURE N'EST GARDÉE par requête. Un horodatage précis
--      transforme un relevé d'usage en emploi du temps de la personne.
--      On garde une première et une dernière observation, pas plus.
--   5. LA CONSERVATION EST BORNÉE : un domaine qui cesse d'être vu
--      disparaît au bout du délai configuré.
--
-- Ce qui reste est un RELEVÉ D'USAGE : « ce poste contacte dropbox.com,
-- 340 fois depuis le 2 septembre ». C'est ce qu'il faut pour faire de la
-- sécurité. Ce n'est pas de quoi reconstituer une navigation.
--
-- LA DÉCISION D'ACTIVER APPARTIENT AU CLIENT, et informer les personnes
-- concernées lui appartient aussi. La plateforme ne peut pas prendre
-- cette décision à sa place ; elle peut refuser de la prendre en douce.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS OBSERVATION_DNS (
  id_observation  INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  -- Domaine ENREGISTRABLE uniquement. La colonne est volontairement
  -- courte : elle ne doit pas pouvoir accueillir un nom complet.
  domaine         VARCHAR(120) NOT NULL,
  categorie       VARCHAR(40) DEFAULT NULL COMMENT "collaboration, minage, acces_distant... ; NULL = domaine inconnu, PAS suspect",
  -- Un compteur, jamais une ligne par requête. Un poste ordinaire fait
  -- plusieurs milliers de requêtes par jour : les journaliser une à une
  -- remplirait la base et produirait exactement le document qu'on refuse.
  compteur        BIGINT NOT NULL DEFAULT 1,
  premiere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  derniere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_observation (id_equipement, domaine),
  KEY idx_observation_domaine (domaine),
  KEY idx_observation_vue (derniere_vue),
  CONSTRAINT fk_observation_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ce qui mérite un regard. Séparé des observations : une machine peut
-- contacter deux mille domaines sans qu'aucun ne pose question, et
-- l'écran de sécurité ne doit montrer que ce qui en vaut la peine.
CREATE TABLE IF NOT EXISTS SIGNAL_DNS (
  id_signal       INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  code            VARCHAR(40) NOT NULL COMMENT "minage, acces_distant, transport_dns, nom_improbable...",
  gravite         VARCHAR(20) NOT NULL DEFAULT 'avertissement',
  domaine         VARCHAR(120) DEFAULT NULL,
  -- La phrase qui dit POURQUOI le signal s'est déclenché. Sans elle, un
  -- signal déduit d'une heuristique est indéfendable devant le client
  -- qui le conteste — et ces heuristiques se trompent parfois.
  detail          VARCHAR(400) DEFAULT NULL,
  occurrences     INT NOT NULL DEFAULT 1,
  premiere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  derniere_vue    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_signal (id_equipement, code, domaine),
  KEY idx_signal_gravite (gravite, derniere_vue),
  CONSTRAINT fk_signal_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- L'interrupteur, site par site, éteint par défaut.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'SITE'
    AND column_name = 'observation_dns'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE SITE
     ADD COLUMN observation_dns TINYINT(1) NOT NULL DEFAULT 0
       COMMENT "0 = le resolveur ne journalise rien, comportement d origine",
     ADD COLUMN observation_dns_depuis DATETIME DEFAULT NULL
       COMMENT "quand l observation a ete activee, et par extension depuis quand des donnees existent"',
  'SELECT "colonnes d observation DNS deja presentes"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Durée de conservation, modifiable depuis la page Configuration.
-- 90 jours : assez pour voir une habitude s'installer, trop court pour
-- constituer un historique de comportement sur l'année.
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description)
VALUES ('retention_observations_dns_jours', '90',
        'Jours de conservation des domaines contactes. Au-dela, un domaine qui cesse d etre vu est efface.');
