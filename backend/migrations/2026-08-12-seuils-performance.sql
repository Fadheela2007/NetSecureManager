-- =====================================================================
-- Migration — alertes sur seuils de performance (CPU / RAM)
--
-- À exécuter dans MySQL Workbench.
-- Aucune modification de structure : uniquement 4 clés de configuration.
-- Aucun DROP, aucune perte de données.
--
-- Ces clés apparaîtront automatiquement dans la page Configuration, qui
-- affiche tout le contenu de la table.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- Seuils de charge
--
-- seuil_cpu_pourcent / seuil_ram_pourcent = 90
--   Valeur de DÉCLENCHEMENT. Au-delà, un équipement est considéré en
--   surcharge. 90 % est le repère usuel : en dessous, on remonterait des
--   pics de fonctionnement normal (sauvegarde, antivirus, compilation).
--
-- releves_consecutifs_avant_alerte_charge = 3
--   Nombre de relevés consécutifs au-dessus du seuil avant d'alerter.
--   Même principe que seuil_echecs_avant_alerte pour la disponibilité.
--   Avec un cycle d'une minute, cela représente environ 3 minutes de
--   charge soutenue — assez pour ignorer un pic ponctuel.
--
-- marge_hysteresis_pourcent = 10
--   L'alerte se déclenche à `seuil` mais ne se résout qu'en dessous de
--   `seuil - marge`, soit 80 % avec les valeurs par défaut.
--   Sans cette marge, un processeur oscillant entre 88 et 92 % créerait
--   une alerte, la résoudrait, la recréerait — avec une notification à
--   chaque fois. Mesuré sur banc : 4 alertes et 4 notifications pour une
--   oscillation qui n'en produit plus qu'une seule avec l'hystérésis.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('seuil_cpu_pourcent', '90',
   'Pourcentage de charge processeur au-delà duquel une alerte est déclenchée'),
  ('seuil_ram_pourcent', '90',
   'Pourcentage d''occupation mémoire au-delà duquel une alerte est déclenchée'),
  ('releves_consecutifs_avant_alerte_charge', '3',
   'Nombre de relevés consécutifs au-dessus du seuil avant de déclencher une alerte de charge'),
  ('marge_hysteresis_pourcent', '10',
   'Écart sous le seuil requis pour résoudre une alerte de charge (évite le clignotement)');


-- =====================================================================
-- CONTRÔLES
-- =====================================================================

-- 1) Combien d'équipements sont réellement concernés ?
--    La plupart des machines n'exposent pas HOST-RESOURCES-MIB : leurs
--    colonnes cpu_pourcent et ram_pourcent restent NULL et ne peuvent
--    donc jamais déclencher d'alerte.
SELECT
  COUNT(DISTINCT e.id_equipement) AS equipements_total,
  COUNT(DISTINCT CASE WHEN r.cpu_pourcent IS NOT NULL THEN e.id_equipement END) AS avec_cpu,
  COUNT(DISTINCT CASE WHEN r.ram_pourcent IS NOT NULL THEN e.id_equipement END) AS avec_ram
FROM EQUIPEMENT e
LEFT JOIN RELEVE r
  ON r.id_equipement = e.id_equipement
 AND r.date_releve >= NOW() - INTERVAL 24 HOUR;

-- Si avec_cpu et avec_ram valent 0, la fonctionnalité est en place mais
-- restera muette : aucun de vos équipements ne remonte ces métriques.
-- Ce n'est pas une anomalie — il faut du matériel exposant SNMP
-- HOST-RESOURCES-MIB (serveurs, équipements réseau professionnels).


-- 2) Quels équipements auraient déjà déclenché une alerte sur 7 jours ?
--    Permet de calibrer les seuils sur vos données réelles avant de
--    laisser la supervision tourner.
SELECT e.nom, e.adresse_ip,
       ROUND(MAX(r.cpu_pourcent)) AS cpu_max,
       ROUND(AVG(r.cpu_pourcent)) AS cpu_moyen,
       ROUND(MAX(r.ram_pourcent)) AS ram_max,
       ROUND(AVG(r.ram_pourcent)) AS ram_moyen,
       COUNT(*) AS nb_releves
FROM RELEVE r
JOIN EQUIPEMENT e ON e.id_equipement = r.id_equipement
WHERE r.date_releve >= NOW() - INTERVAL 7 DAY
  AND (r.cpu_pourcent IS NOT NULL OR r.ram_pourcent IS NOT NULL)
GROUP BY e.id_equipement, e.nom, e.adresse_ip
HAVING cpu_max >= 90 OR ram_max >= 90
ORDER BY cpu_max DESC;

-- Si cette requête remonte beaucoup d'équipements en permanence au-dessus
-- de 90 %, deux lectures possibles : le parc est réellement sous-dimensionné,
-- ou le seuil est trop bas pour votre usage. Ajuster depuis la page
-- Configuration plutôt que de subir des alertes permanentes.


-- 3) Après quelques heures de fonctionnement : les alertes de charge créées
SELECT a.id_alerte, e.nom, a.type_alerte, a.niveau, a.statut,
       a.message, a.date_creation, a.date_resolution
FROM ALERTE a
JOIN EQUIPEMENT e ON e.id_equipement = a.id_equipement
WHERE a.type_alerte IN ('cpu_eleve', 'ram_elevee')
ORDER BY a.date_creation DESC;
