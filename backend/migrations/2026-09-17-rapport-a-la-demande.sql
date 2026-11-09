-- ---------------------------------------------------------------------
-- 2026-09-17 — Le rapport part sur demande, plus tout seul.
--
-- CE QUI CHANGE, ET POURQUOI
--
-- L'envoi automatique du rapport fonctionnait : chaque semaine, ou chaque
-- mois, un courriel partait avec le PDF en pièce jointe. Le défaut n'est
-- pas technique, il est d'usage.
--
-- Un message qui arrive de lui-même, toujours le même jour, avec toujours
-- la même tête, finit dans un dossier qu'on n'ouvre plus. Et le jour où
-- le rapport contient quelque chose d'important, personne ne le lit —
-- c'est exactement le mécanisme qui rend les alertes inutiles quand elles
-- crient trop souvent, et il vaut aussi pour les rapports.
--
-- Un rapport demandé est un rapport attendu, donc lu. Le bouton
-- « Rapport par courriel » du tableau de bord envoie le même document,
-- au moment où quelqu'un en a besoin.
--
-- CE QUI N'EST PAS SUPPRIMÉ. La planification reste dans le produit,
-- entière : le service, les réglages, la route. On repose simplement la
-- fréquence sur « desactive », qui est SA VALEUR PAR DÉFAUT d'origine
-- (voir l'en-tête de rapportPlanifieService.js : « On ne se met pas à
-- écrire à des gens sans qu'ils l'aient demandé »). Un client qui veut
-- l'envoi hebdomadaire remet « hebdomadaire » dans cette même ligne, et
-- tout repart.
--
-- L'horodatage du dernier envoi est laissé en place : c'est une trace de
-- ce qui s'est passé, et on n'efface pas l'histoire.
-- ---------------------------------------------------------------------

-- INSERT IGNORE, ET SURTOUT PAS « ON DUPLICATE KEY UPDATE ».
--
-- Cette semence portait un ON DUPLICATE qui réécrivait la valeur à
-- 'desactive' — alors qu'il n'existe aucune table de suivi des
-- migrations et que l'outil rejoue TOUS les fichiers à chaque passage,
-- deux fois même s'il reste une erreur au premier tour.
--
-- Un client qui avait réglé ses rapports en hebdomadaire repassait donc
-- silencieusement en « desactive » à la mise à jour suivante. Les
-- rapports cessaient d'arriver, sans message et sans trace au journal :
-- personne ne pouvait relier la panne à la mise à jour.
--
-- Une semence pose une valeur de DÉPART. Elle ne corrige pas un choix.
INSERT IGNORE INTO CONFIGURATION (cle, valeur, description)
VALUES (
  'rapport_planifie_frequence',
  'desactive',
  'Envoi automatique du rapport : desactive | hebdomadaire | mensuel. Le bouton « Rapport par courriel » du tableau de bord envoie a la demande.'
);
