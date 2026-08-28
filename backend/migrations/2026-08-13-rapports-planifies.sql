-- =====================================================================
-- Rapports planifiés par e-mail
--
-- Deux parties :
--   1) Quatre clés de configuration (obligatoire pour activer)
--   2) Un ALTER sur NOTIFICATION.canal (recommandé, pas obligatoire)
--
-- Aucune suppression, aucun DROP.
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) Configuration
--
-- rapport_planifie_frequence : desactive | hebdomadaire | mensuel
--   Défaut « desactive » VOLONTAIRE : activer l'envoi automatique de
--   courriels à tous les administrateurs et opérateurs sans qu'ils
--   l'aient demandé serait une mauvaise surprise. À vous d'ouvrir le
--   robinet quand vous le voulez.
--
-- rapport_planifie_jour :
--   en hebdomadaire -> 1 à 7, convention ISO (lundi = 1, dimanche = 7)
--   en mensuel      -> 1 à 28
--   La borne à 28 est volontaire : un envoi prévu le 30 serait purement
--   et simplement sauté en février.
--
-- rapport_planifie_heure : 0 à 23, heure locale du serveur.
--
-- Le planificateur passe toutes les heures à la 10e minute. L'envoi a
-- donc lieu entre HH:10 et HH:10 de l'heure configurée.
-- ---------------------------------------------------------------------
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('rapport_planifie_frequence', 'desactive',
   'Fréquence d''envoi du rapport par e-mail : desactive, hebdomadaire ou mensuel'),
  ('rapport_planifie_jour', '1',
   'Jour d''envoi — hebdomadaire : 1=lundi à 7=dimanche ; mensuel : 1 à 28'),
  ('rapport_planifie_heure', '8',
   'Heure d''envoi du rapport planifié (0 à 23, heure du serveur)');

-- Horodatage du dernier envoi. C'est de l'ÉTAT, pas un réglage : il
-- garantit qu'un redémarrage pendant l'heure d'envoi ne provoque pas un
-- second courriel. Le serveur l'écrit lui-même ; ne pas le modifier à la
-- main, sauf pour forcer un nouvel envoi le jour même (le vider).
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('rapport_planifie_dernier_envoi', '',
   'Horodatage du dernier rapport planifié envoyé (géré par le serveur)');


-- ---------------------------------------------------------------------
-- 2) Distinguer les rapports des alertes dans NOTIFICATION
--
-- La colonne canal est un ENUM('email','whatsapp'). L'étendre permet de
-- séparer les envois de rapports des notifications d'alerte.
--
-- NON OBLIGATOIRE : sans cet ALTER, le code détecte le refus de MySQL et
-- retombe sur canal = 'email'. La trace est conservée dans tous les cas,
-- et `id_alerte IS NULL` distingue déjà un rapport d'une alerte. Mais la
-- lecture du journal est bien plus claire avec la valeur dédiée.
--
-- Vérifier d'abord la définition réelle :
SHOW COLUMNS FROM NOTIFICATION LIKE 'canal';

-- Puis, si le résultat est bien enum('email','whatsapp') :
ALTER TABLE NOTIFICATION
  MODIFY COLUMN canal ENUM('email','whatsapp','rapport') NOT NULL;

-- ⚠ Si votre ENUM contient d'autres valeurs que ces deux-là, ADAPTER la
-- ligne ci-dessus pour les conserver — un MODIFY remplace la liste
-- complète, et les lignes portant une valeur retirée seraient tronquées.


-- =====================================================================
-- ACTIVATION
--
-- Exemple : chaque lundi à 7 h du matin
--
--   UPDATE CONFIGURATION SET valeur = 'hebdomadaire' WHERE cle = 'rapport_planifie_frequence';
--   UPDATE CONFIGURATION SET valeur = '1'            WHERE cle = 'rapport_planifie_jour';
--   UPDATE CONFIGURATION SET valeur = '7'            WHERE cle = 'rapport_planifie_heure';
--
-- Exemple : le 1er de chaque mois à 6 h
--
--   UPDATE CONFIGURATION SET valeur = 'mensuel' WHERE cle = 'rapport_planifie_frequence';
--   UPDATE CONFIGURATION SET valeur = '1'       WHERE cle = 'rapport_planifie_jour';
--   UPDATE CONFIGURATION SET valeur = '6'       WHERE cle = 'rapport_planifie_heure';
--
-- Ces trois clés apparaissent dans l'écran Configuration. Attention : les
-- champs y sont de type nombre, donc la FRÉQUENCE (qui est du texte) doit
-- être modifiée en SQL. C'est une limite connue, signalée dans le rapport.
-- =====================================================================


-- =====================================================================
-- CONTRÔLES
--
-- 1) Qui recevra quoi ? Un utilisateur sans e-mail est ignoré.
SELECT
  CASE WHEN id_site IS NULL THEN 'GLOBAL — rapport de tous les sites'
       ELSE CONCAT('site ', id_site, ' uniquement') END AS perimetre,
  COUNT(*) AS destinataires,
  SUM(email IS NULL OR email = '') AS sans_email_donc_ignores
FROM UTILISATEUR
WHERE role IN ('admin','operateur')
GROUP BY id_site IS NULL, id_site;

-- 2) Des périmètres seront-ils ignorés faute d'équipements ?
--    Un rapport annonçant « 0 équipement » n'est pas envoyé.
SELECT s.nom AS site, COUNT(e.id_equipement) AS equipements,
       CASE WHEN COUNT(e.id_equipement) = 0
            THEN 'rapport NON envoyé — aucun équipement'
            ELSE 'rapport envoyé' END AS consequence
FROM SITE s
LEFT JOIN EQUIPEMENT e ON e.id_site = s.id_site
GROUP BY s.id_site, s.nom;

-- 3) Après un envoi : les traces
SELECT n.canal, n.statut, n.destinataire, n.erreur, n.date_envoi
FROM NOTIFICATION n
WHERE n.id_alerte IS NULL          -- un rapport n'est lié à aucune alerte
ORDER BY n.date_envoi DESC
LIMIT 50;
-- =====================================================================


-- =====================================================================
-- TESTER SANS ATTENDRE UNE SEMAINE
--
-- Une route déclenche l'envoi immédiatement, en ignorant la
-- planification, et renvoie un bilan détaillé (destinataires, poids de
-- chaque pièce jointe, périmètres ignorés) :
--
--   POST /api/rapport/envoyer-maintenant      (réservé aux administrateurs)
--
-- Elle n'écrit PAS l'horodatage de dernier envoi : un test manuel ne fait
-- donc pas sauter l'envoi automatique du jour.
--
-- Pour vérifier l'état de la planification sans rien envoyer :
--
--   GET /api/rapport/planification
-- =====================================================================
