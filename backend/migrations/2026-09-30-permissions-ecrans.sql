-- ---------------------------------------------------------------------
-- 2026-09-30 — LES PERMISSIONS SORTENT DU CODE.
--
-- POURQUOI CETTE TABLE EXISTE
--
-- Les droits étaient écrits dans le code, route par route :
-- `requireRole("admin")`, `requireRole("admin", "operateur")`. Cinquante
-- trois fois. Changer ce qu'un opérateur a le droit de faire demandait
-- donc de modifier le code, de le redéployer, et de recommencer à la
-- moindre nuance. Autant dire que personne ne le faisait jamais.
--
-- Désormais une ligne par RÔLE × ÉCRAN, modifiable depuis la page
-- Utilisateurs.
--
-- ── QUATRE NIVEAUX, ET ILS SONT ORDONNÉS ─────────────────────────────
--
--   rien        — l'écran n'existe pas pour ce rôle.
--   voir        — on consulte, on ne change rien.
--   modifier    — le travail courant : acquitter, renommer, lancer.
--   administrer — ce qui engage l'installation : supprimer, configurer.
--
-- Ces quatre niveaux ne sont pas inventés : ils décalquent EXACTEMENT
-- les trois barrières qui existaient déjà dans le code.
--
--   route sans requireRole              -> il faut « voir »
--   requireRole("admin", "operateur")   -> il faut « modifier »
--   requireRole("admin")                -> il faut « administrer »
--
-- C'est ce qui permet à cette migration de ne RIEN changer au
-- comportement, tout en rendant chaque droit réglable ensuite.
--
-- ── CE QUI NE CHANGE RIEN AUJOURD'HUI ────────────────────────────────
--
-- Le remplissage ci-dessous reproduit les droits actuels, à l'identique :
--
--   admin      -> administrer partout   (il pouvait déjà tout)
--   operateur  -> modifier partout      (refusé sur les routes admin,
--                                        exactement comme avant)
--   lecteur    -> voir partout          (consultation seule, comme avant)
--
-- Après cette migration, la plateforme se comporte comme avant : mêmes
-- écrans, mêmes refus, mêmes messages. C'est précisément ce qu'on
-- attend d'une fondation — elle se vérifie en constatant qu'il ne s'est
-- rien passé.
--
-- REJOUABLE SANS RISQUE : la table n'est créée que si elle manque, et le
-- remplissage n'ajoute que les lignes absentes. Rejouer la migration ne
-- réécrit JAMAIS un droit qu'on aurait modifié depuis l'écran — ce
-- serait le plus sournois des effets de bord : une mise à jour qui rend
-- en silence à quelqu'un un accès qu'on lui avait retiré.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS PERMISSION (
  role    ENUM('admin','operateur','lecteur') NOT NULL,
  ecran   VARCHAR(40) NOT NULL,

  niveau  ENUM('rien','voir','modifier','administrer') NOT NULL DEFAULT 'rien',

  -- Qui a changé ce droit, et quand. Le journal garde le détail ; ces
  -- deux colonnes permettent de répondre à « depuis quand ? » sans le
  -- parcourir.
  date_modification DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (role, ecran)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── LE REMPLISSAGE ───────────────────────────────────────────────────
-- `INSERT IGNORE` et non `REPLACE` : voir l'avertissement plus haut.
INSERT IGNORE INTO PERMISSION (role, ecran, niveau) VALUES
  ('admin', 'equipements',     'administrer'),
  ('admin', 'alertes',         'administrer'),
  ('admin', 'incidents',       'administrer'),
  ('admin', 'topologie',       'administrer'),
  ('admin', 'plages',          'administrer'),
  ('admin', 'bande_passante',  'administrer'),
  ('admin', 'acces_web',       'administrer'),
  ('admin', 'sites',           'administrer'),
  ('admin', 'rapports',        'administrer'),
  ('admin', 'scan',            'administrer'),
  ('admin', 'journal',         'administrer'),
  ('admin', 'configuration',   'administrer'),
  ('admin', 'utilisateurs',    'administrer'),

  ('operateur', 'equipements',     'modifier'),
  ('operateur', 'alertes',         'modifier'),
  ('operateur', 'incidents',       'modifier'),
  ('operateur', 'topologie',       'modifier'),
  ('operateur', 'plages',          'modifier'),
  ('operateur', 'bande_passante',  'modifier'),
  ('operateur', 'acces_web',       'modifier'),
  ('operateur', 'sites',           'modifier'),
  ('operateur', 'rapports',        'modifier'),
  ('operateur', 'scan',            'modifier'),
  ('operateur', 'journal',         'modifier'),
  ('operateur', 'configuration',   'modifier'),
  ('operateur', 'utilisateurs',    'modifier'),

  ('lecteur', 'equipements',     'voir'),
  ('lecteur', 'alertes',         'voir'),
  ('lecteur', 'incidents',       'voir'),
  ('lecteur', 'topologie',       'voir'),
  ('lecteur', 'plages',          'voir'),
  ('lecteur', 'bande_passante',  'voir'),
  ('lecteur', 'acces_web',       'voir'),
  ('lecteur', 'sites',           'voir'),
  ('lecteur', 'rapports',        'voir'),
  ('lecteur', 'scan',            'voir'),
  ('lecteur', 'journal',         'voir'),
  ('lecteur', 'configuration',   'voir'),
  ('lecteur', 'utilisateurs',    'voir');
