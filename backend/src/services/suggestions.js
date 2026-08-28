/**
 * suggestions.js
 * Associe un code de cause détecté à des étapes concrètes de résolution.
 * C'est ça qui rend la plateforme "facile à résoudre" — pas une cause
 * parfaite, mais un point de départ actionnable pour l'opérateur.
 */

const SUGGESTIONS = {
  pare_feu_probable: [
    "Vérifier si l'équipement est vraiment allumé en se connectant physiquement ou via le port détecté actif.",
    "Vérifier la configuration du pare-feu local (Windows Defender, iptables) — l'ICMP (ping) est peut-être bloqué volontairement.",
    "Si c'est normal pour cet équipement (pare-feu voulu), envisager d'exclure ce type d'alerte pour lui.",
  ],
  injoignable_total: [
    "Vérifier l'alimentation électrique et le branchement réseau (câble ou Wi-Fi) de l'équipement.",
    "Vérifier que l'équipement n'a pas changé d'adresse IP (conflit DHCP).",
    "Si l'équipement est sur un site distant, vérifier que l'agent local de ce site fonctionne toujours.",
  ],
  cpu_eleve: [
    "Identifier le processus responsable : Gestionnaire des tâches (Windows), ou « top » / « htop » (Linux) trié par consommation processeur.",
    "Déterminer si la charge est ponctuelle ou durable : une sauvegarde, un antivirus ou une mise à jour saturent le processeur quelques minutes, ce qui est normal. Consulter le graphique CPU sur 24 h dans la fiche de l'équipement.",
    "Si la charge est permanente, vérifier qu'aucun processus n'est bloqué en boucle (redémarrer le service concerné plutôt que la machine entière).",
    "Sur un serveur virtualisé, vérifier que l'hôte n'est pas surchargé : le problème peut venir d'une autre machine virtuelle du même hyperviseur.",
    "Si la charge est légitime et durable, l'équipement est sous-dimensionné pour son usage : envisager d'ajouter des ressources ou de répartir le service.",
  ],
  ram_elevee: [
    "Identifier le processus qui consomme le plus de mémoire (Gestionnaire des tâches, ou « top » trié par mémoire sous Linux).",
    "Distinguer mémoire utilisée et mémoire mise en cache : sous Linux, un cache élevé est normal et n'indique pas une saturation. Vérifier avec « free -h » la ligne « available ».",
    "Une consommation qui monte régulièrement sans jamais redescendre évoque une fuite mémoire : redémarrer le service concerné et surveiller si la progression reprend.",
    "Vérifier l'activité du fichier d'échange (swap) : si la machine y recourt en permanence, les performances s'effondrent bien avant que la mémoire soit pleine.",
    "Si la consommation est légitime, ajouter de la mémoire ou déplacer une partie des services sur une autre machine.",
  ],
  agent_muet: [
    "Vérifier que la machine qui héberge l'agent de ce site est allumée et connectée au réseau.",
    "Sur cette machine, vérifier que le processus de l'agent tourne toujours (il s'arrête si la session utilisateur est fermée — préférer un démarrage automatique au boot).",
    "Consulter le journal de l'agent : une erreur répétée d'envoi indique plutôt un problème de liaison vers la plateforme centrale (pare-feu, DNS, certificat).",
    "Vérifier que CENTRAL_API_URL et AGENT_TOKEN du fichier .env de l'agent sont toujours corrects — un token régénéré côté plateforme invalide l'ancien.",
    "Tant que l'agent est muet, les équipements de ce site affichent leur dernier état connu : ne pas s'y fier pour conclure que le réseau va bien.",
  ],
  conflit_ip: [
    "Deux équipements semblent utiliser la même adresse IP — vérifier la configuration réseau des deux machines concernées.",
    "Vérifier la plage d'adresses réservées par le serveur DHCP pour éviter les doublons.",
  ],
};

function getSuggestion(code) {
  return SUGGESTIONS[code] || ["Aucune piste automatique disponible pour ce type d'alerte."];
}

module.exports = { getSuggestion };