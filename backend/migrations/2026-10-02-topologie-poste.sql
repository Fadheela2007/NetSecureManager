-- ---------------------------------------------------------------------
-- 2026-10-02 — Ce qu'un poste sait du réseau autour de lui.
--
-- POURQUOI CES TROIS TABLES
--
-- Une carte du réseau se construit à partir de LIENS. Les outils du
-- marché vont les chercher chez les commutateurs, par SNMP et LLDP. Le
-- relevé du 1er octobre 2026 a montré que cette voie est fermée sur un
-- réseau de PME ordinaire : la passerelle ne répond à aucune communauté
-- standard, et le seul équipement qui réponde est une imprimante — une
-- feuille, qui ne connaît aucun voisin.
--
-- Les postes, eux, savent trois choses d'eux-mêmes, sans aucun droit
-- particulier :
--
--   POSTE_INTERFACE  — leurs cartes, avec la passerelle et le type de
--                      média. De quoi savoir sur quel SEGMENT ils sont,
--                      et distinguer une carte réelle d'une carte de
--                      machine virtuelle.
--   POSTE_VOISIN     — les adresses qu'ils ont réellement jointes, avec
--                      l'état de chaque entrée. C'est ce qui rattache au
--                      segment des équipements qui n'ont AUCUN agent.
--   POSTE_SANS_FIL   — la borne à laquelle ils sont associés. Le seul
--                      lien physique qu'un poste connaisse avec certitude.
--
-- UN ÉTAT, PAS UN HISTORIQUE
--
-- Comme SANTE_POSTE : le contenu est remplacé à chaque relevé. Garder
-- l'historique des tables de voisinage de cent postes toutes les cinq
-- minutes ferait des dizaines de millions de lignes pour une question à
-- laquelle on répond avec le dernier relevé.
--
-- CE QUI N'EST PAS ÉCRIT ICI
--
-- Aucun jugement. Ni « carte virtuelle », ni « segment principal » : ce
-- sont des conclusions, et elles changeront. On enregistre les constats
-- — matérielle ou non, passerelle présente ou non — et la règle qui les
-- interprète vit à un seul endroit, dans topologieService.
--
-- REJOUABLE SANS RISQUE : CREATE TABLE IF NOT EXISTS ne touche pas à une
-- table déjà présente, et aucune donnée existante n'est modifiée.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS POSTE_INTERFACE (
  id_equipement INT NOT NULL,

  -- L'index que Windows donne à la carte. C'est le même numéro qu'un
  -- agent SNMP verrait sur cette machine, donc la même clé d'un relevé
  -- à l'autre — ce qui permet de relier une carte à ses voisins.
  index_carte   INT NOT NULL,

  nom           VARCHAR(128) NULL,
  adresse_ip    VARCHAR(45)  NOT NULL,

  -- Longueur du préfixe (23 pour un /23). NULL = non relevé.
  masque        TINYINT UNSIGNED NULL,

  -- La passerelle par défaut de CETTE carte. NULL est une information :
  -- une carte sans passerelle ne sort pas de son segment.
  passerelle    VARCHAR(45)  NULL,

  adresse_mac   VARCHAR(23)  NULL,

  -- Valeur d'énumération (« 802.3 », « Native 802.11 »), jamais un
  -- libellé : un nom de carte est traduit, et une règle qui dépend de la
  -- langue du poste casse chez le premier client étranger.
  media         VARCHAR(48)  NULL,

  -- 1 matérielle, 0 virtuelle, NULL « je n'ai pas pu savoir ». Les trois
  -- cas sont distincts : NULL ne doit jamais se lire comme 0.
  materielle    TINYINT(1)   NULL,

  etat          VARCHAR(24)  NULL,
  date_releve   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id_equipement, index_carte, adresse_ip),
  KEY idx_poste_interface_ip (adresse_ip),
  CONSTRAINT fk_poste_interface_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS POSTE_VOISIN (
  id_equipement INT NOT NULL,
  index_carte   INT NOT NULL,
  adresse_ip    VARCHAR(45) NOT NULL,
  adresse_mac   VARCHAR(23) NULL,

  -- « Reachable » = joint à l'instant. « Stale » = vu un jour, plus
  -- revérifié depuis. Les confondre ferait dessiner des liens morts, et
  -- c'est la distinction qui sépare ici une preuve d'une présomption.
  etat          VARCHAR(24) NULL,
  date_releve   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id_equipement, index_carte, adresse_ip),
  KEY idx_poste_voisin_ip (adresse_ip),
  CONSTRAINT fk_poste_voisin_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS POSTE_SANS_FIL (
  id_equipement INT NOT NULL,

  -- Adresse matérielle de la radio de la borne. Une machine n'est
  -- associée qu'à une borne à la fois : une ligne par poste.
  bssid         VARCHAR(23) NOT NULL,
  ssid          VARCHAR(64) NULL,
  date_releve   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id_equipement),
  KEY idx_poste_sans_fil_bssid (bssid),
  CONSTRAINT fk_poste_sans_fil_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
