-- ---------------------------------------------------------------------
-- 2026-09-28 — Demander un accès, sans se l'accorder soi-même.
--
-- LE BESOIN, ET POURQUOI L'INSCRIPTION LIBRE N'Y RÉPOND PAS
--
-- Jusqu'ici, un nouvel utilisateur n'existait que si un administrateur
-- saisissait son compte ET son mot de passe, puis le lui transmettait —
-- par message, à l'oral, sur un papier. C'est le maillon faible de toute
-- la chaîne d'authentification : le seul endroit où un mot de passe
-- circule en clair.
--
-- L'inscription libre réglerait ce point et en ouvrirait un bien pire.
-- Cette plateforme sert l'inventaire complet d'un réseau d'entreprise :
-- machines, adresses, ports ouverts, services exposés, failles connues.
-- C'est exactement la carte que cherche quelqu'un qui prépare une
-- intrusion. Un formulaire d'inscription en libre-service sur une page
-- de connexion accessible, c'est la lui offrir.
--
-- CE QUE FAIT CETTE TABLE
--
-- Elle sépare les deux gestes que l'inscription libre confond :
--
--   1. la personne DEMANDE — elle saisit son nom, son adresse, un motif,
--      et choisit son mot de passe ;
--   2. un administrateur ACCORDE — il décide du rôle et du site, ou
--      refuse.
--
-- La demande est bien enregistrée en base, immédiatement. Elle ne donne
-- simplement aucun droit tant qu'elle n'a pas été acceptée.
--
-- ── LE MOT DE PASSE EST HACHÉ DÈS LA DEMANDE ────────────────────────
--
-- Et c'est le point qui règle le problème d'origine : l'administrateur
-- ne voit jamais le mot de passe, ne le choisit pas, n'a pas à le
-- transmettre. À l'acceptation, l'empreinte déjà calculée devient celle
-- du compte. Personne d'autre que le demandeur n'a jamais connu ce
-- secret.
--
-- Une empreinte bcrypt stockée avant que le compte n'existe ne présente
-- pas de risque propre : elle n'ouvre aucun accès par elle-même, et elle
-- est de toute façon effacée si la demande est refusée.
--
-- ── CE QUI N'EST PAS DEMANDÉ AU VISITEUR ────────────────────────────
--
-- Ni le rôle, ni le site. Les deux sont des décisions d'exploitation :
-- les faire saisir par le demandeur reviendrait à lui laisser écrire
-- lui-même son niveau d'accès, et un formulaire se falsifie.
--
-- REJOUABLE SANS RISQUE.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS DEMANDE_ACCES (
  id_demande        INT AUTO_INCREMENT PRIMARY KEY,

  nom               VARCHAR(120) NOT NULL,
  email             VARCHAR(190) NOT NULL,

  -- Empreinte bcrypt, jamais le mot de passe. Même colonne, même coût et
  -- même format que UTILISATEUR.mot_de_passe_hash : à l'acceptation, la
  -- valeur est recopiée telle quelle, sans être recalculée ni connue.
  mot_de_passe_hash VARCHAR(255) NOT NULL,

  -- Pourquoi cette personne demande un accès, en clair. C'est ce que
  -- lira l'administrateur pour décider, et la seule information qui lui
  -- permette de rattacher une adresse à quelqu'un de réel.
  motif             VARCHAR(255) NOT NULL,

  statut            ENUM('en_attente','acceptee','refusee')
                    NOT NULL DEFAULT 'en_attente',

  -- D'où venait la demande. Sert à reconnaître une rafale automatisée,
  -- pas à identifier une personne.
  adresse_ip        VARCHAR(45) DEFAULT NULL,

  date_demande      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  date_traitement   DATETIME DEFAULT NULL,
  traitee_par       INT DEFAULT NULL,

  -- La liste des demandes en attente est relue à chaque ouverture de
  -- l'écran Utilisateurs : l'index porte sur ce filtre-là.
  KEY idx_demande_statut (statut, date_demande),
  KEY idx_demande_email (email),

  CONSTRAINT fk_demande_traitee_par FOREIGN KEY (traitee_par)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
