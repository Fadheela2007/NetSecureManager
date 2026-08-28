-- =====================================================================
-- Acquittement et dédoublonnage des alertes
--
-- Aucune suppression : l'historique reste intégralement en base et
-- continue d'alimenter le taux de disponibilité et les graphiques.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) Le statut « traitée »
--
-- ACQUITTER N'EST PAS SUPPRIMER. Une alerte acquittée sort de la file de
-- tri quotidienne mais reste comptabilisée partout ailleurs.
-- ---------------------------------------------------------------------
ALTER TABLE ALERTE
  MODIFY COLUMN statut ENUM('active','traitee','resolue') NOT NULL DEFAULT 'active';


-- ---------------------------------------------------------------------
-- 2) Compteur d'occurrences et dates
--
-- Un problème persistant produisait une alerte par cycle. Il produit
-- désormais UNE alerte dont le compteur monte.
--
-- premiere_detection ne bouge jamais : c'est elle qui répond à « depuis
-- quand ce serveur est-il tombé ? ».
-- ---------------------------------------------------------------------
ALTER TABLE ALERTE
  ADD COLUMN occurrences INT NOT NULL DEFAULT 1 AFTER cause_code,
  ADD COLUMN premiere_detection DATETIME NULL AFTER occurrences,
  ADD COLUMN derniere_occurrence DATETIME NULL AFTER premiere_detection,
  ADD COLUMN date_acquittement DATETIME NULL AFTER derniere_occurrence,
  ADD COLUMN acquittee_par INT NULL AFTER date_acquittement;

ALTER TABLE ALERTE
  ADD CONSTRAINT fk_alerte_acquittee_par
  FOREIGN KEY (acquittee_par) REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL;

-- Sert la recherche de doublon faite à chaque création d'alerte.
ALTER TABLE ALERTE
  ADD INDEX idx_alerte_dedoublonnage (id_equipement, type_alerte, statut);


-- ---------------------------------------------------------------------
-- 3) Renseigner l'existant
--
-- Les alertes déjà en base n'ont pas de dates : sans cette reprise,
-- elles remonteraient en bas de la liste (tri sur derniere_occurrence)
-- et sembleraient avoir disparu.
--
-- NOTE SUR `id_alerte > 0` — ce n'est pas un filtre, c'est une
-- concession à MySQL Workbench.
--
-- Workbench active par défaut le « safe update mode », qui refuse tout
-- UPDATE dont le WHERE ne porte pas sur une colonne indexée, et renvoie :
--
--   Error Code: 1175. You are using safe update mode and you tried to
--   update a table without a WHERE that uses a KEY column.
--
-- Le garde-fou est sain : il empêche d'écraser une table entière sur une
-- faute de frappe. Plutôt que de demander de le désactiver — on oublie
-- toujours de le réactiver, et la prochaine erreur passe alors sans
-- filet — on ajoute la clé primaire à la condition. `id_alerte > 0` est
-- vrai pour toutes les lignes (AUTO_INCREMENT commence à 1) : le
-- résultat est identique, et la requête passe partout.
-- ---------------------------------------------------------------------
UPDATE ALERTE
SET premiere_detection = COALESCE(premiere_detection, date_creation),
    derniere_occurrence = COALESCE(derniere_occurrence, date_creation)
WHERE id_alerte > 0
  AND (premiere_detection IS NULL OR derniere_occurrence IS NULL);


-- =====================================================================
-- 4) FUSION DES DOUBLONS DÉJÀ EN BASE
--
-- C'est ce qui vide réellement votre tableau de bord. Le correctif
-- empêche les nouveaux doublons ; celui-ci traite l'accumulation passée.
--
-- Regardez d'abord l'ampleur :
-- =====================================================================

SELECT e.nom, e.adresse_ip, a.type_alerte,
       COUNT(*) AS doublons,
       MIN(a.date_creation) AS premiere,
       MAX(a.date_creation) AS derniere
FROM ALERTE a
JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
WHERE a.statut <> 'resolue'
GROUP BY a.id_equipement, a.type_alerte, e.nom, e.adresse_ip
HAVING doublons > 1
ORDER BY doublons DESC;

-- Combien d'alertes disparaîtront de la file ?
SELECT COUNT(*) AS alertes_non_resolues,
       COUNT(DISTINCT CONCAT(a.id_equipement, '-', a.type_alerte)) AS problemes_reels,
       COUNT(*) - COUNT(DISTINCT CONCAT(a.id_equipement, '-', a.type_alerte)) AS doublons_a_fusionner
FROM ALERTE a
WHERE a.statut <> 'resolue' AND a.id_equipement IS NOT NULL;


-- ---------------------------------------------------------------------
-- La fusion elle-même. En deux temps pour rester lisible.
--
-- ⚠ Sauvegarder d'abord :
--   -- Méthode 1 (recommandée) : copie des tables DANS la base.
--   -- Aucun outil externe, tout se fait dans Workbench.
--   CREATE TABLE ALERTE_sauvegarde_20260819   AS SELECT * FROM ALERTE;
--   CREATE TABLE INCIDENT_sauvegarde_20260819 AS SELECT * FROM INCIDENT;
--
--   -- Pour revenir en arrière si besoin :
--   --   DELETE FROM ALERTE WHERE id_alerte > 0;
--   --   INSERT INTO ALERTE SELECT * FROM ALERTE_sauvegarde_20260819;
--
--   -- Pour supprimer la copie une fois rassuré, quelques jours plus tard :
--   --   DROP TABLE ALERTE_sauvegarde_20260819;
--
--   -- Méthode 2 : mysqldump, s'il est accessible.
--   -- Il n'est PAS dans le PATH par défaut sous Windows. Pour le trouver :
--   --   Get-ChildItem "C:\Program Files\MySQL" -Recurse -Filter mysqldump.exe |
--   --     Select-Object -First 1 -ExpandProperty FullName
--   -- puis appeler le chemin complet, entre guillemets et précédé de & :
--   --   & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" `
--   --       -u root -p NetSecureManager ALERTE INCIDENT > sauvegarde_alertes.sql
--
-- On garde l'alerte la plus ANCIENNE de chaque groupe (elle porte la
-- vraie date de première détection) et on lui affecte le nombre total
-- d'occurrences. Les autres sont marquées résolues plutôt que
-- supprimées : leur durée reste comptée dans le taux de disponibilité,
-- ce qui évite de réécrire l'histoire.
-- ---------------------------------------------------------------------

-- Étape A — reporter le compte et les dates sur l'alerte conservée
UPDATE ALERTE cible
JOIN (
  SELECT MIN(a.id_alerte) AS id_conservee,
         a.id_equipement, a.type_alerte,
         COUNT(*) AS total,
         MIN(a.date_creation) AS premiere,
         MAX(a.date_creation) AS derniere
  FROM ALERTE a
  WHERE a.statut <> 'resolue' AND a.id_equipement IS NOT NULL
  GROUP BY a.id_equipement, a.type_alerte
  HAVING COUNT(*) > 1
) grp ON grp.id_conservee = cible.id_alerte
SET cible.occurrences = grp.total,
    cible.premiere_detection = grp.premiere,
    cible.derniere_occurrence = grp.derniere;

-- Étape B — clôturer les doublons
UPDATE ALERTE doublon
JOIN (
  SELECT MIN(a.id_alerte) AS id_conservee, a.id_equipement, a.type_alerte
  FROM ALERTE a
  WHERE a.statut <> 'resolue' AND a.id_equipement IS NOT NULL
  GROUP BY a.id_equipement, a.type_alerte
  HAVING COUNT(*) > 1
) grp ON grp.id_equipement = doublon.id_equipement
     AND grp.type_alerte = doublon.type_alerte
SET doublon.statut = 'resolue',
    doublon.date_resolution = NOW()
-- `id_alerte > 0` : voir la note du point 3. Le safe update mode de
-- Workbench n'accepte pas `<>` sur la clé comme une condition de clé.
WHERE doublon.id_alerte > 0
  AND doublon.id_alerte <> grp.id_conservee
  AND doublon.statut <> 'resolue';


-- =====================================================================
-- 5) CONTRÔLE APRÈS FUSION
-- =====================================================================

SELECT statut, COUNT(*) AS alertes, SUM(occurrences) AS occurrences_cumulees
FROM ALERTE
GROUP BY statut;

-- Il ne doit plus rester aucun doublon non résolu :
SELECT COUNT(*) AS doublons_restants FROM (
  SELECT a.id_equipement, a.type_alerte
  FROM ALERTE a
  WHERE a.statut <> 'resolue' AND a.id_equipement IS NOT NULL
  GROUP BY a.id_equipement, a.type_alerte
  HAVING COUNT(*) > 1
) x;
-- doit renvoyer 0


-- =====================================================================
-- NOTE — la cause racine
--
-- Le dédoublonnage traite le symptôme au bon endroit, mais la cause
-- mérite d'être connue : routes/scan.js et server.js font
--
--   INSERT ... ON DUPLICATE KEY UPDATE ... statut = 'up'
--
-- Chaque scan remet donc à `up` un équipement que la supervision venait
-- de marquer `down`, ce qui réarme la transition et fait recréer une
-- alerte au cycle suivant. Avec le dédoublonnage, cela n'a plus d'effet
-- visible — mais le statut affiché peut osciller entre deux scans pour
-- une machine réellement hors ligne détectée via ARP.
--
-- Correction envisageable (non appliquée, changement de comportement) :
-- ne forcer `statut = 'up'` que si l'hôte a répondu au ping, et non
-- lorsqu'il a seulement été vu dans la table ARP.
-- =====================================================================
