-- ---------------------------------------------------------------------
-- 2026-08-26 — Origine du nom d'équipement, et nettoyage des faux noms.
--
-- CE QUI N'ALLAIT PAS
--
-- La colonne « nom » restait vide sur la quasi-totalité du parc : sans
-- SNMP — le cas de presque tous les postes Windows — la découverte
-- n'avait aucune source de nom. Une liste d'équipements réduite à des
-- adresses IP n'est pas exploitable.
--
-- Pire, à défaut de SNMP le nom retombait sur l'estimation de système
-- d'exploitation de nmap. La liste affichait donc des lignes comme
-- « 3Com OfficeConnect 3CRWER100-75 wireless broadband router (96%) » :
-- un modèle avec son taux de confiance, jamais un nom de machine.
--
-- CE QUE FAIT CETTE MIGRATION
--
--   1. ajoute `nom_source`, qui dit d'où vient le nom affiché ;
--   2. efface les faux noms hérités de nmap, reconnaissables à leur
--      taux de confiance entre parenthèses.
--
-- L'information de nmap n'est pas perdue : elle vit dans `os_detecte`,
-- qui est sa place légitime.
-- ---------------------------------------------------------------------

-- 1) Origine du nom : snmp, dns, netbios, ou NULL.
--
-- Même raisonnement que pour `type_source` et `fabricant_source` : une
-- valeur sans son origine ne se diagnostique pas. Quand un client
-- conteste un nom, la question « d'où sort-il ? » doit se répondre en
-- lisant une colonne, pas en relançant un scan.
ALTER TABLE EQUIPEMENT ADD COLUMN nom_source VARCHAR(20) NULL AFTER nom;

-- 2) Effacement des noms fabriqués à partir de l'estimation nmap.
--
-- Le critère est un taux de confiance en fin de chaîne — « (96%) » —
-- que nmap ajoute systématiquement et qu'aucun nom d'hôte réel ne
-- porte. On ne touche à rien d'autre : un nom saisi à la main ou venu
-- de SNMP doit survivre à cette migration.
UPDATE EQUIPEMENT
   SET nom = NULL
 WHERE nom REGEXP '\\([0-9]{1,3}%\\)[[:space:]]*$';

-- Cas résiduel : les noms strictement identiques à l'estimation nmap,
-- sans pourcentage. Même origine, même conclusion.
UPDATE EQUIPEMENT
   SET nom = NULL
 WHERE nom IS NOT NULL
   AND os_detecte IS NOT NULL
   AND nom = os_detecte;
