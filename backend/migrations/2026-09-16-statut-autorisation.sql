-- ---------------------------------------------------------------------
-- 2026-09-16 — Le statut d'autorisation d'un équipement.
--
-- CE QUE CETTE COLONNE APPORTE
--
-- La plateforme sait dire qu'une machine EXISTE (preuve_existence), ce
-- qu'elle EST (type_source), comment elle s'APPELLE (nom_source) et qui
-- l'a FABRIQUÉE (fabricant_source). Elle ne sait pas dire si elle a le
-- DROIT d'être là.
--
-- C'est pourtant la première question d'un exploitant devant une liste de
-- quatre-vingt-douze adresses : lesquelles connaît-il ? Sans réponse,
-- l'inventaire reste une liste, et une machine branchée en douce s'y
-- fond sans que rien ne la distingue d'un poste légitime.
--
-- LA DÉCISION EST HUMAINE, ET C'EST VOULU. Rien dans le réseau ne dit
-- qu'un appareil est autorisé — aucun protocole ne porte cette
-- information. Elle ne peut donc pas être déduite : elle est saisie par
-- quelqu'un, datée, attribuée, et tracée au journal. La plateforme
-- n'invente pas un statut, elle enregistre un jugement.
--
-- LES SEPT VALEURS, ET POURQUOI CELLES-LÀ
--
--   nouveau      personne ne s'est encore prononcé. C'est la valeur par
--                défaut, et elle est honnête : « pas qualifié » n'est
--                pas « suspect ».
--   autorise     appartient au parc, connu et légitime.
--   a_verifier   doute explicite, à regarder. Distinct de `nouveau` :
--                ici quelqu'un a vu la machine et s'est posé la question.
--   invite       présence légitime mais temporaire (visiteur, prestataire).
--   personnel    appareil d'un employé, toléré, hors parc géré.
--   iot          imprimante, caméra, capteur — géré, mais pas un poste.
--   bloque       ne devrait pas être là. C'est le seul statut qui
--                appelle une action.
--
-- CE QUE LA COLONNE NE FAIT PAS. Elle ne bloque rien sur le réseau :
-- couper un accès demande un commutateur administrable ou un contrôleur
-- d'accès, que la plateforme n'a pas. `bloque` est une DÉCLARATION, pas
-- une exécution — et l'écran doit le dire ainsi.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'EQUIPEMENT'
    AND column_name = 'statut_autorisation'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE EQUIPEMENT
     ADD COLUMN statut_autorisation VARCHAR(16) NOT NULL DEFAULT "nouveau"
       COMMENT "nouveau | autorise | a_verifier | invite | personnel | iot | bloque",
     ADD COLUMN note_autorisation VARCHAR(200) DEFAULT NULL
       COMMENT "precision libre saisie par l exploitant",
     ADD COLUMN date_autorisation DATETIME DEFAULT NULL
       COMMENT "quand la decision a ete prise",
     ADD COLUMN id_utilisateur_autorisation INT DEFAULT NULL
       COMMENT "qui a pris la decision — pas de cle etrangere : la trace
                doit survivre a la suppression du compte",
     ADD COLUMN premiere_detection DATETIME DEFAULT NULL
       COMMENT "premiere apparition de cet equipement a l inventaire"',
  'SELECT "colonnes d autorisation deja presentes"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Un index sur le statut : l'écran filtrera dessus à chaque ouverture, et
-- sur un parc de plusieurs milliers de lignes un balayage complet se
-- ferait sentir. Créé seulement s'il n'existe pas — une migration se
-- rejoue sans casse.
SET @indexExiste := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE table_schema = DATABASE()
    AND table_name = 'EQUIPEMENT'
    AND index_name = 'idx_statut_autorisation'
);
SET @sqlIndex := IF(@indexExiste = 0,
  'CREATE INDEX idx_statut_autorisation ON EQUIPEMENT (statut_autorisation)',
  'SELECT "index deja present"');
PREPARE stmt2 FROM @sqlIndex; EXECUTE stmt2; DEALLOCATE PREPARE stmt2;

-- ---------------------------------------------------------------------
-- AUCUN STATUT N'EST DEVINÉ POUR L'EXISTANT.
--
-- La tentation serait de marquer « autorise » tout ce qui est déjà en
-- base, pour que l'écran s'ouvre propre. Ce serait exactement le
-- mensonge que ce projet refuse ailleurs : personne n'a examiné ces
-- machines, et un parc entier affiché « autorisé » sans que quiconque
-- l'ait décidé vaut moins que rien — il donne une assurance fausse.
--
-- Tout part donc à « nouveau », c'est-à-dire « pas encore qualifié ».
-- C'est vrai, et c'est précisément le travail que cette fonction existe
-- pour rendre possible.
--
-- MÊME RAISONNEMENT POUR `premiere_detection`, LAISSÉE VIDE.
--
-- On pourrait y recopier `derniere_decouverte` pour que la colonne soit
-- pleine. Ce serait écrire « vue pour la première fois aujourd'hui » sur
-- une machine présente depuis trois semaines — une date fausse, et
-- personne ne pourrait plus distinguer une vraie nouveauté d'un ancien
-- équipement redécouvert. Les lignes antérieures à cette migration
-- gardent donc une date vide, que l'écran affiche « inconnue (avant la
-- mise en place) ». Les suivantes seront datées à leur insertion.
-- ---------------------------------------------------------------------
