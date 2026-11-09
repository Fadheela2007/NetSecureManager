-- ---------------------------------------------------------------------
-- 2026-09-28 — Les durées de conservation qui manquaient.
--
-- CE QUE L'AUDIT A TROUVÉ
--
-- Quatre tables recevaient des écritures périodiques sans qu'aucune purge
-- ne les touche jamais : ALERTE, INCIDENT, LOGICIEL_INSTALLE et
-- LOG_ACTIVITE. RELEVE, les observations DNS et les flux NetFlow, eux,
-- étaient correctement bornés — la discipline existait, elle n'avait
-- simplement pas été appliquée partout.
--
-- Une table qui grossit ne se voit pas. Rien à l'écran ne l'annonce ; on
-- s'en aperçoit le jour où la page Alertes met dix secondes à s'ouvrir,
-- et on accuse la plateforme d'être lente.
--
-- ── POURQUOI DES DURÉES TRÈS DIFFÉRENTES ────────────────────────────
--
-- Elles ne répondent pas à la même question.
--
--   alertes résolues — 90 jours. Assez pour comparer un trimestre au
--     précédent, ce qui est l'usage réel. Au-delà, personne ne relit une
--     alerte refermée il y a six mois.
--
--   journal d'activité — 365 jours, et c'est volontairement LONG. Ce
--     journal répond à « qui a fait ça », parfois des mois après. Le
--     purger court détruirait sa seule raison d'être. Mais il contient
--     des adresses IP et des noms d'utilisateurs : sans fin, il devient
--     un historique nominatif de plusieurs années. Un an tranche entre
--     les deux.
--
--   logiciels installés — 60 jours sans être revu. Un navigateur qui se
--     met à jour toutes les quatre semaines laissait une ligne par
--     version, pour toujours : la fiche d'un poste finissait par
--     afficher trois versions de Chrome dont deux n'existent plus. Ici
--     la purge ne libère pas seulement de la place, elle rétablit la
--     justesse de l'inventaire.
--
-- Les INCIDENTS n'ont pas de clé : ils disparaissent avec leur alerte,
-- par la cascade déjà déclarée sur `fk_incident_alerte`. Un incident sans
-- son alerte n'aurait aucun sens.
--
-- ── RÉGLABLES, ET C'EST LE POINT ────────────────────────────────────
--
-- Chaque durée est une ligne de CONFIGURATION, modifiable depuis l'écran
-- du même nom. Un client soumis à une obligation de conservation n'a pas
-- à modifier le code.
--
-- INSERT IGNORE et surtout pas ON DUPLICATE : une semence pose une valeur
-- de départ, elle n'écrase jamais un choix fait par l'exploitant.
-- REJOUABLE SANS RISQUE.
-- ---------------------------------------------------------------------

INSERT IGNORE INTO CONFIGURATION (cle, valeur, description) VALUES
  ('retention_alertes_resolues_jours', '90',
   'Jours de conservation des alertes resolues. Les incidents rattaches disparaissent avec elles.'),
  ('retention_journal_jours', '365',
   'Jours de conservation du journal d''activite. Volontairement long : ce journal sert de preuve.'),
  ('retention_logiciels_jours', '60',
   'Jours sans etre revu avant qu''un logiciel sorte de l''inventaire d''un poste.');


-- ---------------------------------------------------------------------
-- LES INDEX QUE LES PURGES ET LES ÉCRANS RÉCLAMENT
--
-- Sans eux, chaque purge horaire balaie la table entière, et la page
-- Alertes trie en table temporaire à chaque ouverture. L'audit a mesuré
-- le second effet : deux secondes au premier mois, dix au troisième.
-- ---------------------------------------------------------------------

SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ALERTE'
     AND INDEX_NAME = 'idx_alerte_statut_resolution'
);
SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_alerte_statut_resolution ON ALERTE (statut, date_resolution)',
  'SELECT ''Index idx_alerte_statut_resolution deja present'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


-- Sert l'escalade des incidents, qui tourne toutes les cinq minutes.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ALERTE'
     AND INDEX_NAME = 'idx_alerte_escalade'
);
SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_alerte_escalade ON ALERTE (statut, niveau, date_creation)',
  'SELECT ''Index idx_alerte_escalade deja present'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


-- Le journal est lu trié par date, 200 lignes à la fois. Sans index, le
-- tri porte sur la table entière pour en rendre deux cents.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'LOG_ACTIVITE'
     AND INDEX_NAME = 'idx_log_date'
);
SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_log_date ON LOG_ACTIVITE (date_log)',
  'SELECT ''Index idx_log_date deja present'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


-- Le collecteur NetFlow cherche les équipements par adresse toutes les
-- cinq minutes, avec jusqu'à vingt mille valeurs dans un IN. L'unique
-- uniq_ip_site commence par id_site : il est donc INUTILISABLE pour cette
-- recherche, qui balayait EQUIPEMENT en entier.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'EQUIPEMENT'
     AND INDEX_NAME = 'idx_equipement_adresse_ip'
);
SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_equipement_adresse_ip ON EQUIPEMENT (adresse_ip)',
  'SELECT ''Index idx_equipement_adresse_ip deja present'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;


-- La purge de l'inventaire logiciel filtre sur cette date.
SET @existe := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'LOGICIEL_INSTALLE'
     AND INDEX_NAME = 'idx_logiciel_derniere_vue'
);
SET @sql := IF(
  @existe = 0,
  'CREATE INDEX idx_logiciel_derniere_vue ON LOGICIEL_INSTALLE (derniere_vue)',
  'SELECT ''Index idx_logiciel_derniere_vue deja present ou table absente'' AS info'
);
PREPARE requete FROM @sql;
EXECUTE requete;
DEALLOCATE PREPARE requete;
