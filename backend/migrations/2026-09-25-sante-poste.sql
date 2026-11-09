-- ---------------------------------------------------------------------
-- 2026-09-25 — La santé des postes, sans rien installer dessus.
--
-- CE QUI MANQUAIT, ET POURQUOI C'EST LA VRAIE DIFFÉRENCE
--
-- L'inventaire disait QUOI est installé sur un poste et QUOI y tourne.
-- Il ne disait pas si ce poste va bien. Quatre choses le disent, et un
-- responsable informatique de PME les demande avant toutes les autres :
--
--   la mémoire qui reste,
--   l'espace disque qui reste,
--   depuis quand la machine n'a pas redémarré,
--   l'état des trois services qui la protègent — pare-feu, antivirus,
--   mises à jour.
--
-- Les plateformes concurrentes obtiennent ces chiffres en INSTALLANT UN
-- AGENT SUR CHAQUE MACHINE : il faut le déployer sur tout le parc, le
-- maintenir, et ouvrir un port sur chaque poste. Ici, la même voie WMI
-- qui lit déjà les programmes en cours les rapporte : rien n'est
-- installé sur les postes, et rien n'y est ouvert.
--
-- UNE LIGNE PAR ÉQUIPEMENT, PAS UN HISTORIQUE
--
-- C'est un ÉTAT, daté, remplacé à chaque relevé. Garder l'historique de
-- l'espace disque de cent postes toutes les cinq minutes ferait une
-- table de plusieurs millions de lignes pour une question à laquelle on
-- répond avec le dernier relevé. L'historique de charge existe déjà,
-- dans RELEVE, pour les machines qui l'exposent.
--
-- TOUT EST FACULTATIF, ET C'EST VOULU
--
-- Un poste interrogé par DCOM peut donner sa mémoire sans donner ses
-- disques. Chaque colonne accepte donc NULL — « je n'ai pas regardé » —
-- et le code n'écrit jamais zéro à la place : « 0 Go libres » déclencherait
-- une alarme, et elle serait fausse.
--
-- REJOUABLE SANS RISQUE : CREATE TABLE IF NOT EXISTS ne touche pas à une
-- table déjà présente, et aucune donnée existante n'est modifiée.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS SANTE_POSTE (
  id_equipement      INT NOT NULL,

  -- La date du relevé. Sans elle, on lirait l'état d'il y a trois jours
  -- en croyant voir maintenant — le même défaut que pour les processus.
  date_releve        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Par quelle voie on l'a su : 'wmi', 'snmp' ou 'agent'. Une valeur
  -- affichée doit pouvoir dire d'où elle vient.
  source             VARCHAR(20) DEFAULT NULL,

  memoire_totale_mo  INT DEFAULT NULL,
  memoire_libre_mo   INT DEFAULT NULL,

  -- Heure du dernier démarrage de la machine. Un poste qui n'a pas
  -- redémarré depuis quarante jours n'a pas appliqué ses mises à jour.
  dernier_demarrage  DATETIME DEFAULT NULL,

  -- [{ lettre, total_go, libre_go }] — un poste a un nombre variable de
  -- disques, et les mettre en colonnes obligerait à choisir un maximum.
  disques            JSON DEFAULT NULL,

  -- [{ nom, libelle, etat, demarrage }] pour les trois services de
  -- protection, et eux seuls : la liste complète des services d'un poste
  -- pèse des centaines de lignes et n'apprend rien.
  services           JSON DEFAULT NULL,

  -- Les antivirus déclarés à Windows, par leur nom. On ne conserve PAS
  -- l'état « actif / inactif » que Windows encode dans un entier non
  -- documenté : une plateforme qui annonce « ce poste est protégé » doit
  -- pouvoir le prouver.
  antivirus          JSON DEFAULT NULL,

  PRIMARY KEY (id_equipement),
  CONSTRAINT fk_sante_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
