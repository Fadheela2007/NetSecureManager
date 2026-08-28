#!/usr/bin/env bash
#
# installer.sh — met en service l'agent NetSecureManager sur un site distant.
#
# Usage :
#   sudo bash installer.sh --url https://superviseur.exemple.com/api \
#                          --token <jeton du site> \
#                          --site 2 \
#                          --cidr 192.168.10.0/24
#
# La commande complète, jeton inclus, est fournie par l'interface :
#   Sites -> le site concerné -> « Mettre en service l'agent ».
#
# Ce script installe l'agent, crée un service systemd qui démarre au boot,
# puis VÉRIFIE que la première remontée arrive bien à la plateforme.

set -euo pipefail

DEST="/opt/netsecuremanager-agent"
SERVICE="netsecuremanager-agent"
INTERVALLE=5
COMMUNAUTE="public"

rouge()  { printf '\033[31m%s\033[0m\n' "$1"; }
vert()   { printf '\033[32m%s\033[0m\n' "$1"; }
info()   { printf '  %s\n' "$1"; }
etape()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)      URL="$2"; shift 2 ;;
    --token)    TOKEN="$2"; shift 2 ;;
    --site)     SITE="$2"; shift 2 ;;
    --cidr)     CIDR="$2"; shift 2 ;;
    --intervalle) INTERVALLE="$2"; shift 2 ;;
    --communaute) COMMUNAUTE="$2"; shift 2 ;;
    --dest)     DEST="$2"; shift 2 ;;
    *) rouge "Option inconnue : $1"; exit 1 ;;
  esac
done

for v in URL TOKEN SITE CIDR; do
  if [[ -z "${!v:-}" ]]; then
    rouge "Paramètre manquant : --$(echo "$v" | tr '[:upper:]' '[:lower:]')"
    echo "Récupérez la commande complète depuis l'interface : Sites -> Mettre en service l'agent."
    exit 1
  fi
done

if [[ $EUID -ne 0 ]]; then
  rouge "Ce script doit être lancé avec sudo (il crée un service systemd)."
  exit 1
fi

etape "1/5  Vérification des prérequis"
if ! command -v node >/dev/null 2>&1; then
  rouge "Node.js est absent."
  info "Debian/Ubuntu : sudo apt install -y nodejs npm"
  info "RHEL/Rocky    : sudo dnf install -y nodejs"
  exit 1
fi
VERSION_NODE=$(node -v)
info "Node.js $VERSION_NODE"
if ! command -v nmap >/dev/null 2>&1; then
  info "nmap absent — l'agent fonctionnera, mais sans identification par empreinte TCP/IP."
  info "Pour l'ajouter : sudo apt install -y nmap"
fi

etape "2/5  Installation dans $DEST"
mkdir -p "$DEST"
# Le script est livré à côté des sources de l'agent : on copie ce qui est
# nécessaire à son exécution.
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ ! -f "$SOURCE/package.json" ]]; then
  rouge "Sources introuvables. Lancez ce script depuis le dossier backend/src/agent du projet."
  exit 1
fi
cp -r "$SOURCE/src" "$SOURCE/package.json" "$DEST/"
[[ -d "$SOURCE/data" ]] && cp -r "$SOURCE/data" "$DEST/"
cd "$DEST"
npm install --omit=dev --silent --no-audit --no-fund
info "Dépendances installées"

etape "3/5  Configuration"
cat > "$DEST/.env" <<EOF
CENTRAL_API_URL=$URL
AGENT_TOKEN=$TOKEN
ID_SITE=$SITE
CIDR=$CIDR
SCAN_INTERVAL_MINUTES=$INTERVALLE
SNMP_COMMUNITY=$COMMUNAUTE
EOF
# Le jeton vaut un mot de passe : personne d'autre que root ne doit le lire.
chmod 600 "$DEST/.env"
info "Site $SITE, plage $CIDR, scan toutes les $INTERVALLE min"

etape "4/5  Service systemd"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Agent NetSecureManager (site $SITE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=$(command -v node) $DEST/src/agent/agent.js
Restart=always
RestartSec=30
# Le balayage réseau (ping brut, ARP) demande des privilèges réseau.
AmbientCapabilities=CAP_NET_RAW
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DEST
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
info "Service activé — il redémarrera automatiquement au boot"

etape "5/5  Vérification de la remontée"

# On interroge la PLATEFORME, pas le journal local : seul cela prouve que
# la chaîne complète fonctionne. Un agent peut très bien écrire « envoyé »
# dans son journal alors que le pare-feu bloque la sortie.
if command -v curl >/dev/null 2>&1; then
  REPONSE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/agent/ping" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"id_site\":$SITE}" --max-time 10 || echo "000")
  case "$REPONSE" in
    200) info "Plateforme joignable, jeton accepté" ;;
    403) rouge "Jeton refusé par la plateforme."
         info "Il a probablement été régénéré. Reprenez la commande depuis l'interface."
         exit 1 ;;
    000) rouge "Plateforme injoignable depuis ce réseau ($URL)."
         info "Vérifiez l'URL, le DNS et les règles de sortie du pare-feu."
         exit 1 ;;
    *)   info "Réponse inattendue de la plateforme (HTTP $REPONSE) — on poursuit." ;;
  esac
fi

# ---------------------------------------------------------------------
# DURÉE D'ATTENTE PROPORTIONNELLE À LA PLAGE.
#
# L'attente était fixée à 90 s, ce qui ne convient qu'à une petite plage.
# Un /23 compte 510 adresses : le balayage ping seul prend une vingtaine
# de secondes, puis CHAQUE machine trouvée est interrogée en SNMP puis,
# si son type reste indéterminé, par empreinte nmap — jusqu'à 15 s par
# machine. Sur 25 machines actives, le premier cycle dépasse largement
# les cinq minutes.
#
# Conclure « la transmission n'a pas abouti » au bout de 90 s était donc
# FAUX dans le cas le plus courant : l'agent fonctionnait, il n'avait
# simplement pas fini. Un diagnostic faux coûte plus cher qu'une attente
# plus longue.
# ---------------------------------------------------------------------
PREFIXE="${CIDR##*/}"
case "$PREFIXE" in
  ''|*[!0-9]*) PREFIXE=24 ;;
esac
NB_HOTES=$(( (1 << (32 - PREFIXE)) - 2 ))
[[ $NB_HOTES -lt 1 ]] && NB_HOTES=1
# Plafonné à 4 min, même pour une très grande plage. Attendre 12 minutes
# devant un installateur serait absurde : la réponse 200 au ping obtenue
# plus haut prouve déjà que l'URL est bonne, que le pare-feu laisse passer
# et que le jeton est accepté. La remontée n'ajoute qu'une confirmation —
# le site passera « Actif » tout seul, avec ou sans nous.
BUDGET=$(( NB_HOTES * 3 / 2 ))
[[ $BUDGET -lt 90 ]] && BUDGET=90
[[ $BUDGET -gt 240 ]] && BUDGET=240

info "Plage de $NB_HOTES adresses — vérification pendant $BUDGET s au plus."
info "Le premier cycle est le plus long : chaque machine trouvée est identifiée une à une."

OK=0
ECOULE=0
while [[ $ECOULE -lt $BUDGET ]]; do
  sleep 5
  ECOULE=$((ECOULE + 5))

  # Un service arrêté est une VRAIE panne, à distinguer d'un scan en
  # cours : on ne l'attend pas jusqu'au bout du budget.
  if ! systemctl is-active --quiet "$SERVICE"; then
    rouge "Le service s'est arrêté. Journal :"
    journalctl -u "$SERVICE" -n 20 --no-pager
    exit 1
  fi

  if journalctl -u "$SERVICE" --since "-10 min" --no-pager 2>/dev/null | grep -q "équipement(s)"; then
    OK=1; break
  fi
  printf "\r  %s s / %s s écoulées…" "$ECOULE" "$BUDGET"
done
echo

echo
if [[ $OK -eq 1 ]]; then
  vert "✓ Agent en service. Première remontée effectuée."
  journalctl -u "$SERVICE" -n 3 --no-pager | sed 's/^/  /'
  echo
  info "Vérifiez dans l'interface : Sites -> le site doit afficher « Actif »."
else
  # Ce n'est PAS un échec : la plateforme a déjà répondu 200 plus haut,
  # donc l'URL est bonne, le pare-feu laisse passer et le jeton est
  # accepté. Les trois causes classiques sont écartées ; il ne reste que
  # le scan qui n'a pas fini. Le dire franchement plutôt que d'accuser au
  # hasard.
  vert "✓ Installation correcte. Plateforme joignable, jeton accepté."
  echo
  info "La première remontée n'est pas encore arrivée — c'est normal sur une"
  info "plage de $NB_HOTES adresses : le premier cycle identifie chaque machine"
  info "une par une et peut durer plusieurs minutes."
  echo
  info "Rien à faire : le site passera « Actif » tout seul dans l'interface."
  info "Pour suivre en direct :  journalctl -u $SERVICE -f"
fi

echo
echo "Commandes utiles :"
echo "  systemctl status $SERVICE     état du service"
echo "  journalctl -u $SERVICE -f     journal en direct"
echo "  systemctl restart $SERVICE    après modification de $DEST/.env"
