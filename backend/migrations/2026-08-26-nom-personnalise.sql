-- ---------------------------------------------------------------------
-- 2026-08-26 — Nom personnalisé d'équipement.
--
-- LE BESOIN
--
-- Les noms découverts automatiquement sont techniquement corrects et
-- humainement illisibles : les imprimantes du parc s'appellent
-- « KMBFD6FC », « KM287A2C », « NPI4DDD0A » — le nom d'usine dérivé de
-- l'adresse matérielle. Personne ne sait laquelle est celle de la
-- comptabilité.
--
-- POURQUOI UNE COLONNE SÉPARÉE, ET NON UNE MODIFICATION DE `nom`
--
-- Parce que le scan réécrit `nom` à chaque passage. Un nom saisi à la
-- main y serait effacé au scan suivant — et l'utilisateur, ayant vu son
-- travail disparaître sans explication, ne recommencerait pas.
--
-- Les deux valeurs coexistent donc : `nom` reste ce que le réseau
-- déclare, `nom_personnalise` ce que l'exploitant a décidé. L'interface
-- affiche le second quand il existe, et garde le premier en sous-titre —
-- car pour diagnostiquer, c'est le nom technique qui compte.
-- ---------------------------------------------------------------------

ALTER TABLE EQUIPEMENT
  ADD COLUMN nom_personnalise VARCHAR(150) NULL AFTER nom_source;

-- Recherche par nom personnalisé : la liste d'équipements filtre dessus,
-- et sur un parc de plusieurs centaines de lignes le balayage complet se
-- ressent à chaque frappe.
CREATE INDEX idx_equipement_nom_perso ON EQUIPEMENT (nom_personnalise);
