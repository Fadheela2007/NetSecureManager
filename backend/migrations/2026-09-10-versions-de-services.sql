-- ---------------------------------------------------------------------
-- 2026-09-10 — Le produit et sa version derrière chaque port ouvert.
--
-- CE QUE CETTE MIGRATION DÉBLOQUE
--
-- La migration du 7 septembre a refusé d'inscrire des numéros de CVE dans
-- ce produit, et sa justification était juste :
--
--   « Un scan de ports ne voit pas la version : il voit qu'un port
--     répond. Associer CVE-2021-… à “le port 445 est ouvert” serait une
--     affirmation fausse, et le premier technicien qui vérifierait la
--     référence cesserait de croire tout le reste du produit. »
--
-- Cette limite tombe ici, et elle tombe honnêtement : la plateforme ne
-- devine pas la version, elle LIT celle que la machine annonce
-- d'elle-même à la connexion.
--
--   SSH    « SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5 »
--   FTP    « 220 ProFTPD 1.3.5 Server ready »
--   SMTP   « 220 mail.exemple.fr ESMTP Postfix (Ubuntu) »
--   MySQL  la poignée de main, où la version est en clair
--   HTTP   l'en-tête « Server: Apache/2.4.41 (Ubuntu) »
--
-- « OpenSSH 7.4 » n'est plus « le port 22 est ouvert ». C'est une version
-- précise d'un logiciel précis — la seule chose à laquelle une faille
-- connue puisse être rattachée sans mentir.
--
-- POURQUOI LA BANNIÈRE BRUTE EST CONSERVÉE
--
-- Une bannière peut être personnalisée, tronquée ou volontairement
-- fausse : c'est une pratique d'administration courante. Garder le texte
-- reçu à côté de la version extraite permet de VÉRIFIER une version
-- contestée au lieu d'en débattre. Même principe que `type_source`,
-- `nom_source` et `preuve_existence` : la plateforme dit toujours d'où
-- vient ce qu'elle affiche.
--
-- CE QUE ÇA NE FAIT PAS
--
-- Aucune sonde d'attaque, aucune charge utile, aucune tentative
-- d'authentification : on ouvre une connexion — la même que le scan de
-- ports ouvre déjà — et on écoute. Un port muet coûte 1,2 seconde et rien
-- de plus. `nmap -sV` ferait mieux, en étant beaucoup plus bavard sur le
-- réseau ; ce parc est scanné avec une concurrence de 3 pour rester
-- discret, et ce choix-là est respecté.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'SERVICE_DETECTE'
    AND column_name = 'produit'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE SERVICE_DETECTE
     ADD COLUMN produit VARCHAR(120) DEFAULT NULL
       COMMENT "logiciel declare par le service : OpenSSH, Apache, Postfix...",
     ADD COLUMN version VARCHAR(60) DEFAULT NULL
       COMMENT "version declaree : 8.2p1, 2.4.41. NULL = le service ne la dit pas",
     ADD COLUMN version_source VARCHAR(20) DEFAULT NULL
       COMMENT "banniere | entete_http | nmap",
     ADD COLUMN banniere VARCHAR(200) DEFAULT NULL
       COMMENT "texte brut recu, pour verifier une version contestee",
     ADD COLUMN date_version DATETIME DEFAULT NULL
       COMMENT "quand cette version a ete lue pour la derniere fois"',
  'SELECT "colonnes de version deja presentes"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index sur le produit : la question « quelles machines exposent OpenSSH
-- et dans quelles versions ? » est celle que cette table existe pour
-- répondre, et elle sera posée sur tout le parc à la fois.
SET @existeIdx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'SERVICE_DETECTE'
    AND index_name = 'idx_service_produit'
);
SET @sql := IF(@existeIdx = 0,
  'ALTER TABLE SERVICE_DETECTE ADD KEY idx_service_produit (produit, version)',
  'SELECT "index idx_service_produit deja present"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Aucune donnée rétroactive n'est écrite ici, et c'est délibéré : une
-- version ne se déduit pas d'un numéro de port. Les colonnes restent
-- vides jusqu'au premier scan qui aura réellement lu une bannière. Une
-- case vide est honnête ; une case remplie par supposition ne l'est pas.
