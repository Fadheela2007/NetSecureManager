-- ---------------------------------------------------------------------
-- 2026-09-28 — Deux alertes que seul le plan d'adressage peut lever.
--
-- 1. UNE PLAGE PRESQUE PLEINE
--
-- Un responsable réseau découvre d'habitude qu'il n'a plus d'adresses le
-- jour où une machine ne peut plus se connecter : au pire moment, et sans
-- préavis. Le compte existe pourtant déjà dans le plan d'adressage ; il
-- suffisait de le regarder une fois par heure.
--
-- Le seuil est en POURCENTAGE d'adresses libres, pas en nombre : dix
-- adresses restantes ne veulent pas dire la même chose sur un /24 que sur
-- un /16.
--
-- 2. UNE MACHINE POSÉE SUR UNE ZONE RÉSERVÉE
--
-- Typiquement une adresse fixe donnée à la main dans le pool DHCP. Ça
-- fonctionne — jusqu'au jour où le serveur DHCP attribue la même adresse
-- à quelqu'un d'autre. La panne qui suit est intermittente, et on la
-- cherche du côté du câble pendant une semaine.
--
-- Cette alerte n'existe QUE parce que la plateforme connaît les zones
-- déclarées par l'entreprise. Aucun outil de supervision classique ne
-- peut la lever : il ne sait pas ce qui a été promis à qui.
--
-- LES DEUX SONT DES RÈGLES ORDINAIRES : niveau, seuil et interrupteur se
-- modifient depuis l'écran Alertes, comme les autres. Toutes deux en
-- AVERTISSEMENT et non en critique : ce ne sont pas des pannes, ce sont
-- des pannes qui attendent leur tour. Réserver le critique à ce qui est
-- déjà cassé est ce qui garde au rouge sa valeur.
--
-- REJOUABLE SANS RISQUE : les lignes ne sont semées que si elles
-- n'existent pas, et un réglage modifié n'est jamais réécrit.
-- ---------------------------------------------------------------------

INSERT INTO REGLE_ALERTE (code, cible, active, niveau, seuil, releves_requis, libelle, aide)
SELECT * FROM (
  SELECT 'plage_presque_pleine' AS code, 'tous' AS cible, 1 AS active,
         'warning' AS niveau, 10.00 AS seuil, NULL AS releves_requis,
         'Une plage n''a presque plus d''adresses libres' AS libelle,
         'Seuil en pourcentage d''adresses libres. Vérifié une fois par heure, sans aucun paquet envoyé sur le réseau.' AS aide
  UNION ALL SELECT 'adresse_sur_zone_reservee', 'tous', 1, 'warning', NULL, NULL,
         'Une machine occupe une adresse réservée',
         'Par exemple une adresse fixe posée dans le pool DHCP : elle peut être attribuée deux fois.'
) AS semences
WHERE NOT EXISTS (
  SELECT 1 FROM REGLE_ALERTE r
   WHERE r.code = semences.code AND r.cible = semences.cible
);
