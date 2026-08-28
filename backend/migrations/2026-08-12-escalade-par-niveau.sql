-- =====================================================================
-- Filtrage de l'escalade en incident par niveau d'alerte
--
-- Aucune modification de structure : une clé de configuration, plus le
-- nettoyage des incidents déjà ouverts à tort.
--
-- Le code fonctionne SANS cette migration : en l'absence de la clé, il
-- retombe sur « critical » seul, qui est le comportement voulu. La clé
-- ne sert qu'à rendre le réglage visible et modifiable depuis l'écran
-- Configuration.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) La clé de configuration
--
-- Valeurs acceptées : liste séparée par des virgules parmi
-- info, warning, critical. Exemples :
--   'critical'            -> défaut, seules les vraies urgences
--   'warning,critical'    -> inclut les charges CPU/RAM soutenues
--
-- Une valeur vide ou invalide ne désactive PAS l'escalade : le code
-- journalise un avertissement et retombe sur 'critical'. Il n'est pas
-- possible de couper l'escalade par une faute de frappe.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('niveaux_escalade_incident', 'critical',
   'Niveaux d''alerte pouvant devenir des incidents (info, warning, critical — séparés par des virgules)');


-- =====================================================================
-- 2) CONSTAT — incidents ouverts à tort depuis les alertes de charge
--
-- Avant ce correctif, une charge processeur ou mémoire soutenue pendant
-- `seuil_escalade_minutes` ouvrait un incident. Une sauvegarde ou une
-- indexation nocturne suffisait.
-- =====================================================================

SELECT i.statut,
       a.niveau,
       a.type_alerte,
       COUNT(*) AS incidents,
       MIN(i.date_ouverture) AS plus_ancien,
       MAX(i.date_ouverture) AS plus_recent
FROM INCIDENT i
JOIN ALERTE a ON a.id_alerte = i.id_alerte
WHERE a.niveau <> 'critical'
GROUP BY i.statut, a.niveau, a.type_alerte
ORDER BY incidents DESC;

-- Rapport de bruit : part des incidents qui n'auraient plus lieu d'être.
SELECT
  COUNT(*) AS incidents_total,
  SUM(a.niveau = 'critical') AS vraies_urgences,
  SUM(a.niveau <> 'critical') AS bruit,
  CONCAT(ROUND(100 * SUM(a.niveau <> 'critical') / NULLIF(COUNT(*), 0)), ' %') AS part_de_bruit
FROM INCIDENT i
JOIN ALERTE a ON a.id_alerte = i.id_alerte;


-- =====================================================================
-- 3) NETTOYAGE — à décider
--
-- Le correctif empêche la création de NOUVEAUX incidents non critiques.
-- Ceux déjà ouverts restent dans la file : c'est justement le bruit que
-- vous vouliez faire disparaître.
-- =====================================================================

-- Option A (recommandée) — les clôturer. Rien n'est supprimé, la trace
-- reste consultable dans l'onglet « Fermés ».
UPDATE INCIDENT i
JOIN ALERTE a ON a.id_alerte = i.id_alerte
SET i.statut = 'ferme', i.date_fermeture = NOW()
WHERE a.niveau <> 'critical'
  AND i.statut <> 'ferme';

-- Option B — les supprimer, pour repartir d'une file d'incidents dont
-- l'historique ne contient que des urgences réelles.
--
-- ⚠ Destructif. Sauvegarder d'abord :
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
-- DELETE i FROM INCIDENT i
-- JOIN ALERTE a ON a.id_alerte = i.id_alerte
-- WHERE a.niveau <> 'critical';

-- Note : les ALERTES elles-mêmes ne sont pas touchées. Une charge
-- élevée reste visible dans la page Alertes avec ses pistes de
-- résolution, et continue de déclencher une notification. Seul le
-- dossier de suivi disparaît.


-- =====================================================================
-- 4) CONTRÔLE après redémarrage
--
-- Aucun incident ne doit plus apparaître pour une alerte non critique :
--
--   SELECT COUNT(*) AS incidents_non_critiques_recents
--   FROM INCIDENT i
--   JOIN ALERTE a ON a.id_alerte = i.id_alerte
--   WHERE a.niveau <> 'critical'
--     AND i.date_ouverture >= NOW() - INTERVAL 1 DAY;
--
-- Doit renvoyer 0.
--
-- Pour élargir plus tard depuis l'écran Configuration, remplacer la
-- valeur par 'warning,critical'. La prise en compte est immédiate au
-- passage suivant du cron d'escalade (5 minutes), sans redémarrage.
-- =====================================================================
