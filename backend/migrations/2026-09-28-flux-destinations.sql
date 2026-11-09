-- ---------------------------------------------------------------------
-- 2026-09-28 — Non plus « combien », mais « vers quoi ».
--
-- CE QUI EXISTAIT, ET CE QUI ÉTAIT JETÉ
--
-- Le collecteur NetFlow reçoit, pour chaque conversation routée :
-- l'adresse source, l'adresse destination, les PORTS, le protocole et le
-- nombre d'octets. Il n'en gardait que deux choses — l'adresse interne et
-- le total — et jetait le reste. Le commentaire du fichier l'assumait :
-- « le reste ne sert pas à répondre qui consomme combien ».
--
-- C'était vrai de la question posée alors. Ça ne l'est plus : savoir
-- qu'un poste consomme 8 Mbit/s ne dit pas s'il sauvegarde ou s'il
-- regarde des vidéos, et c'est la seule des deux réponses sur laquelle
-- on peut agir.
--
-- L'information arrivait déjà sur le serveur. On la mettait à la
-- poubelle. Cette table est l'endroit où elle atterrit désormais.
--
-- ── CE QUE CHAQUE LIGNE SIGNIFIE ────────────────────────────────────
--
-- « Pendant cette fenêtre de cinq minutes, cette machine du parc a
--   échangé N octets avec cette adresse extérieure, sur ce port. »
--
-- Le port retenu est TOUJOURS celui du correspondant, jamais celui de la
-- machine du parc. Un poste qui navigue ouvre un port local aléatoire
-- (52134, puis 52135…) vers le port 443 du serveur : garder le port
-- local produirait des milliers de lignes toutes différentes et
-- n'apprendrait rien. C'est le port DISTANT qui nomme le service.
--
-- ── POURQUOI UNE TABLE À PART, ET PAS DES COLONNES DANS RELEVE ──────
--
-- RELEVE porte UNE ligne par machine et par instant. Ici il y a N lignes
-- par machine et par instant — une par correspondant. Ce sont deux
-- formes différentes, et les mélanger casserait toutes les moyennes déjà
-- calculées sur RELEVE.
--
-- ── DURÉE DE CONSERVATION : 7 JOURS ─────────────────────────────────
--
-- Volontairement courte, pour deux raisons qui vont dans le même sens.
--
-- Technique : c'est la table qui grossit le plus vite de toute la base —
-- un parc de cent machines produit des dizaines de milliers de lignes
-- par jour.
--
-- Et l'autre, qui pèse autant : CECI EST UNE TRACE DE NAVIGATION. Savoir
-- que le poste de quelqu'un a parlé à tel serveur, à telle heure, est
-- une donnée personnelle dans la plupart des cadres juridiques. On garde
-- ce qu'il faut pour diagnostiquer une saturation — quelques jours — et
-- pas de quoi reconstituer les habitudes d'une personne sur un
-- trimestre. La purge est automatique et n'a pas d'interrupteur.
--
-- REJOUABLE SANS RISQUE.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS FLUX_DESTINATION (
  id_flux        BIGINT AUTO_INCREMENT PRIMARY KEY,

  -- La machine du parc. Toujours renseignée : un flux dont aucun bout
  -- n'est connu n'est pas écrit.
  id_equipement  INT NOT NULL,

  -- Le correspondant. Peut être une adresse publique (Internet) ou une
  -- autre machine du réseau.
  destination    VARCHAR(45) NOT NULL,

  -- Port du correspondant. NULL quand le protocole n'en a pas (ICMP).
  port_distant   SMALLINT UNSIGNED DEFAULT NULL,

  -- Numéro IANA : 6 = TCP, 17 = UDP, 1 = ICMP.
  protocole      TINYINT UNSIGNED DEFAULT NULL,

  -- Sens vu DEPUIS la machine du parc : ce qu'elle a envoyé, ce qu'elle
  -- a reçu. En octets, pas en débit — le débit se calcule à l'affichage,
  -- et une somme d'octets reste juste quelle que soit la fenêtre.
  octets_sortants BIGINT UNSIGNED NOT NULL DEFAULT 0,
  octets_entrants BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- Début de la fenêtre d'agrégation, arrondi à la minute.
  date_fenetre   DATETIME NOT NULL,

  -- Une seule ligne par (machine, correspondant, port, fenêtre) : le
  -- collecteur additionne dans la ligne existante au lieu d'en créer une
  -- nouvelle à chaque paquet reçu.
  UNIQUE KEY uniq_flux (id_equipement, destination, port_distant, protocole, date_fenetre),
  KEY idx_flux_equipement (id_equipement, date_fenetre),
  KEY idx_flux_fenetre (date_fenetre),

  CONSTRAINT fk_flux_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- LE NOM DERRIÈRE L'ADRESSE
--
-- « 142.250.75.238 » ne dit rien à personne. Le DNS inverse répond
-- souvent quelque chose d'utile — par exemple un nom en googlevideo.com,
-- qui identifie la plateforme mieux qu'un logo.
--
-- Cette résolution est mise en cache ICI, et pas seulement en mémoire :
-- une même adresse revient des milliers de fois, et un redémarrage du
-- serveur ne doit pas relancer des milliers de requêtes DNS.
--
-- UN ÉCHEC EST AUSSI UN RÉSULTAT. Beaucoup d'adresses n'ont pas de nom
-- inverse ; sans mémoriser l'échec, on réinterrogerait le DNS toutes les
-- cinq minutes pour rien. `nom` à NULL avec une `date_maj` récente
-- signifie « on a demandé, il n'y a pas de nom » — pas « on n'a pas
-- encore demandé ».
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS NOM_DESTINATION (
  adresse       VARCHAR(45) NOT NULL PRIMARY KEY,

  -- Nom complet rendu par le DNS inverse, ou NULL s'il n'y en a pas.
  nom           VARCHAR(255) DEFAULT NULL,

  -- Domaine enregistrable extrait du nom : c'est lui qui regroupe.
  -- « rr1---sn-4g5e6nzz.googlevideo.com » et « rr3---sn-a5m7lne6.googlevideo.com »
  -- sont deux serveurs du même service, et doivent compter ensemble.
  domaine       VARCHAR(255) DEFAULT NULL,

  date_maj      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  KEY idx_nom_domaine (domaine)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
