-- ---------------------------------------------------------------------
-- 2026-09-07 — Services exposés à risque.
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- La table VULNERABILITE_CONNUE était interrogée par
-- GET /api/equipements/:id/vulnerabilites, et la fiche d'un équipement
-- affichait « ⚠ Vulnérabilités potentielles détectées ». Or RIEN ne
-- remplissait cette table : aucun INSERT dans le schéma, aucun outil
-- d'import, aucun fichier de données. L'écran ne pouvait donc rien
-- afficher, jamais — dans un produit dont le nom promet la sécurité.
--
-- CE QU'ON N'A PAS FAIT, ET POURQUOI
--
-- Y insérer des numéros de CVE aurait été pire que la laisser vide. Une
-- CVE désigne une faille précise dans une version précise d'un logiciel.
-- Un scan de ports ne voit pas la version : il voit qu'un port répond.
-- Associer « CVE-2021-…  » à « le port 445 est ouvert » serait une
-- affirmation fausse, et le premier technicien qui vérifierait la
-- référence cesserait de croire tout le reste du produit.
--
-- CE QU'ON AFFIRME À LA PLACE
--
-- Ce qu'un scan permet réellement de constater : un service exposé qui
-- porte un risque connu par conception. Telnet n'a pas de faille — il
-- transmet les identifiants en clair, c'est son fonctionnement normal.
-- C'est vérifiable, ça ne dépend d'aucune version, et c'est actionnable.
--
-- La colonne `cve_id` est conservée (le code la lit) mais porte
-- désormais une référence interne explicite, du type « SVC-23-TELNET »,
-- qui ne peut pas être confondue avec une CVE.
--
-- IDEMPOTENCE : elle vient de la clé unique posée ci-dessous, combinée à
-- `INSERT IGNORE`. Relancer cette migration ne crée donc aucun doublon.
--
-- Une première version commençait par un `DELETE FROM` pour nettoyer
-- d'éventuelles insertions antérieures. C'était une mauvaise idée à deux
-- titres : l'outil `tools/appliquer-migrations.js` refuse — à raison —
-- toute instruction destructrice, et surtout une migration qui efface
-- avant d'écrire peut détruire des lignes ajoutées à la main par un
-- administrateur. L'idempotence doit venir de la contrainte, jamais d'un
-- effacement préalable.
-- ---------------------------------------------------------------------

-- Unicité (référence, port) — recommandée dans schema.sql, jamais posée.
-- Le bloc conditionnel évite l'échec si la clé existe déjà.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'VULNERABILITE_CONNUE'
    AND index_name = 'uk_vuln_ref_port'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE VULNERABILITE_CONNUE ADD UNIQUE KEY uk_vuln_ref_port (cve_id, port)',
  'SELECT "clé uk_vuln_ref_port déjà présente"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- Les risques retenus.
--
-- Chaque ligne est une affirmation VÉRIFIABLE sur le protocole lui-même,
-- pas une supposition sur un logiciel ou sa version. Aucune n'est
-- contestable par un administrateur réseau.
--
-- Sévérité : ce que l'exposition permet à un attaquant DÉJÀ présent sur
-- le réseau, pas une note absolue.
--   critique — les identifiants circulent en clair
--   haute    — accès direct à des données ou à une session
--   moyenne  — information exploitable, ou accès sans authentification
--   faible   — bonne pratique non respectée, sans exploitation directe
-- ---------------------------------------------------------------------
-- INSERT IGNORE : si la ligne existe déjà (clé unique ci-dessus), elle
-- est laissée telle quelle. Rejouer la migration est donc sans effet.
INSERT IGNORE INTO VULNERABILITE_CONNUE (cve_id, service, port, severite, description) VALUES

  ('SVC-23-TELNET', 'Telnet', 23, 'critique',
   'Telnet transmet le mot de passe en clair sur le réseau. Toute personne capable d''écouter le trafic le lit. À remplacer par SSH (port 22).'),

  ('SVC-21-FTP', 'FTP', 21, 'haute',
   'FTP transmet identifiants et fichiers sans chiffrement. À remplacer par SFTP ou FTPS.'),

  ('SVC-445-SMB', 'Partage de fichiers SMB', 445, 'haute',
   'Le partage de fichiers Windows est exposé. C''est la porte d''entrée privilégiée des rançongiciels sur un réseau interne. À restreindre aux machines qui en ont besoin.'),

  ('SVC-3389-RDP', 'Bureau à distance RDP', 3389, 'haute',
   'Le bureau à distance est accessible. Cible constante d''attaques par essais de mots de passe. À limiter par pare-feu et à protéger par une authentification forte.'),

  ('SVC-3306-MYSQL', 'Base de données MySQL', 3306, 'haute',
   'Une base de données répond sur le réseau. Une base ne devrait être joignable que depuis les serveurs applicatifs, jamais depuis un poste de travail.'),

  ('SVC-5432-PGSQL', 'Base de données PostgreSQL', 5432, 'haute',
   'Une base de données répond sur le réseau. Même remarque que pour MySQL : l''accès doit être restreint aux serveurs applicatifs.'),

  ('SVC-161-SNMP', 'SNMP', 161, 'moyenne',
   'L''équipement répond en SNMP. Si la communauté est restée « public », n''importe qui sur le réseau peut lire sa configuration. À vérifier, et à passer en SNMPv3 si le matériel le permet.'),

  ('SVC-110-POP3', 'POP3', 110, 'moyenne',
   'POP3 non chiffré : le mot de passe de messagerie circule en clair. À remplacer par POP3S (995).'),

  ('SVC-143-IMAP', 'IMAP', 143, 'moyenne',
   'IMAP non chiffré : le mot de passe de messagerie circule en clair. À remplacer par IMAPS (993).'),

  ('SVC-554-RTSP', 'Flux vidéo RTSP', 554, 'moyenne',
   'Un flux vidéo est exposé. Beaucoup de caméras le diffusent sans authentification, ou avec les identifiants d''usine. À vérifier sur l''équipement.'),

  ('SVC-9100-JETDIRECT', 'Impression brute', 9100, 'moyenne',
   'Le port d''impression brute accepte des travaux sans authentification. Permet d''imprimer à distance, et sur certains modèles de lire ou modifier la configuration.'),

  ('SVC-80-HTTP-ADMIN', 'Administration en HTTP', 80, 'faible',
   'Une interface web non chiffrée est exposée. Si elle sert à administrer l''équipement, le mot de passe circule en clair. À basculer en HTTPS quand le matériel le permet.');
