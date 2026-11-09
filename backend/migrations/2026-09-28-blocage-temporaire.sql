-- ---------------------------------------------------------------------
-- 2026-09-28 — Un blocage qui s'éteint tout seul.
--
-- POURQUOI CETTE MIGRATION EXISTE
--
-- Le contrôle d'accès web savait bloquer un domaine. Il ne savait pas
-- ARRÊTER de le bloquer.
--
-- Ça n'a l'air de rien, et c'est ce qui tue les filtrages en entreprise.
-- Le scénario se répète partout : on bloque un domaine « le temps de
-- régler un problème », personne ne le retire, et six mois plus tard une
-- application métier ne fonctionne plus sans que quiconque fasse le
-- rapprochement. La règle est toujours là, son auteur est parti, son
-- motif est oublié. On passe alors une journée à chercher une panne
-- réseau qui est une décision administrative vieille d'un semestre.
--
-- Trois colonnes suffisent à rendre ça impossible.
--
--   date_fin  quand la règle cesse de s'appliquer. NULL = permanent,
--             ce qui reste légitime — mais devient un CHOIX, affiché
--             comme tel, au lieu d'être le seul comportement possible.
--
--   cree_par  qui a décidé. `tracer()` le note déjà dans le journal,
--             mais un journal se consulte par date, pas par règle :
--             six mois plus tard, personne ne retrouve la ligne. Ici,
--             le nom est À CÔTÉ de la règle qu'on regarde.
--
--   origine   d'où vient la décision — saisie à la main, ou posée depuis
--             la page Bande passante après avoir constaté une
--             consommation. Cette distinction n'est pas décorative :
--             elle permettra de dire « cette règle a été créée parce que
--             ce domaine consommait 62 % du lien », ce qu'aucun
--             commentaire écrit à la main ne redira aussi fidèlement.
--
-- ── L'EXPIRATION EST APPLIQUÉE À LA LECTURE ─────────────────────────
--
-- Pas de tâche planifiée : une règle expirée est retirée à la première
-- lecture de la politique, qui incrémente alors `version`. Les agents
-- voient donc une nouvelle version et retéléchargent la configuration
-- dans la minute. Un blocage qui expire à 18 h cesse effectivement à
-- 18 h, sans que rien n'ait eu à se réveiller pour ça.
--
-- REJOUABLE SANS RISQUE : chaque colonne n'est ajoutée que si elle
-- manque. Les règles existantes restent permanentes (date_fin à NULL),
-- ce qui est exactement leur comportement d'aujourd'hui.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'POLITIQUE_DOMAINE'
     AND COLUMN_NAME = 'date_fin'
);

SET @sql := IF(
  @existe = 0,
  'ALTER TABLE POLITIQUE_DOMAINE
     ADD COLUMN date_fin DATETIME DEFAULT NULL
     COMMENT ''NULL = permanent. Sinon, la règle cesse de s''''appliquer à cette date.''',
  'SELECT ''Colonne date_fin déjà présente'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'POLITIQUE_DOMAINE'
     AND COLUMN_NAME = 'cree_par'
);

SET @sql := IF(
  @existe = 0,
  'ALTER TABLE POLITIQUE_DOMAINE
     ADD COLUMN cree_par INT DEFAULT NULL
     COMMENT ''Utilisateur à l''''origine de la règle. NULL pour les règles antérieures.''',
  'SELECT ''Colonne cree_par déjà présente'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'POLITIQUE_DOMAINE'
     AND COLUMN_NAME = 'origine'
);

SET @sql := IF(
  @existe = 0,
  'ALTER TABLE POLITIQUE_DOMAINE
     ADD COLUMN origine VARCHAR(40) NOT NULL DEFAULT ''manuel''
     COMMENT ''manuel, ou bande_passante quand la règle vient d''''un constat de consommation.''',
  'SELECT ''Colonne origine déjà présente'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


-- Index sur la date de fin : la lecture de politique commence par
-- chercher les règles expirées, et elle a lieu à chaque interrogation
-- d'agent.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'POLITIQUE_DOMAINE'
     AND INDEX_NAME = 'idx_politique_domaine_fin'
);

SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_politique_domaine_fin ON POLITIQUE_DOMAINE (date_fin)',
  'SELECT ''Index idx_politique_domaine_fin déjà présent'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;
