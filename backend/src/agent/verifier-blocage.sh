#!/usr/bin/env bash
#
# verifier-blocage.sh — dit précisément où la chaîne de blocage s'arrête.
#
#   bash verifier-blocage.sh
#
# ─────────────────────────────────────────────────────────────────────
# POURQUOI CE SCRIPT
#
# « nslookup doubleclick.net » qui renvoie une vraie adresse a QUATRE
# causes possibles, et le message ne dit pas laquelle :
#
#   1. l'agent n'a jamais écrit la liste ;
#   2. il l'a écrite mais dnsmasq ne l'a pas rechargée ;
#   3. tout fonctionne, mais CE domaine précis n'est pas dans la liste ;
#   4. le poste Windows n'interroge pas dnsmasq.
#
# La cause 3 est la plus vicieuse : tout marche, et on croit que rien ne
# marche. Les listes publiques bloquent « ad.doubleclick.net » et
# « stats.g.doubleclick.net » sans forcément bloquer « doubleclick.net »
# tout court — qui n'est pas un domaine publicitaire en soi.
#
# Ce script regarde chaque maillon dans l'ordre et s'arrête au premier
# qui casse. Surtout, il choisit un domaine de test PRIS DANS LA LISTE
# réelle, au lieu d'en supposer un.
# ─────────────────────────────────────────────────────────────────────

CONF=/etc/dnsmasq.d/netsecuremanager.conf

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
jaune() { printf '\033[33m%s\033[0m\n' "$1"; }
etape() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ─────────────────────────────────────────────────────────────────────
etape "1/5  L'agent a-t-il écrit la liste ?"

if [[ ! -f "$CONF" ]]; then
  rouge "  Le fichier $CONF n'existe pas."
  echo
  echo "  L'agent n'a jamais appliqué la politique. Relancez-le et lisez"
  echo "  la ligne « Politique web ... » :"
  echo
  echo "    sudo bash $(dirname "$0")/lancer-agent-wsl.sh 1 votre-jeton"
  echo
  echo "  Fichiers présents dans /etc/dnsmasq.d :"
  ls -1 /etc/dnsmasq.d/ 2>/dev/null | sed 's/^/    /' || echo "    (dossier vide)"
  exit 1
fi

NB=$(grep -c '^address=' "$CONF" 2>/dev/null || echo 0)
echo "  Fichier écrit le : $(stat -c %y "$CONF" 2>/dev/null | cut -d. -f1)"

if [[ "$NB" -eq 0 ]]; then
  rouge "  Le fichier existe mais ne contient AUCUN domaine bloqué."
  echo "  La politique est peut-être active sans catégorie remplie."
  echo "  Vérifiez l'écran « Accès web » : une catégorie cochée mais vide"
  echo "  ne bloque rien."
  exit 1
fi
vert "  $NB domaine(s) bloqué(s) dans la liste."

# ─────────────────────────────────────────────────────────────────────
etape "2/5  dnsmasq tourne-t-il, et avec CETTE liste ?"

if ! systemctl is-active --quiet dnsmasq 2>/dev/null; then
  rouge "  dnsmasq est arrêté."
  echo "  Relancez :  sudo systemctl restart dnsmasq"
  echo "  Journal :"
  journalctl -u dnsmasq -n 10 --no-pager 2>/dev/null | sed 's/^/    /'
  exit 1
fi

# Le fichier peut être plus récent que le démarrage du service : dans ce
# cas dnsmasq applique encore l'ANCIENNE liste, et tout paraît cassé
# alors que seule la relecture manque.
DEMARRAGE=$(systemctl show dnsmasq --property=ActiveEnterTimestamp --value 2>/dev/null)
if [[ -n "$DEMARRAGE" ]]; then
  T_SERVICE=$(date -d "$DEMARRAGE" +%s 2>/dev/null || echo 0)
  T_FICHIER=$(stat -c %Y "$CONF" 2>/dev/null || echo 0)
  if [[ "$T_FICHIER" -gt "$T_SERVICE" ]]; then
    jaune "  La liste est plus récente que le service : dnsmasq ne l'a pas lue."
    echo "  Rechargement..."
    systemctl restart dnsmasq 2>/dev/null || sudo systemctl restart dnsmasq
    sleep 1
  fi
fi
vert "  dnsmasq est actif."

IP=$(ip -4 route show default 2>/dev/null | awk '{print $5}' | head -1)
IP=$(ip -4 addr show "${IP:-eth0}" 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
echo "  Adresse du résolveur : $IP"

# ─────────────────────────────────────────────────────────────────────
etape "3/5  Le domaine que vous testiez est-il seulement dans la liste ?"

TESTE="${1:-doubleclick.net}"
if grep -q "^address=/$TESTE/" "$CONF"; then
  vert "  Oui, « $TESTE » est bien dans la liste."
else
  jaune "  NON — « $TESTE » n'est PAS dans la liste."
  echo
  echo "  Ce n'est pas une panne. Les listes publiques bloquent les"
  echo "  sous-domaines publicitaires sans bloquer le domaine racine :"
  grep "^address=/[^/]*$TESTE/" "$CONF" 2>/dev/null | head -5 | sed 's|^address=/|    |; s|/.*||'
  echo
  echo "  Tester ce domaine-là ne prouvait donc rien."
fi

# ─────────────────────────────────────────────────────────────────────
etape "4/5  Test sur un domaine RÉELLEMENT bloqué"

# On prend un domaine dans la liste plutôt que d'en supposer un : c'est
# la seule façon de séparer « le blocage ne marche pas » de « ce domaine
# n'était pas concerné ».
ECHANTILLON=$(grep -m 40 '^address=/' "$CONF" | sed 's|^address=/||; s|/.*||' | grep -v '^exemple-bloque-nsm' | head -3)

if [[ -z "$ECHANTILLON" ]]; then
  rouge "  Impossible d'extraire un domaine de la liste."
  exit 1
fi

echo "  Domaines pris dans votre liste :"
echo "$ECHANTILLON" | sed 's/^/    /'
echo

OUTIL=""
command -v dig >/dev/null 2>&1 && OUTIL=dig
[[ -z "$OUTIL" ]] && command -v nslookup >/dev/null 2>&1 && OUTIL=nslookup

if [[ -z "$OUTIL" ]]; then
  jaune "  Ni dig ni nslookup dans WSL — test impossible ici."
  echo "  Installez :  sudo apt install dnsutils -y"
  echo
  echo "  Ou testez depuis PowerShell, côté Windows :"
  echo "$ECHANTILLON" | head -1 | sed "s|^|    nslookup |; s|$| $IP|"
  exit 0
fi

BLOQUES=0
TOTAL=0
while read -r d; do
  [[ -z "$d" ]] && continue
  TOTAL=$((TOTAL + 1))
  if [[ "$OUTIL" == dig ]]; then
    REP=$(dig +short +timeout=3 @"$IP" "$d" A 2>/dev/null | head -1)
  else
    REP=$(nslookup "$d" "$IP" 2>/dev/null | awk '/^Address/{print $2}' | tail -1)
  fi

  if [[ "$REP" == "0.0.0.0" || "$REP" == "$IP" ]]; then
    vert "    $d -> $REP  (bloqué)"
    BLOQUES=$((BLOQUES + 1))
  else
    rouge "    $d -> ${REP:-aucune réponse}  (NON bloqué)"
  fi
done <<< "$ECHANTILLON"

# ─────────────────────────────────────────────────────────────────────
etape "5/5  Verdict"

echo
if [[ "$BLOQUES" -eq "$TOTAL" && "$TOTAL" -gt 0 ]]; then
  vert "══════════════════════════════════════════════════════"
  vert "  LE BLOCAGE FONCTIONNE."
  vert "══════════════════════════════════════════════════════"
  echo
  echo "  Il reste à faire interroger votre PC. Dans PowerShell"
  echo "  ADMINISTRATEUR, côté Windows :"
  echo
  echo "    Set-DnsClientServerAddress -InterfaceAlias \"Ethernet\" -ServerAddresses $IP"
  echo
  echo "  Puis testez, toujours dans PowerShell :"
  echo "$ECHANTILLON" | head -1 | sed 's|^|    nslookup |'
  echo
  echo "  Marche arrière, à garder sous la main :"
  echo "    Set-DnsClientServerAddress -InterfaceAlias \"Ethernet\" -ResetServerAddresses"
else
  rouge "  dnsmasq a la liste mais ne bloque pas ($BLOQUES/$TOTAL)."
  echo
  echo "  Envoyez-moi ces deux sorties :"
  echo "    head -20 $CONF"
  echo "    journalctl -u dnsmasq -n 20 --no-pager"
fi
echo
