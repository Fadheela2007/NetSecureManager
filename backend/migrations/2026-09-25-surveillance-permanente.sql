-- ---------------------------------------------------------------------
-- 2026-09-25 — Un poste éteint n'est pas une panne.
--
-- LE DÉFAUT, ET IL EST GRAVE
--
-- La supervision alertait dès qu'une machine cessait de répondre, quel
-- que soit son rôle. Un employé qui éteint son poste en partant à 18 h
-- déclenchait donc une alerte critique. Sur un parc de quatre-vingt-dix
-- machines, cela fait des dizaines d'alertes chaque soir, et autant de
-- résolutions automatiques chaque matin.
--
-- Le résultat ne se mesure pas en lignes de base : il se mesure chez
-- l'exploitant, qui apprend en trois jours que le rouge ne veut rien
-- dire. Le jour où un serveur tombe, son alerte est noyée dans les
-- quarante autres. Un outil de supervision qui crie tout le temps est
-- pire qu'un outil qui se tait — il donne l'illusion d'être surveillé.
--
-- LA RÈGLE
--
-- On n'alerte que sur ce qui DOIT rester allumé : serveurs, imprimantes,
-- routeurs, commutateurs, pare-feu, caméras, téléphonie. Un poste de
-- travail qui s'éteint change d'état dans l'inventaire — il apparaît
-- hors ligne sur sa fiche et dans les listes — mais ne crée aucune
-- alerte et n'escalade en aucun incident.
--
-- POURQUOI UNE COLONNE PLUTÔT QU'UNE LISTE EN DUR
--
-- Le type décide par défaut, mais il existe des exceptions réelles : le
-- poste du directeur, celui qui pilote une machine de production, un PC
-- qui sert de serveur de sauvegarde. Cette colonne porte le choix
-- explicite de l'exploitant, et elle prime sur le type.
--
--   NULL  →  on suit le type (comportement par défaut)
--   1     →  surveiller en permanence, quoi qu'en dise le type
--   0     →  ne jamais alerter sur cette machine
--
-- Le NULL par défaut est volontaire : il distingue « personne n'a rien
-- dit » de « quelqu'un a décidé que non ». Deux informations
-- différentes, que 0 confondrait.
--
-- REJOUABLE SANS RISQUE : la colonne n'est ajoutée que si elle manque, et
-- aucune donnée existante n'est modifiée.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'EQUIPEMENT'
     AND COLUMN_NAME = 'surveillance_permanente'
);

SET @sql := IF(
  @existe = 0,
  'ALTER TABLE EQUIPEMENT
     ADD COLUMN surveillance_permanente TINYINT(1) DEFAULT NULL
     COMMENT ''NULL = selon le type, 1 = alerter toujours, 0 = ne jamais alerter''',
  'SELECT ''Colonne surveillance_permanente déjà présente'' AS info'
);

PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;

-- ---------------------------------------------------------------------
-- LES ALERTES DÉJÀ OUVERTES SUR DES POSTES SONT CLÔTURÉES.
--
-- Elles affirment une panne que la plateforme ne considère plus comme
-- telle. Les laisser actives contredirait la règle qu'on vient de poser,
-- et gonflerait le temps d'indisponibilité dans le calcul de
-- disponibilité. Elles ne sont pas SUPPRIMÉES : l'historique reste,
-- marqué résolu à la date d'aujourd'hui.
-- ---------------------------------------------------------------------
UPDATE ALERTE a
  JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
  LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
   SET a.statut = 'resolue', a.date_resolution = NOW()
 WHERE a.type_alerte = 'equipement_down'
   AND a.statut IN ('active', 'traitee')
   AND COALESCE(e.surveillance_permanente, 0) = 0
   AND COALESCE(t.libelle, 'inconnu') NOT IN
       ('serveur', 'imprimante', 'routeur', 'routeur/switch', 'pare-feu', 'camera', 'telephonie');
