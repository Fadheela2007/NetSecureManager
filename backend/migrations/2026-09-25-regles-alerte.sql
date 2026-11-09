-- ---------------------------------------------------------------------
-- 2026-09-25 — Les conditions d'alerte deviennent un réglage, pas du code.
--
-- CE QUI CHANGE
--
-- Jusqu'ici, la plateforme décidait seule de ce qui mérite une alerte et
-- de sa gravité : les seuils vivaient dans la table de configuration, les
-- niveaux étaient écrits en dur, et la liste des types qui doivent rester
-- allumés aussi. Un exploitant qui voulait « les imprimantes en
-- avertissement plutôt qu'en critique » devait ouvrir le code.
--
-- Cette table porte ces décisions. Une ligne = une condition, sa cible,
-- son seuil, sa gravité, et un interrupteur.
--
-- POURQUOI DES LIGNES SÉPARÉES PAR TYPE D'ÉQUIPEMENT
--
-- « Ne répond plus » n'a pas la même gravité pour un serveur et pour une
-- imprimante, et n'a aucun sens pour un poste de travail qu'on éteint le
-- soir. Une ligne par type permet de dire les trois, au lieu d'un réglage
-- unique qui aurait tort deux fois sur trois.
--
-- CE QUI EST SEMÉ ICI EST EXACTEMENT CE QUE LE MOTEUR APPLIQUE.
--
-- Quatre conditions, pas huit. Les quatre autres prévues — disque plein,
-- protection arrêtée, machine jamais redémarrée, certificat expirant —
-- ne sont pas encore évaluées par le cycle de supervision. Les afficher
-- comme « actives » ferait croire à une surveillance qui n'a pas lieu,
-- et c'est le défaut qu'on reproche aux autres outils.
--
-- SI CETTE TABLE EST VIDE OU ABSENTE, le comportement actuel s'applique.
-- Une installation ne doit jamais se retrouver sans supervision parce
-- qu'une ligne de réglage manque.
--
-- REJOUABLE SANS RISQUE : la table n'est créée que si elle manque, et les
-- lignes ne sont semées que si elles n'existent pas déjà — un réglage
-- modifié par l'exploitant n'est jamais réécrit.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS REGLE_ALERTE (
  id_regle       INT AUTO_INCREMENT PRIMARY KEY,

  -- La condition évaluée. Vocabulaire fermé, lu par le moteur.
  code           VARCHAR(40) NOT NULL,

  -- Sur quoi elle porte : un type d'équipement, ou 'tous'.
  cible          VARCHAR(40) NOT NULL DEFAULT 'tous',

  active         TINYINT(1) NOT NULL DEFAULT 1,

  -- Même vocabulaire que ALERTE.niveau : les deux se comparent.
  niveau         ENUM('critical','warning','info') NOT NULL DEFAULT 'warning',

  -- Seuil numérique, dont l'unité dépend de la condition : pourcentage
  -- pour la charge, minutes pour un agent muet, jours pour un certificat.
  -- NULL quand la condition n'en a pas besoin.
  seuil          DECIMAL(10,2) DEFAULT NULL,

  -- Durée pendant laquelle le seuil doit tenir, en nombre de relevés
  -- consécutifs. C'est ce qui sépare « un logiciel travaille » de « cette
  -- machine est en difficulté ».
  releves_requis INT DEFAULT NULL,

  -- Écrit pour l'humain, à côté du code lu par la machine.
  libelle        VARCHAR(120) NOT NULL,
  aide           VARCHAR(255) DEFAULT NULL,

  date_maj       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uniq_regle (code, cible)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── « NE RÉPOND PLUS », UNE LIGNE PAR TYPE ──────────────────────────
-- Les gravités reprennent ce que la plateforme faisait déjà, à une
-- exception près : l'imprimante passe en avertissement. Une imprimante
-- éteinte le soir n'est pas un incident de production.
INSERT INTO REGLE_ALERTE (code, cible, active, niveau, releves_requis, libelle, aide)
SELECT * FROM (
  SELECT 'equipement_down' AS code, 'serveur' AS cible, 1 AS active, 'critical' AS niveau,
         3 AS releves_requis, 'Un serveur ne répond plus' AS libelle,
         'Après trois vérifications sans réponse, et sans preuve contraire.' AS aide
  UNION ALL SELECT 'equipement_down', 'routeur', 1, 'critical', 3,
         'Un routeur ne répond plus', 'Sa disparition coupe un segment entier.'
  UNION ALL SELECT 'equipement_down', 'routeur/switch', 1, 'critical', 3,
         'Un commutateur ne répond plus', 'Sa disparition coupe les machines qui y sont branchées.'
  UNION ALL SELECT 'equipement_down', 'pare-feu', 1, 'critical', 3,
         'Un pare-feu ne répond plus', 'Sécurité et accès extérieur en dépendent.'
  UNION ALL SELECT 'equipement_down', 'imprimante', 1, 'warning', 3,
         'Une imprimante ne répond plus', 'Gênant, rarement urgent : souvent éteinte le soir.'
  UNION ALL SELECT 'equipement_down', 'camera', 1, 'warning', 3,
         'Une caméra ne répond plus', 'Une caméra muette ne filme plus.'
  UNION ALL SELECT 'equipement_down', 'telephonie', 1, 'warning', 3,
         'Un équipement de téléphonie ne répond plus', NULL
  UNION ALL SELECT 'equipement_down', 'poste_travail', 0, 'info', 3,
         'Un poste de travail ne répond plus',
         'Éteint par défaut : un poste s''éteint le soir, alerter là-dessus apprend à ignorer les alertes.'
  UNION ALL SELECT 'equipement_down', 'inconnu', 0, 'info', 3,
         'Une machine de type inconnu ne répond plus',
         'Éteint par défaut : on n''affirme pas une panne sur une machine dont on ignore le rôle.'
) AS semences
WHERE NOT EXISTS (
  SELECT 1 FROM REGLE_ALERTE r
   WHERE r.code = semences.code AND r.cible = semences.cible
);

-- ── CHARGE ET AGENT MUET ────────────────────────────────────────────
INSERT INTO REGLE_ALERTE (code, cible, active, niveau, seuil, releves_requis, libelle, aide)
SELECT * FROM (
  SELECT 'cpu' AS code, 'tous' AS cible, 1 AS active, 'warning' AS niveau,
         90.00 AS seuil, 3 AS releves_requis,
         'Processeur élevé' AS libelle,
         'La durée compte autant que le seuil : à 100 % pendant dix secondes, un logiciel travaille.' AS aide
  UNION ALL SELECT 'memoire', 'tous', 1, 'warning', 90.00, 3,
         'Mémoire élevée',
         'Une machine dont la mémoire ne redescend jamais est reconnue comme fonctionnant ainsi, sans alerte.'
  UNION ALL SELECT 'agent_muet', 'tous', 1, 'critical', 30.00, NULL,
         'L''agent d''un site ne transmet plus',
         'Seuil en minutes. Les équipements du site passent alors en « inconnu », jamais en panne.'
) AS semences
WHERE NOT EXISTS (
  SELECT 1 FROM REGLE_ALERTE r
   WHERE r.code = semences.code AND r.cible = semences.cible
);
