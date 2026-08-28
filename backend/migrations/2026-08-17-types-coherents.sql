-- =====================================================================
-- Cohérence de la colonne Type
--
-- Trois corrections de données, aucune suppression de structure :
--   1) ajout de la catégorie « poste_travail », qui manquait
--   2) retrait des noms de méthode de la colonne Type
--   3) correction des postes Windows classés « serveur »
--
-- Les catégories `detecte_nmap` et `equipement_snmp` ne sont PAS
-- supprimées de TYPE_EQUIPEMENT : elles sont référencées par la clé
-- étrangère EQUIPEMENT.id_type. On les vide de leurs occupants, puis
-- vous pourrez les retirer si vous le souhaitez (dernière section).
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) La catégorie manquante
--
-- Le référentiel n'avait pas de « poste de travail ». C'est la raison
-- de fond pour laquelle tout ce qui tournait sous Windows était rangé
-- dans « serveur » : il n'existait aucune autre case.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO TYPE_EQUIPEMENT (libelle, description) VALUES
  ('poste_travail', 'Poste de travail (PC fixe ou portable)');


-- =====================================================================
-- CONSTAT AVANT CORRECTION
-- =====================================================================

SELECT COALESCE(t.libelle, 'aucun type') AS type_actuel,
       COUNT(*) AS equipements,
       CASE t.libelle
         WHEN 'detecte_nmap'    THEN 'nom de méthode — à corriger'
         WHEN 'equipement_snmp' THEN 'nom de méthode — à corriger'
         WHEN 'serveur'         THEN 'à vérifier : postes Windows possibles'
         ELSE 'catégorie valide'
       END AS diagnostic
FROM EQUIPEMENT e
LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
GROUP BY t.libelle
ORDER BY equipements DESC;


-- =====================================================================
-- CORRECTIONS
--
-- Le reclassement complet se fait par l'application, qui dispose de
-- toute la logique (texte SNMP, ports, nmap, fabricant) :
--
--     POST /api/equipements/reclasser-types
--
-- Les requêtes ci-dessous ne servent qu'à traiter les cas que le SQL
-- peut trancher seul, et à mesurer. Le reclassement applicatif reste
-- la référence : lancez-le après.
-- =====================================================================

-- 2) Les noms de méthode n'ont rien à faire dans la colonne Type.
--    On les bascule vers « inconnu » ; le reclassement applicatif
--    affinera ensuite ce qui peut l'être.
UPDATE EQUIPEMENT e
JOIN TYPE_EQUIPEMENT t_ancien ON t_ancien.id_type = e.id_type
JOIN TYPE_EQUIPEMENT t_nouveau ON t_nouveau.libelle = 'inconnu'
SET e.id_type = t_nouveau.id_type
WHERE t_ancien.libelle IN ('detecte_nmap', 'equipement_snmp');


-- 3) Les postes Windows rangés dans « serveur ».
--    Critère prudent : on ne déplace que ce qui porte un marqueur
--    explicite de version poste dans os_detecte ou sys_descr.
UPDATE EQUIPEMENT e
JOIN TYPE_EQUIPEMENT t_ancien ON t_ancien.id_type = e.id_type
JOIN TYPE_EQUIPEMENT t_nouveau ON t_nouveau.libelle = 'poste_travail'
SET e.id_type = t_nouveau.id_type
WHERE t_ancien.libelle = 'serveur'
  AND (
    CONCAT(COALESCE(e.os_detecte,''), ' ', COALESCE(e.sys_descr,'')) REGEXP
      'Windows (XP|Vista|7|8|8\\.1|10|11)([^0-9]|$)'
  )
  AND CONCAT(COALESCE(e.os_detecte,''), ' ', COALESCE(e.sys_descr,'')) NOT LIKE '%Windows Server%';


-- 4) Les « serveur » issus d'un sysDescr Windows sans marqueur de version.
--    Indécidable : ni serveur ni poste ne peut être affirmé.
--    ⚠ À exécuter seulement si vous acceptez de perdre une catégorie
--    affirmée au profit d'une absence de réponse. C'est le parti pris de
--    l'application : mieux vaut « inconnu » qu'une catégorie fausse.
--
-- UPDATE EQUIPEMENT e
-- JOIN TYPE_EQUIPEMENT t_ancien ON t_ancien.id_type = e.id_type
-- JOIN TYPE_EQUIPEMENT t_nouveau ON t_nouveau.libelle = 'inconnu'
-- SET e.id_type = t_nouveau.id_type
-- WHERE t_ancien.libelle = 'serveur'
--   AND CONCAT(COALESCE(e.os_detecte,''), ' ', COALESCE(e.sys_descr,'')) LIKE '%Windows%'
--   AND CONCAT(COALESCE(e.os_detecte,''), ' ', COALESCE(e.sys_descr,'')) NOT LIKE '%Windows Server%'
--   AND CONCAT(COALESCE(e.os_detecte,''), ' ', COALESCE(e.sys_descr,'')) NOT REGEXP
--       'Windows (XP|Vista|7|8|8\\.1|10|11)([^0-9]|$)';


-- =====================================================================
-- APRÈS LE RECLASSEMENT APPLICATIF
-- =====================================================================

SELECT COALESCE(t.libelle, 'aucun type') AS type,
       COUNT(*) AS equipements,
       ROUND(100 * COUNT(*) / (SELECT COUNT(*) FROM EQUIPEMENT)) AS pourcentage
FROM EQUIPEMENT e
LEFT JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
GROUP BY t.libelle
ORDER BY equipements DESC;

-- Ce qui reste en « inconnu » et pourquoi : aide à savoir si un nouveau
-- scan apporterait quelque chose.
SELECT
  COUNT(*) AS inconnus,
  SUM(e.sys_descr IS NOT NULL AND e.sys_descr <> '') AS ont_du_snmp,
  SUM(e.os_detecte IS NOT NULL AND e.os_detecte <> '') AS ont_du_nmap,
  SUM(e.fabricant IS NOT NULL AND e.fabricant <> '') AS ont_un_fabricant,
  SUM(EXISTS (SELECT 1 FROM SERVICE_DETECTE s WHERE s.id_equipement = e.id_equipement)) AS ont_des_ports
FROM EQUIPEMENT e
JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
WHERE t.libelle = 'inconnu';

-- Combien d'équipements n'ont AUCUN des nouveaux ports scannés ?
-- Ceux-là ne bénéficieront de la déduction par port qu'après un scan.
SELECT COUNT(*) AS sans_ports_revelateurs
FROM EQUIPEMENT e
WHERE NOT EXISTS (
  SELECT 1 FROM SERVICE_DETECTE s
  WHERE s.id_equipement = e.id_equipement AND s.port IN (515, 554, 631, 9100)
);


-- =====================================================================
-- FACULTATIF — retirer les anciennes pseudo-catégories
--
-- À faire seulement APRÈS le reclassement, et après avoir vérifié
-- qu'aucun équipement ne les référence plus (sinon la clé étrangère
-- refusera la suppression, ce qui est une protection bienvenue).
--
--   SELECT COUNT(*) FROM EQUIPEMENT e
--   JOIN TYPE_EQUIPEMENT t ON t.id_type = e.id_type
--   WHERE t.libelle IN ('detecte_nmap','equipement_snmp');
--   -- doit renvoyer 0
--
-- DELETE FROM TYPE_EQUIPEMENT WHERE libelle IN ('detecte_nmap', 'equipement_snmp');
-- =====================================================================
