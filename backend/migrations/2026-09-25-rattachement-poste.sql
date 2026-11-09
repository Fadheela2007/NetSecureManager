-- ---------------------------------------------------------------------
-- 2026-09-25 — Rattacher un poste par un code à usage unique.
--
-- CE QUI N'ALLAIT PAS DANS L'INSTALLATION D'UN AGENT DE POSTE
--
-- Jusqu'ici, installer l'agent sur un poste demandait de saisir LE JETON
-- DU SITE. C'est le même secret pour toutes les machines du site, et il
-- donne le droit d'écrire au nom du site entier. Le recopier sur trente
-- postes, c'est le laisser dans trente fichiers, trente historiques de
-- presse-papier et, tôt ou tard, dans une capture d'écran. Le jour où il
-- fuit, il faut le régénérer partout à la fois.
--
-- CE QUI CHANGE
--
--   1. Un administrateur demande le rattachement d'UN poste précis. La
--      plateforme fabrique un code court, valable 30 minutes, à usage
--      unique, et qui ne vaut QUE pour ce poste.
--   2. La personne devant la machine lance l'installation avec ce code.
--   3. L'agent échange le code contre un JETON PROPRE À CE POSTE. Le
--      code est alors brûlé.
--
-- Trois propriétés qui en découlent, et qui valent d'être dites :
--
--   RIEN N'ENTRE SANS CONSENTEMENT. Il faut que quelqu'un, devant la
--   machine, lance la commande. Les plateformes qui déploient leur agent
--   en masse et en silence n'ont pas cette garantie à offrir.
--
--   UN POSTE COMPROMIS NE COMPROMET QUE LUI. Son jeton ne permet
--   d'écrire que son propre inventaire. Le jeton du site, lui, ne quitte
--   plus le serveur du site.
--
--   ON SAIT QUI A ACCEPTÉ, ET QUAND. Le demandeur, l'heure de la demande,
--   l'heure du rattachement et l'adresse vue à ce moment-là sont
--   conservés. C'est la preuve, au même titre que partout ailleurs.
--
-- REJOUABLE SANS RISQUE : CREATE TABLE IF NOT EXISTS ne touche pas à une
-- table déjà présente.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS RATTACHEMENT_POSTE (
  id_equipement     INT NOT NULL,

  -- Le code en cours de validité. Vidé dès qu'il est utilisé ou annulé :
  -- un code qui traîne après usage est un code qu'on croit encore bon.
  code              VARCHAR(20) DEFAULT NULL,
  code_expire_le    DATETIME DEFAULT NULL,

  -- Qui a demandé le rattachement, et quand. ON DELETE SET NULL : un
  -- compte supprimé ne doit pas effacer l'historique du poste.
  demande_par       INT DEFAULT NULL,
  demande_le        DATETIME DEFAULT NULL,

  -- Le jeton propre à ce poste, obtenu en échange du code. C'est lui que
  -- l'agent présente ensuite, et lui seul.
  jeton             VARCHAR(64) DEFAULT NULL,
  rattache_le       DATETIME DEFAULT NULL,

  -- Ce que la machine a déclaré au moment du rattachement, et l'adresse
  -- d'où elle parlait. Sert à vérifier qu'on a bien rattaché le poste
  -- qu'on croyait.
  nom_declare       VARCHAR(120) DEFAULT NULL,
  adresse_vue       VARCHAR(45) DEFAULT NULL,
  dernier_envoi     DATETIME DEFAULT NULL,

  PRIMARY KEY (id_equipement),
  UNIQUE KEY uniq_rattachement_code (code),
  UNIQUE KEY uniq_rattachement_jeton (jeton),
  CONSTRAINT fk_rattachement_equipement FOREIGN KEY (id_equipement)
    REFERENCES EQUIPEMENT (id_equipement) ON DELETE CASCADE,
  CONSTRAINT fk_rattachement_utilisateur FOREIGN KEY (demande_par)
    REFERENCES UTILISATEUR (id_utilisateur) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
