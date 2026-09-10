-- ---------------------------------------------------------------------
-- 2026-09-10 — Les failles connues, rattachées à une VERSION.
--
-- POURQUOI DEUX TABLES ET PAS UNE
--
-- FAILLE_LOGICIEL garde ce qu'on a TROUVÉ.
-- INTERROGATION_FAILLES garde ce qu'on a CHERCHÉ.
--
-- Sans la seconde, un équipement sans faille affichée est indiscernable
-- d'un équipement qu'on n'a jamais interrogé. Les deux montrent une liste
-- vide, et l'un des deux est rassurant à tort. C'est exactement le défaut
-- qui a déjà coûté 111 machines supervisées par personne sur ce projet :
-- une absence de signal lue comme une absence de problème.
--
-- Un outil de sécurité qui rassure sans avoir regardé est pire
-- qu'inutile. La plateforme doit pouvoir écrire, mot pour mot :
-- « OpenSSH 8.2 : interrogé le 10 septembre, 3 failles connues » ou
-- « OpenSSH 8.2 : jamais interrogé ».
--
-- D'OÙ VIENNENT CES DONNÉES
--
-- Du NVD (National Vulnerability Database, NIST) — la base publique de
-- référence. RIEN n'est déduit, inventé ni estimé ici : chaque ligne
-- porte son numéro CVE, son score officiel et sa date de publication, et
-- se vérifie sur nvd.nist.gov en un clic.
--
-- La table reste VIDE tant que `node tools\importer-failles.js` n'a pas
-- été lancé, et cet import demande un accès internet. Une plateforme
-- livrée avec une base de failles figée serait périmée le jour de son
-- installation.
--
-- LA LIMITE, ÉCRITE ICI ET AFFICHÉE À L'ÉCRAN
--
-- Le rapprochement se fait sur la version NUMÉRIQUE annoncée par le
-- service (« 8.2 » pour « OpenSSH 8.2p1 »). Le niveau de correctif n'est
-- pas distingué : une faille corrigée par un correctif peut donc
-- apparaître alors qu'elle ne s'applique plus. C'est pourquoi l'écran
-- parle de « failles connues à vérifier » et jamais de « machine
-- vulnérable » : la plateforme signale ce qu'il faut aller regarder, elle
-- ne prononce pas de verdict.
--
-- CE QUE CETTE MIGRATION NE TOUCHE PAS
--
-- VULNERABILITE_CONNUE reste ce qu'elle est : les risques liés au
-- PROTOCOLE (Telnet en clair, SMB exposé), vrais quelle que soit la
-- version. Les deux notions sont différentes et ne doivent pas se mêler
-- dans une même table.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS FAILLE_LOGICIEL (
  id_faille     INT AUTO_INCREMENT PRIMARY KEY,
  -- Le couple (produit, version) tel que le service l'a ANNONCÉ : c'est
  -- la clé qui relie cette table à SERVICE_DETECTE, et elle doit donc
  -- être écrite exactement comme la bannière l'a donnée.
  produit       VARCHAR(120) NOT NULL,
  version       VARCHAR(60)  NOT NULL,
  cve_id        VARCHAR(30)  NOT NULL,
  severite      VARCHAR(20)  DEFAULT NULL COMMENT "LOW | MEDIUM | HIGH | CRITICAL, tel que publie",
  score         DECIMAL(3,1) DEFAULT NULL COMMENT "score CVSS officiel, jamais recalcule",
  description   TEXT         DEFAULT NULL,
  publie        DATE         DEFAULT NULL,
  -- La chaîne CPE exactement telle qu'elle a été interrogée. Sans elle,
  -- un rapprochement contesté serait indéfendable : on ne pourrait pas
  -- rejouer la requête qui l'a produit.
  cpe           VARCHAR(200) DEFAULT NULL,
  source        VARCHAR(40)  NOT NULL DEFAULT 'NVD',
  date_import   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_faille (produit, version, cve_id),
  KEY idx_faille_produit (produit, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS INTERROGATION_FAILLES (
  produit       VARCHAR(120) NOT NULL,
  version       VARCHAR(60)  NOT NULL,
  cpe           VARCHAR(200) DEFAULT NULL,
  -- 'ok'        la base a répondu — nb_resultats fait foi, 0 compris
  -- 'sans_cpe'  ce logiciel n'a pas de correspondance connue : on ne
  --             sait pas quoi demander, et on ne prétend pas le savoir
  -- 'erreur'    réseau ou service indisponible : on n'a PAS regardé
  statut        VARCHAR(20)  NOT NULL DEFAULT 'ok',
  nb_resultats  INT          NOT NULL DEFAULT 0,
  detail        VARCHAR(200) DEFAULT NULL,
  date_interrogation DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (produit, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
