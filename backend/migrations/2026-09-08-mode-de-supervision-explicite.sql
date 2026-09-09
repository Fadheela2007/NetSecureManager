-- ---------------------------------------------------------------------
-- 2026-09-08 — Le mode de supervision d'un site devient explicite.
--
-- LE DÉFAUT CORRIGÉ
--
-- Le cycle central excluait tout site dont `dernier_push` était
-- renseigné, en déduisant « ce site a un agent, ce n'est pas mon
-- travail ». Or `dernier_push` n'est pas une déclaration d'intention :
-- c'est la trace d'un envoi. Lancer un agent une seule fois, pour un
-- essai, sur un site LOCAL, suffisait à l'exclure définitivement de la
-- supervision centrale.
--
-- Constaté en conditions réelles : un agent lancé un jeudi soir pour
-- tester le blocage web, arrêté cinq minutes plus tard. Résultat, 135
-- équipements plus surveillés par personne pendant quatre jours — aucun
-- relevé, aucun graphique, aucune alerte possible. Le serveur l'annonçait
-- au démarrage, mais il fallait avoir lu ce message.
--
-- CE QUI CHANGE
--
-- Une colonne dit désormais ce qu'on VEUT, au lieu de le déduire de ce
-- qui s'est passé. Un essai d'agent ne modifie plus le mode de
-- supervision d'un site : seule une décision explicite le fait.
--
-- `dernier_push` reste, et garde son rôle : savoir si un agent déclaré
-- transmet encore. C'est ce qui alimente l'alerte « agent muet ».
--
-- VALEUR INITIALE, ET POURQUOI CELLE-LÀ
--
-- On ne recopie pas bêtement « dernier_push IS NOT NULL » : cela
-- figerait précisément l'état défectueux qu'on corrige. On regarde si
-- l'agent transmet ENCORE — moins de trente minutes, le même seuil que
-- l'alerte « agent muet ».
--
--   agent actif    -> supervision_par_agent = TRUE  (comportement inchangé)
--   agent silencieux -> FALSE : le central reprend la main
--
-- Un site distant dont l'agent tourne n'est donc pas perturbé. Un site
-- dont l'agent est arrêté redevient supervisé — ce qui est toujours
-- mieux que de n'être supervisé par personne.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE table_schema = DATABASE()
    AND table_name = 'SITE'
    AND column_name = 'supervision_par_agent'
);
SET @sql := IF(@existe = 0,
  'ALTER TABLE SITE ADD COLUMN supervision_par_agent BOOLEAN NOT NULL DEFAULT FALSE
     COMMENT "TRUE = un agent local supervise ce site, le cycle central s abstient"',
  'SELECT "colonne supervision_par_agent déjà présente"');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Seuls les sites dont l'agent transmet ENCORE sont marqués. Les autres
-- repassent au central : ne pas superviser du tout n'est jamais la bonne
-- réponse.
UPDATE SITE
   SET supervision_par_agent = TRUE
 WHERE dernier_push IS NOT NULL
   AND dernier_push >= NOW() - INTERVAL 30 MINUTE;
