-- =====================================================================
-- Colonnes absentes des tables les plus anciennes
--
-- Aucun DROP, aucune perte de données. Trois colonnes ajoutées.
--
-- ─────────────────────────────────────────────────────────────────────
-- D'OÙ VIENNENT CES MANQUES
--
-- Ces trois tables — CONFIGURATION, TYPE_EQUIPEMENT, NOTIFICATION —
-- existaient déjà avant que `schema.sql` ne soit complété. Or
-- `schema.sql` travaille en CREATE TABLE IF NOT EXISTS : sur une table
-- qui existe, il ne fait RIEN, pas même ajouter une colonne.
--
-- Résultat : la structure déclarée et la structure réelle divergeaient
-- sans que rien ne le signale, jusqu'à ce qu'une requête tombe sur
-- « Unknown column ». C'est exactement ce qu'a révélé l'application des
-- migrations :
--
--   schema.sql                 -> Unknown column 'description'
--   2026-08-13-rapports        -> Unknown column 'n.destinataire'
--   2026-08-17-types-coherents -> Unknown column 'description'
--
-- Ce n'était pas un défaut de ces fichiers : c'est la limite de
-- CREATE TABLE IF NOT EXISTS, qui ne sait pas faire évoluer l'existant.
-- D'où cette migration, seule voie pour compléter une table déjà là.
-- ─────────────────────────────────────────────────────────────────────
-- =====================================================================

USE NetSecureManager;


-- ---------------------------------------------------------------------
-- 1) CONFIGURATION.description  —  LA PLUS IMPORTANTE
--
-- Lue par GET /api/configuration : sans elle, l'écran Configuration
-- renvoie une erreur 500 et devient inaccessible. C'est la seule des
-- trois qui casse une page.
--
-- Elle porte le libellé lisible d'un réglage : « Nombre d'échecs de ping
-- avant de déclarer un équipement hors ligne ». Sans ce texte,
-- l'interface n'afficherait que des clés techniques
-- (`seuil_echecs_avant_alerte`), que personne ne peut interpréter.
-- ---------------------------------------------------------------------
ALTER TABLE CONFIGURATION
  ADD COLUMN description VARCHAR(255) DEFAULT NULL;


-- ---------------------------------------------------------------------
-- 2) TYPE_EQUIPEMENT.description
--
-- Purement documentaire : aucune requête du code ne la lit. Elle est
-- renseignée par les jeux de données initiaux, qui échouaient donc en
-- entier — et c'est ce qui comptait, car le même INSERT crée aussi les
-- TYPES eux-mêmes. Sans lui, `poste_travail`, `imprimante` ou `serveur`
-- n'existent pas dans le référentiel, et tout équipement scanné retombe
-- sur « inconnu ».
--
-- Autrement dit : une colonne inutilisée bloquait la création du
-- vocabulaire de classification.
-- ---------------------------------------------------------------------
ALTER TABLE TYPE_EQUIPEMENT
  ADD COLUMN description VARCHAR(255) DEFAULT NULL;


-- ---------------------------------------------------------------------
-- 3) NOTIFICATION.destinataire
--
-- Écrite à chaque notification envoyée (services/notificationService.js).
-- L'insertion étant protégée par un try/catch, son absence ne faisait
-- rien échouer visiblement : les e-mails partaient bien — vous l'avez
-- constaté au test T9 — mais AUCUNE trace n'était conservée.
--
-- Conséquence en démonstration : impossible de répondre à « à qui cette
-- alerte a-t-elle été envoyée, et quand ? ». La fonction marchait,
-- l'historique n'existait pas.
-- ---------------------------------------------------------------------
ALTER TABLE NOTIFICATION
  ADD COLUMN destinataire VARCHAR(150) DEFAULT NULL;


-- =====================================================================
-- CONTRÔLE
--
-- Les trois requêtes ci-dessous doivent renvoyer une ligne chacune.
-- =====================================================================

SHOW COLUMNS FROM CONFIGURATION    LIKE 'description';
SHOW COLUMNS FROM TYPE_EQUIPEMENT  LIKE 'description';
SHOW COLUMNS FROM NOTIFICATION     LIKE 'destinataire';


-- =====================================================================
-- APRÈS CETTE MIGRATION
--
-- Relancer l'application des migrations : les trois INSERT qui avaient
-- échoué passeront cette fois, et créeront le référentiel des types
-- ainsi que les réglages par défaut.
--
--     node tools\appliquer-migrations.js
--
-- Puis vérifier que le vocabulaire de classification existe bien :
--
--     SELECT id_type, libelle FROM TYPE_EQUIPEMENT ORDER BY libelle;
--
-- Doit renvoyer neuf lignes : camera, imprimante, inconnu, pare-feu,
-- poste_travail, routeur, routeur/switch, serveur, telephonie.
-- Si la table est vide, aucun équipement ne pourra être classé.
-- =====================================================================
