-- =====================================================================
-- Correction des données faussées par la supervision centrale des sites
-- distants.
--
-- CONTEXTE
-- Le serveur central pinguait tous les équipements, y compris ceux des
-- sites distants, injoignables par construction. Ces machines ont donc
-- été marquées `down` en permanence et ont généré des alertes
-- `equipement_down` qui ne correspondent à aucune panne réelle.
--
-- Le code est corrigé : le central ne supervise plus que les sites
-- locaux. Restent les données déjà écrites, qu'il faut nettoyer.
--
-- ORDRE : exécuter les CONSTATS (1 à 3) d'abord, décider, puis les
-- corrections (4 à 6). Aucune modification de structure.
-- =====================================================================

USE NetSecureManager;


-- =====================================================================
-- CONSTATS — ne modifient rien
-- =====================================================================

-- 1) Quels sites sont supervisés par agent ?
--    C'est le critère utilisé par le code : dernier_push renseigné.
SELECT id_site, nom, ville, dernier_push,
       CASE WHEN dernier_push IS NULL
            THEN 'LOCAL — supervisé par le serveur central'
            ELSE 'AGENT — supervisé sur place'
       END AS mode_supervision
FROM SITE
ORDER BY dernier_push IS NULL DESC, nom;

-- Si un site distant apparaît en « LOCAL », c'est que son agent n'a
-- jamais réussi un seul push. Vérifier son installation AVANT de
-- poursuivre : le nettoyage ci-dessous ne le concernerait pas.


-- 2) Combien d'équipements distants sont marqués hors ligne à tort ?
SELECT s.nom AS site,
       COUNT(*) AS equipements,
       SUM(e.statut = 'down') AS marques_down,
       SUM(e.statut = 'up') AS marques_up
FROM EQUIPEMENT e
JOIN SITE s ON s.id_site = e.id_site
WHERE s.dernier_push IS NOT NULL
GROUP BY s.id_site, s.nom;


-- 3) Combien d'alertes d'indisponibilité sont à mettre en doute ?
--    Toutes celles portant sur un équipement d'un site à agent sont
--    suspectes : elles proviennent du ping central, qui ne pouvait pas
--    aboutir.
SELECT s.nom AS site,
       COUNT(*) AS alertes_suspectes,
       SUM(a.statut = 'active') AS encore_actives,
       MIN(a.date_creation) AS plus_ancienne,
       ROUND(SUM(TIMESTAMPDIFF(MINUTE, a.date_creation,
             COALESCE(a.date_resolution, NOW()))) / 60) AS heures_indispo_fictives
FROM ALERTE a
JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
JOIN SITE s ON s.id_site = e.id_site
WHERE a.type_alerte = 'equipement_down'
  AND s.dernier_push IS NOT NULL
GROUP BY s.id_site, s.nom;

-- La colonne `heures_indispo_fictives` est ce qui pollue le taux de
-- disponibilité de ces équipements. Voir la note en fin de fichier.


-- =====================================================================
-- CORRECTIONS — à exécuter après lecture des constats
-- =====================================================================

-- 4) Remettre les équipements distants dans un état honnête.
--
--    `inconnu` et non `up` : le serveur n'a jamais rien observé de fiable
--    sur ces machines. Les déclarer en ligne serait aussi faux que de les
--    déclarer hors ligne. Le premier push de l'agent les repassera à `up`
--    ou `down` selon ce qu'il constate réellement sur place.
UPDATE EQUIPEMENT e
JOIN SITE s ON s.id_site = e.id_site
SET e.statut = 'inconnu', e.echecs_consecutifs = 0
WHERE s.dernier_push IS NOT NULL;


-- 5) Clôturer les alertes fictives encore actives.
--    Étape sûre et réversible dans les faits : rien n'est supprimé.
UPDATE ALERTE a
JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
JOIN SITE s ON s.id_site = e.id_site
SET a.statut = 'resolue', a.date_resolution = NOW()
WHERE a.type_alerte = 'equipement_down'
  AND a.statut = 'active'
  AND s.dernier_push IS NOT NULL;


-- 6) SUPPRIMER les alertes fictives — À DÉCIDER, destructif.
--
--    Pourquoi le faire : le taux de disponibilité se calcule à partir de
--    la durée des alertes `equipement_down`. Tant que ces alertes
--    existent, les équipements distants afficheront un taux proche de
--    0 % pendant 30 jours, alors qu'ils n'ont jamais eu de panne.
--    Les clôturer (étape 5) ne suffit pas : la durée reste comptée.
--
--    Pourquoi hésiter : on efface un historique. Si une panne réelle a
--    eu lieu sur cette période, sa trace disparaît aussi — mais elle
--    était de toute façon noyée dans le bruit.
--
--    Les INCIDENT liés partent en cascade (ON DELETE CASCADE).
--
--    ⚠ Sauvegarder d'abord :
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
-- DELETE a FROM ALERTE a
-- JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
-- JOIN SITE s ON s.id_site = e.id_site
-- WHERE a.type_alerte = 'equipement_down'
--   AND s.dernier_push IS NOT NULL;
--
--    Variante prudente — ne supprimer que les alertes antérieures à la
--    correction, en gardant celles créées depuis (qui viennent de
--    l'agent et sont donc justes) :
--
-- DELETE a FROM ALERTE a
-- JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
-- JOIN SITE s ON s.id_site = e.id_site
-- WHERE a.type_alerte = 'equipement_down'
--   AND s.dernier_push IS NOT NULL
--   AND a.date_creation < '2026-08-12 00:00:00';   -- adapter la date


-- =====================================================================
-- EFFET SUR LES TAUX DE DISPONIBILITÉ
--
-- Tout taux affiché jusqu'ici pour un équipement de site distant est
-- faux, et proche de 0 %. Trois cas après correction :
--
--   • Étape 6 exécutée      -> les taux redeviennent justes immédiatement.
--   • Étape 5 seule         -> les taux restent faussés tant que les
--                              alertes fictives sont dans la fenêtre
--                              demandée (30 jours par défaut). Ils se
--                              corrigent d'eux-mêmes en glissant hors
--                              fenêtre. Une période de 7 jours redevient
--                              juste plus vite.
--   • Rien de fait          -> les taux restent faux indéfiniment, car
--                              une alerte encore active compte jusqu'à
--                              l'instant présent.
--
-- Les équipements des sites LOCAUX ne sont concernés par aucun de ces
-- points : leur supervision était correcte depuis le début.
-- =====================================================================


-- =====================================================================
-- CONTRÔLE APRÈS REDÉMARRAGE
--
-- 1) Le cycle central ne doit plus toucher aux sites à agent. Après une
--    minute de fonctionnement, aucun relevé nouveau ne doit apparaître
--    pour eux :
--
--      SELECT s.nom, COUNT(r.id_releve) AS releves_derniere_heure
--      FROM SITE s
--      LEFT JOIN EQUIPEMENT e ON e.id_site = s.id_site
--      LEFT JOIN RELEVE r ON r.id_equipement = e.id_equipement
--                        AND r.date_releve >= NOW() - INTERVAL 1 HOUR
--      GROUP BY s.id_site, s.nom;
--
--    Un site à agent doit afficher 0 : le central ne le sonde plus, et
--    l'agent ne remonte pas de relevés de performance (seulement des
--    statuts).
--
-- 2) Après le premier push d'un agent mis à jour, la réponse doit
--    contenir "statut_deduit": true. Si elle contient false, l'agent
--    n'a pas été redéployé : il fonctionne toujours, mais le serveur ne
--    peut pas déclarer un équipement hors ligne.
-- =====================================================================
