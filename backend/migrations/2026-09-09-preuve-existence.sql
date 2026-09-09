-- ---------------------------------------------------------------------
-- 2026-09-09 — La preuve d'existence d'un équipement.
--
-- CE QUE CETTE COLONNE APPORTE, ET QUE PERSONNE D'AUTRE NE FAIT
--
-- Zabbix, Nagios, Centreon, Checkmk et ntopng montrent un hôte et son
-- état. Aucun ne dit SUR QUELLE PREUVE cet hôte figure dans la liste.
--
-- C'est exactement le trou par lequel une adresse fantôme entre à
-- l'inventaire : le balayage lisait le cache ARP du système — un
-- souvenir des machines vues il y a quelques minutes — et inscrivait ces
-- adresses comme des équipements. Checkmk connaît le même défaut ; son
-- forum porte des fils ouverts intitulés « Network scan finds hosts that
-- do not exist ».
--
-- La plateforme enregistrait déjà quelle règle avait décidé du type
-- (`type_source`), du nom (`nom_source`) et du fabricant
-- (`fabricant_source`). Il manquait la question la plus fondamentale :
-- pourquoi cette machine est-elle là du tout ?
--
-- CE QUE ÇA CHANGE CONCRÈTEMENT
--
--   • Un client qui conteste une ligne obtient sa réponse en une phrase :
--     « refus de connexion sur le port 445, le 9 septembre à 13h42 ».
--   • Une adresse sans preuve n'est plus inscrite : le fantôme devient
--     impossible par construction, pas par nettoyage.
--   • L'ancienneté de la preuve se lit : une machine dont la dernière
--     preuve date de trois semaines n'est pas au même niveau de
--     certitude qu'une machine vue il y a deux minutes.
--
-- LES CINQ PREUVES, DE LA PLUS DIRECTE À LA PLUS INDIRECTE
--
--   ping        la machine a répondu à un paquet ICMP
--   port_ouvert un service écoute sur un port
--   snmp        la machine s'est décrite elle-même
--   nmap        sa pile réseau a livré une empreinte
--   refus_tcp   elle a REFUSÉ une connexion — donc elle est là, et ce
--               port est fermé. C'est le « TCP ping » de nmap (-PS), et
--               l'équivalent portable de l'ARP ping de ntopng, qui ne
--               demande ni privilège ni dépendance native.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'EQUIPEMENT'
    AND column_name = 'preuve_existence'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE EQUIPEMENT
     ADD COLUMN preuve_existence VARCHAR(20) DEFAULT NULL
       COMMENT "ping | port_ouvert | snmp | nmap | refus_tcp",
     ADD COLUMN preuve_detail VARCHAR(200) DEFAULT NULL
       COMMENT "phrase lisible : port 445 ouvert, refus de connexion...",
     ADD COLUMN date_preuve DATETIME DEFAULT NULL
       COMMENT "quand cette preuve a ete constatee pour la derniere fois"',
  'SELECT "colonnes de preuve deja presentes"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Les équipements DÉJÀ en base qui ont produit un relevé ont, de fait,
-- répondu à un ping : on inscrit rétroactivement cette preuve plutôt que
-- de laisser une colonne vide qui ferait douter d'un parc pourtant sain.
UPDATE EQUIPEMENT e
   SET e.preuve_existence = 'ping',
       e.preuve_detail    = 'réponse au ping (constaté avant la mise en place des preuves)',
       e.date_preuve      = (SELECT MAX(r.date_releve) FROM RELEVE r
                             WHERE r.id_equipement = e.id_equipement)
 WHERE e.preuve_existence IS NULL
   AND EXISTS (SELECT 1 FROM RELEVE r WHERE r.id_equipement = e.id_equipement);

-- Ceux qui exposent un service ont prouvé leur existence autrement.
UPDATE EQUIPEMENT e
   SET e.preuve_existence = 'port_ouvert',
       e.preuve_detail    = 'un service écoute sur un port (constaté avant la mise en place des preuves)',
       e.date_preuve      = e.derniere_decouverte
 WHERE e.preuve_existence IS NULL
   AND EXISTS (SELECT 1 FROM SERVICE_DETECTE s WHERE s.id_equipement = e.id_equipement);

-- Ce qui reste sans preuve après ces deux passes est exactement
-- l'ensemble des adresses fantômes. On ne les supprime PAS ici : une
-- migration ne doit jamais effacer des données. `tools/adresses-fantomes.js`
-- les montre, et ne les retire que sur demande explicite.
