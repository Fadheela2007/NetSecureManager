-- ---------------------------------------------------------------------
-- 2026-09-10 — Les certificats des services chiffrés.
--
-- POURQUOI CETTE TABLE
--
-- Un certificat qui expire ne se dégrade pas : il coupe. Du jour au
-- lendemain l'intranet devient inaccessible, la messagerie refuse de se
-- connecter, et l'écran d'erreur du navigateur accuse le réseau. C'est
-- une panne qu'on voit venir trente jours à l'avance — ou jamais.
--
-- Nagios, Zabbix et Centreon ne surveillent pas les certificats
-- nativement : il faut leur ajouter une sonde ou un modèle. La
-- plateforme découvre déjà les ports ouverts ; lire le certificat de
-- ceux qui sont chiffrés ne coûte qu'une poignée de main de plus.
--
-- TROIS ÉTATS POUR `tls_ancien_accepte`, ET C'EST LE POINT DÉLICAT
--
-- La version de TLS NÉGOCIÉE ne dit rien de ce que le serveur
-- accepterait : c'est la meilleure que les deux savent parler. Un
-- serveur qui accepte encore TLS 1.0 négociera quand même TLS 1.3 avec
-- nous. On teste donc explicitement une connexion ancienne, et le
-- résultat se garde en trois états :
--
--   1     le serveur a accepté TLS 1.0 ou 1.1 — c'est une PREUVE
--   0     il a refusé, mais notre propre bibliothèque a pu refuser avant
--         lui : on ne peut PAS en conclure qu'il est sûr
--   NULL  le test n'a pas pu être mené
--
-- 0 et NULL s'affichent donc pareil, « non déterminé ». Écrire
-- « n'accepte pas les anciennes versions » sur la foi d'un refus dont on
-- ignore l'origine serait une affirmation de sécurité non vérifiée — le
-- genre de phrase qui vaut un audit raté au client qui l'a crue.
--
-- CE QU'ON NE STOCKE PAS : le nombre de jours restants. Il se recalcule
-- à chaque lecture. Stocké, il serait faux dès le lendemain — et une
-- valeur périmée qui a l'air fraîche est pire qu'une valeur absente.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS CERTIFICAT_TLS (
  id_certificat   INT AUTO_INCREMENT PRIMARY KEY,
  id_equipement   INT NOT NULL,
  port            INT NOT NULL,
  sujet           VARCHAR(255) DEFAULT NULL COMMENT "a qui le certificat est delivre",
  emetteur        VARCHAR(255) DEFAULT NULL COMMENT "autorite qui l a signe",
  valide_du       DATETIME DEFAULT NULL,
  valide_au       DATETIME DEFAULT NULL,
  auto_signe      TINYINT(1) DEFAULT NULL,
  taille_cle      INT DEFAULT NULL COMMENT "bits ; NULL pour une courbe elliptique, ce n est PAS une cle faible",
  courbe          VARCHAR(40) DEFAULT NULL,
  protocole       VARCHAR(20) DEFAULT NULL COMMENT "version negociee avec nous, pas celle acceptee au maximum",
  chiffrement     VARCHAR(60) DEFAULT NULL,
  tls_ancien_accepte TINYINT(1) DEFAULT NULL COMMENT "1 = prouve ; 0 = refuse sans certitude ; NULL = non teste",
  empreinte       VARCHAR(120) DEFAULT NULL COMMENT "sha256, pour reconnaitre un certificat remplace",
  noms_alternatifs VARCHAR(500) DEFAULT NULL,
  date_releve     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Un port ne présente qu'un certificat : la clé garantit qu'un rescan
  -- met à jour au lieu d'empiler des lignes identiques.
  UNIQUE KEY uk_certificat (id_equipement, port),
  -- « Quels certificats expirent le mois prochain ? » est LA question à
  -- laquelle cette table sert à répondre, et elle se pose sur tout le parc.
  KEY idx_certificat_expiration (valide_au),
  CONSTRAINT fk_certificat_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
