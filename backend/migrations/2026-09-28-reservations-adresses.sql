-- ---------------------------------------------------------------------
-- 2026-09-28 — Les adresses réservées par l'entreprise, pas seulement
-- par la norme.
--
-- CE QUI MANQUAIT, ET CE QUE ÇA COÛTAIT
--
-- Le plan d'adressage ne connaissait que les réservations IMPOSÉES : la
-- première adresse d'un réseau, sa dernière, les .0 et .255 internes d'un
-- /23. C'est exact, et très insuffisant.
--
-- Dans une entreprise réelle, la moitié d'une plage est réservée par
-- DÉCISION, pas par la norme : .1 à .20 pour les équipements réseau,
-- .100 à .200 distribués par le serveur DHCP, .21 à .50 pour les
-- serveurs à adresse fixe.
--
-- Sans ces réservations, la plateforme annonçait « 192.168.0.150 est
-- libre » alors que cette adresse est dans le pool DHCP. Donnée à un
-- serveur, elle produit un conflit quelques jours plus tard, quand le
-- DHCP l'attribue à son tour — une panne intermittente, de celles qu'on
-- cherche une semaine. Une adresse « libre » qui ne l'est pas est pire
-- qu'une absence de plan : elle inspire confiance.
--
-- CE QUI EST STOCKÉ
--
-- Un intervalle d'adresses, un motif écrit par un humain, et une
-- catégorie qui sert à l'affichage. Les bornes sont conservées en texte
-- ET en entier : le texte pour l'humain, l'entier pour comparer — une
-- comparaison d'adresses en texte place « 192.168.0.9 » après
-- « 192.168.0.100 », et c'est ainsi qu'on se trompe de pool.
--
-- `exclure_du_scan` est prévu mais N'EST PAS ENCORE APPLIQUÉ par le
-- balayage. La colonne existe pour ne pas avoir à migrer deux fois ;
-- l'interface ne la propose pas tant que le scan ne l'honore pas. Une
-- case à cocher sans effet est un mensonge d'écran.
--
-- REJOUABLE SANS RISQUE.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS RESERVATION_ADRESSE (
  id_reservation INT AUTO_INCREMENT PRIMARY KEY,
  id_site        INT NOT NULL,

  debut          VARCHAR(45) NOT NULL,
  fin            VARCHAR(45) NOT NULL,

  -- Bornes numériques, bornes de vérité : toute comparaison passe par
  -- elles. Calculées à l'écriture, jamais saisies.
  debut_num      BIGINT UNSIGNED NOT NULL,
  fin_num        BIGINT UNSIGNED NOT NULL,

  -- Pourquoi c'est réservé, en clair. C'est ce que lira, dans six mois,
  -- la personne qui se demande si elle peut prendre cette adresse.
  motif          VARCHAR(160) NOT NULL,

  -- Sert à colorer et à regrouper. Vocabulaire fermé, volontairement
  -- court : au-delà, personne ne choisit plus la même catégorie deux
  -- fois de suite pour la même chose.
  categorie      ENUM('dhcp','reseau','serveurs','imprimantes','autre')
                 NOT NULL DEFAULT 'autre',

  -- Prévu, pas encore honoré par le balayage. Voir l'en-tête.
  exclure_du_scan TINYINT(1) NOT NULL DEFAULT 0,

  cree_par       INT DEFAULT NULL,
  date_creation  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_reservation_site (id_site),
  KEY idx_reservation_bornes (id_site, debut_num, fin_num),
  CONSTRAINT fk_reservation_site FOREIGN KEY (id_site)
    REFERENCES SITE (id_site) ON DELETE CASCADE,
  CONSTRAINT fk_reservation_utilisateur FOREIGN KEY (cree_par)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
