-- =====================================================================
-- Migration — consommation de bande passante par équipement
--
-- À exécuter dans MySQL Workbench, DANS CET ORDRE.
-- Aucun DROP, aucune suppression de colonne, aucune perte de données.
--
-- CE QUE CETTE MIGRATION REND POSSIBLE
-- Aujourd'hui, le débit n'est stocké que globalement, dans RELEVE. On sait
-- qu'un switch consomme, jamais PAR QUEL PORT. Ces colonnes portent la
-- mesure au niveau de l'interface : c'est ce qui permet de répondre à
-- « quel port sature » et non seulement « ça sature ».
--
-- IMPORTANT — la base réelle fait foi. Si une colonne existe déjà, MySQL
-- renvoie ER_DUP_FIELDNAME (1060) : ignorer l'erreur et passer à la
-- suivante. Chaque ALTER est isolé pour cette raison ; un ALTER groupé
-- échouerait en entier à cause d'une seule colonne déjà présente.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- ÉTAPE 0 (VÉRIFICATION — ne modifie rien)
--
-- Regarder ce qui existe déjà avant de toucher à quoi que ce soit.
-- ---------------------------------------------------------------------
SHOW COLUMNS FROM INTERFACE_RESEAU;


-- ---------------------------------------------------------------------
-- ÉTAPE 1 (obligatoire) — vitesse nominale du lien
--
-- Pourquoi c'est la colonne la plus importante des quatre : 50 000 kbit/s
-- ne veut rien dire dans l'absolu. C'est 5 % d'un lien gigabit — donc rien
-- — et 500 % d'un lien 10 Mbit/s — donc une saturation totale. Sans la
-- vitesse du lien, la plateforme affiche des chiffres que personne ne peut
-- interpréter.
--
-- Renseignée depuis ifSpeed (OID 1.3.6.1.2.1.2.2.1.5), converti en Mbit/s.
-- Reste NULL si l'équipement ne l'expose pas ou renvoie la valeur de
-- saturation 4294967295 (cas des liens > 4 Gbit/s, qui exigeraient
-- ifHighSpeed).
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN vitesse_mbps INT NULL AFTER etat_operationnel;


-- ---------------------------------------------------------------------
-- ÉTAPE 2 (obligatoire) — dernier débit mesuré, par interface
--
-- FLOAT et non INT : un débit calculé par différence de compteurs tombe
-- rarement sur un entier, et l'arrondi à l'unité écraserait les valeurs
-- faibles (un port à 0,4 kbit/s deviendrait 0, donc « inactif »).
--
-- NULL a un sens précis ici et doit être distingué de 0 :
--   NULL = pas encore mesurable (premier relevé après démarrage, l'agent
--          n'a pas de compteur précédent avec quoi faire la différence)
--   0    = mesuré, et il n'y a effectivement aucun trafic
-- Le code n'écrit jamais 0 à la place de NULL, et l'interface affiche
-- « — » dans le premier cas, « 0 » dans le second.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN trafic_entrant_kbps FLOAT NULL AFTER vitesse_mbps;

ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN trafic_sortant_kbps FLOAT NULL AFTER trafic_entrant_kbps;


-- ---------------------------------------------------------------------
-- ÉTAPE 3 (obligatoire) — date de la mesure
--
-- Sans elle, on ne peut pas distinguer « ce port est à 0 » de « ce port
-- était à 0 il y a trois jours, et l'agent est muet depuis ». C'est la
-- différence entre une information et un piège.
--
-- Elle n'avance QUE sur une vraie mesure : un cycle qui remonte NULL ne
-- touche ni les débits ni cette date (COALESCE côté serveur). L'écran
-- affiche donc toujours la dernière valeur valide, datée honnêtement.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD COLUMN date_trafic DATETIME NULL AFTER trafic_sortant_kbps;


-- ---------------------------------------------------------------------
-- ÉTAPE 4 (recommandé) — index pour le classement des ports
--
-- La fiche d'un équipement trie ses interfaces par débit décroissant pour
-- faire remonter le port qui sature. Sur un châssis à 48 ports c'est
-- indolore ; sur un parc de 40 switches interrogés simultanément, l'index
-- évite un balayage complet de la table à chaque ouverture de fiche.
--
-- Si l'index existe déjà : ER_DUP_KEYNAME (1061), ignorer.
-- ---------------------------------------------------------------------
ALTER TABLE INTERFACE_RESEAU
  ADD KEY idx_interface_trafic (id_equipement, trafic_entrant_kbps);


-- ---------------------------------------------------------------------
-- ÉTAPE 5 (recommandé) — index sur RELEVE pour l'historique
--
-- Le classement « plus gros consommateurs sur 24 h » et le graphique
-- d'historique filtrent tous deux sur (id_equipement, date_releve).
-- RELEVE est la table qui grossit le plus vite de toute la base : un
-- relevé par équipement et par cycle, soit ~288 lignes/jour/équipement à
-- 5 minutes d'intervalle. Sur 100 équipements, 1 million de lignes en
-- 35 jours. Sans index, le classement devient perceptiblement lent au bout
-- de quelques semaines — exactement le moment où l'on commence à s'en
-- servir.
--
-- Vérifier d'abord s'il existe (une migration précédente a pu le poser) :
--   SHOW INDEX FROM RELEVE;
-- ---------------------------------------------------------------------
ALTER TABLE RELEVE
  ADD KEY idx_releve_equipement_date (id_equipement, date_releve);


-- =====================================================================
-- CONTRÔLE FINAL — après la migration, puis DEUX cycles de scan
--
-- Deux cycles, pas un : le premier ne peut mathématiquement rien mesurer
-- (aucun compteur précédent avec quoi faire la différence). Une table
-- vide après un seul scan est le comportement normal, pas une panne.
--
--   SELECT e.adresse_ip, i.nom, i.vitesse_mbps,
--          ROUND(i.trafic_entrant_kbps, 1) AS entrant_kbps,
--          ROUND(i.trafic_sortant_kbps, 1) AS sortant_kbps,
--          i.date_trafic
--   FROM INTERFACE_RESEAU i
--   JOIN EQUIPEMENT e ON e.id_equipement = i.id_equipement
--   WHERE i.date_trafic IS NOT NULL
--   ORDER BY i.trafic_entrant_kbps DESC
--   LIMIT 20;
--
-- Toujours vide après deux cycles ? Causes possibles, dans l'ordre :
--   1. Aucun équipement du parc ne répond en SNMP (le cas le plus
--      fréquent : un poste Windows n'a pas le service SNMP activé par
--      défaut). Vérifier :
--        SELECT COUNT(*) FROM EQUIPEMENT WHERE sys_descr IS NOT NULL;
--      Si 0, c'est la cause — rien de cassé, rien à collecter.
--   2. L'inventaire des interfaces ne tourne qu'un cycle sur N
--      (INVENTAIRE_TOUS_LES_N_CYCLES, défaut 12, soit une heure à
--      5 minutes d'intervalle). Les débits par port suivent ce rythme ;
--      le débit global de l'équipement, lui, est à chaque cycle.
--   3. Les colonnes n'ont pas été créées : la console du backend affiche
--      « Débit interface N non enregistré: Unknown column ... ». Le reste
--      du cycle continue normalement — c'est volontaire, une migration
--      non passée ne doit pas arrêter la supervision.
-- =====================================================================


-- =====================================================================
-- CE QUE CETTE MIGRATION NE FAIT PAS, ET POURQUOI
--
-- Pas d'historique du débit PAR PORT. INTERFACE_RESEAU ne garde que la
-- dernière mesure ; l'historique reste au niveau de l'équipement, dans
-- RELEVE.
--
-- C'est un arbitrage de volume assumé. Historiser chaque port
-- multiplierait le nombre de lignes par le nombre d'interfaces : un seul
-- switch 48 ports produirait à lui seul 13 800 lignes par jour, soit plus
-- que 45 postes de travail réunis. Le graphique par port serait joli en
-- démonstration et coûteux en exploitation.
--
-- Si le besoin se confirme à l'usage, la bonne réponse n'est pas une table
-- de plus mais une table AGRÉGÉE (moyenne horaire par port, purgée à
-- 90 jours) — à faire quand on saura quels ports méritent d'être suivis,
-- pas avant.
-- =====================================================================
