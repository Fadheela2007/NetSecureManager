-- =====================================================================
-- Migration — fiabilité en usage prolongé
--
-- À exécuter dans MySQL Workbench, DANS CET ORDRE.
-- Aucun DROP, aucune perte de données.
--
-- Étapes 1 à 4 : OBLIGATOIRES (sinon les nouvelles fonctions ne marchent pas)
-- Étape 5      : VÉRIFICATION du cloisonnement — la plus importante
-- Étape 6      : recommandée (performance de la purge)
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- ÉTAPE 1 (obligatoire) — SITE.dernier_push
--
-- Horodatage du dernier POST /api/agent/push reçu pour ce site.
-- C'est cette colonne qui permet de détecter un agent devenu muet.
--
-- Reste NULL pour un site scanné manuellement depuis l'interface : c'est
-- exactement ce qui empêche le site principal de déclencher l'alerte.
-- ---------------------------------------------------------------------
ALTER TABLE SITE
  ADD COLUMN dernier_push DATETIME NULL DEFAULT NULL AFTER agent_token;


-- ---------------------------------------------------------------------
-- ÉTAPE 2 (obligatoire) — alertes rattachées à un SITE
--
-- Une panne d'agent ne concerne aucun équipement en particulier : elle
-- concerne la remontée d'informations du site entier. ALERTE.id_equipement
-- devient donc facultatif, et une colonne id_site est ajoutée.
--
-- ⚠ Les requêtes du backend ont été adaptées en conséquence :
--    les JOIN EQUIPEMENT sont devenus des LEFT JOIN, sans quoi les alertes
--    de site disparaîtraient des listes. Ne pas exécuter l'étape 2 sans
--    déployer le code correspondant, et inversement.
-- ---------------------------------------------------------------------
ALTER TABLE ALERTE
  MODIFY COLUMN id_equipement INT NULL;

ALTER TABLE ALERTE
  ADD COLUMN id_site INT NULL AFTER id_equipement;

ALTER TABLE ALERTE
  ADD CONSTRAINT fk_alerte_site
  FOREIGN KEY (id_site) REFERENCES SITE (id_site) ON DELETE CASCADE;

-- Accélère la recherche d'une alerte d'agent déjà active pour un site.
ALTER TABLE ALERTE
  ADD INDEX idx_alerte_site_type (id_site, type_alerte, statut);


-- ---------------------------------------------------------------------
-- ÉTAPE 3 (obligatoire) — nouvelles clés de configuration
--
-- Elles apparaîtront automatiquement dans la page Configuration, qui
-- affiche tout le contenu de la table.
--
-- seuil_agent_muet_minutes = 30 : compromis. L'agent fourni scanne toutes
--   les 2 à 5 minutes ; 30 minutes laissent passer plusieurs cycles ratés
--   (redémarrage, scan long) sans crier au loup, tout en détectant une
--   vraie panne dans la demi-heure. À augmenter si vos agents ont un
--   intervalle long, à réduire si vous voulez être prévenue plus vite.
--
-- retention_releves_jours = 30 : les graphiques de EquipementDetail
--   couvrent 24 h, et la route /releves est bornée à 30 jours côté code.
--   Conserver au-delà n'alimente aucun écran aujourd'hui.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('seuil_agent_muet_minutes', '30',
   'Durée (minutes) sans transmission d''un agent avant de déclencher une alerte'),
  ('retention_releves_jours',  '30',
   'Durée (jours) de conservation des relevés avant purge automatique');


-- ---------------------------------------------------------------------
-- ÉTAPE 4 (obligatoire) — index de purge sur RELEVE
--
-- La purge fait « DELETE FROM RELEVE WHERE date_releve < ... LIMIT 5000 ».
-- Sans index sur date_releve SEULE, MySQL parcourt toute la table à chaque
-- lot. L'index existant (id_equipement, date_releve) ne sert pas ici :
-- la requête ne filtre pas sur id_equipement.
--
-- ⚠ Sur une table déjà volumineuse, cette création peut prendre plusieurs
-- minutes et verrouiller la table. À lancer en période creuse.
-- ---------------------------------------------------------------------
ALTER TABLE RELEVE
  ADD INDEX idx_releve_date (date_releve);


-- =====================================================================
-- ÉTAPE 5 (VÉRIFICATION — À FAIRE ABSOLUMENT AVANT DE REDÉMARRER)
--
-- Le cloisonnement par site change ce que voient les utilisateurs.
-- La règle appliquée est :
--     UTILISATEUR.id_site = NULL  -> voit TOUS les sites
--     UTILISATEUR.id_site = <n>   -> ne voit QUE le site n
--
-- Regardez qui est rattaché à quoi AVANT de redémarrer le backend :
-- =====================================================================

SELECT id_utilisateur, nom, email, role,
       id_site,
       CASE WHEN id_site IS NULL
            THEN 'GLOBAL — voit tous les sites'
            ELSE CONCAT('limité au site ', id_site)
       END AS portee_apres_migration
FROM UTILISATEUR
ORDER BY id_site IS NOT NULL, nom;

-- Si votre compte administrateur a un id_site renseigné, il ne verra plus
-- que ce site après redémarrage. Pour en faire un administrateur de
-- plateforme, le détacher :
--
--   UPDATE UTILISATEUR SET id_site = NULL WHERE email = 'votre@email';
--
-- À l'inverse, pour cloisonner un opérateur sur le site 2 :
--
--   UPDATE UTILISATEUR SET id_site = 2 WHERE email = 'operateur@email';


-- ---------------------------------------------------------------------
-- ÉTAPE 6 (recommandée) — première purge manuelle
--
-- Si RELEVE contient déjà des centaines de milliers de lignes, la purge
-- automatique est plafonnée à 100 000 lignes par heure et mettra du temps
-- à rattraper le retard. Pour repartir propre, mesurez d'abord :
--
--   SELECT COUNT(*) AS total,
--          SUM(date_releve < NOW() - INTERVAL 30 DAY) AS a_purger,
--          MIN(date_releve) AS plus_ancien
--   FROM RELEVE;
--
-- Puis supprimez par tranches (à répéter tant que le compte renvoyé
-- vaut 50000) :
--
--   DELETE FROM RELEVE WHERE date_releve < NOW() - INTERVAL 30 DAY LIMIT 50000;
--
-- Ne PAS faire un DELETE sans LIMIT sur une table volumineuse : la table
-- resterait verrouillée pendant toute l'opération et le cycle de
-- supervision échouerait à insérer ses relevés.
-- ---------------------------------------------------------------------


-- =====================================================================
-- CONTRÔLES APRÈS REDÉMARRAGE
--
-- 1) Agent muet — forcer une alerte de test sur un site qui a déjà poussé :
--      UPDATE SITE SET dernier_push = NOW() - INTERVAL 2 HOUR WHERE id_site = 2;
--    Puis attendre le passage des 5 minutes et vérifier :
--      SELECT id_alerte, id_site, type_alerte, cause_code, message
--      FROM ALERTE WHERE type_alerte = 'agent_muet';
--    L'alerte doit se résoudre seule au prochain push réel de l'agent.
--
-- 2) Purge — vérifier la trace dans la console du backend à la 20e minute :
--      "Purge des relevés : N ligne(s) supprimée(s) (rétention 30 jour(s))."
--
-- 3) Cloisonnement — se connecter avec un compte rattaché à un site et
--    vérifier que le sélecteur de site n'affiche que celui-là.
-- =====================================================================
