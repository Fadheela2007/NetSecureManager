#!/usr/bin/env bash
#
# lancer-agent-wsl.sh — fait tourner l'agent dans WSL pour appliquer la
# politique de blocage web sur dnsmasq.
#
#   sudo bash lancer-agent-wsl.sh <ID_SITE> <JETON> [CIDR]
#
# Exemple :
#   sudo bash lancer-agent-wsl.sh 1 token-douala-123 192.168.0.0/23
#
# ─────────────────────────────────────────────────────────────────────
# POURQUOI UN SCRIPT SÉPARÉ DE L'INSTALLATEUR NORMAL
#
# `installer.sh` suppose un site distant : une machine dédiée, un service
# systemd permanent, un scan réseau complet. Ici, on veut seulement
# vérifier que la politique arrive et s'applique — sur une VM jetable, en
# une exécution, sans rien installer de durable.
#
# Deux obstacles propres à WSL, que l'installateur normal ne connaît pas :
#
#   1. « localhost » dans WSL désigne WSL, pas Windows. Le backend tourne
#      côté Windows : il faut son adresse vue depuis Linux, qui est celle
#      de la passerelle par défaut.
#
#   2. Le pare-feu Windows bloque par défaut les connexions venant de
#      WSL. Le symptôme est un délai d'attente sans message — ce script
#      le teste et donne la commande de déblocage.
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
jaune() { printf '\033[33m%s\033[0m\n' "$1"; }
etape() { printf '\n\033[1m%s\033[0m\n' "$1"; }

ID_SITE="${1:-}"
JETON="${2:-}"
CIDR="${3:-}"

if [[ $EUID -ne 0 ]]; then
  rouge "Ce script doit être lancé avec sudo."
  echo "  L'agent doit écrire dans /etc/dnsmasq.d et recharger le service."
  exit 1
fi

# Les marques de remplacement collées telles quelles sont une erreur si
# fréquente qu'elle mérite son propre message : sinon on lit « jeton
# refusé » et on cherche du côté de la base, alors que le jeton n'a
# simplement jamais été saisi.
case "$JETON" in
  VOTRE_JETON|VOTRE-JETON|"<JETON>"|JETON|"votre_jeton")
    rouge "Vous avez collé le texte d'exemple « $JETON » au lieu du vrai jeton."
    echo
    echo "  Récupérez-le dans MySQL Workbench :"
    echo
    echo "    SELECT id_site, nom, agent_token FROM SITE;"
    echo
    echo "  Puis relancez avec la valeur de la colonne agent_token :"
    echo "    sudo bash $0 $ID_SITE la-valeur-copiee"
    echo
    echo "  Si agent_token est vide (NULL) pour ce site, créez-en un :"
    echo
    echo "    UPDATE SITE SET agent_token = 'nsm-essai-2026'"
    echo "    WHERE id_site = $ID_SITE;"
    echo
    exit 1
    ;;
esac

if [[ -z "$ID_SITE" || -z "$JETON" ]]; then
  cat <<'AIDE'

Usage :  sudo bash lancer-agent-wsl.sh <ID_SITE> <JETON> [CIDR]

  <ID_SITE>  numéro du site dans la plateforme (colonne id_site)
  <JETON>    jeton de l'agent pour ce site
  [CIDR]     plage à scanner ; facultatif ici — sans elle, l'agent
             n'applique QUE la politique web, sans scanner le réseau.
             C'est ce qu'on veut pour un simple test : le scan prend
             plusieurs minutes et n'apporte rien à cette vérification.

Où trouver le jeton :
  Interface -> Sites -> le site -> « Mettre en service l'agent »
  ou, dans MySQL Workbench :
    SELECT id_site, nom, agent_token FROM SITE;

Exemple :
  sudo bash lancer-agent-wsl.sh 1 token-douala-123

AIDE
  exit 1
fi

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ─────────────────────────────────────────────────────────────────────
etape "1/6  Où est le backend, vu depuis WSL ?"

# Dans WSL, la passerelle par défaut EST la machine Windows.
HOTE_WINDOWS=$(ip route show default 2>/dev/null | awk '{print $3}' | head -1)
if [[ -z "$HOTE_WINDOWS" ]]; then
  rouge "  Pas de passerelle par défaut : WSL n'a pas de réseau."
  exit 1
fi
echo "  Machine Windows : $HOTE_WINDOWS"
API="http://$HOTE_WINDOWS:5000/api"

# ─────────────────────────────────────────────────────────────────────
etape "2/6  Le backend répond-il ?"

CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/sites" 2>/dev/null || echo "000")

case "$CODE" in
  # 401 est le BON résultat : le serveur est joignable et demande une
  # authentification. Un 200 signifierait que /api/sites est ouvert à
  # tous, ce qui serait un défaut de sécurité.
  401|403) vert "  Backend joignable (HTTP $CODE — authentification demandée, c'est normal)." ;;
  200)     jaune "  Backend joignable, mais /api/sites répond 200 sans jeton — à vérifier." ;;
  000)
    rouge "  Backend injoignable sur $API"
    echo
    echo "  Deux causes possibles, dans l'ordre de fréquence :"
    echo
    echo "  1. Le backend ne tourne pas. Côté Windows :"
    echo "       cd C:\\Users\\LENOVO\\Documents\\NetSecureManager\\backend"
    echo "       npm start"
    echo
    echo "  2. Le pare-feu Windows bloque WSL. Dans PowerShell ADMINISTRATEUR :"
    echo
    echo '       New-NetFirewallRule -DisplayName "NetSecureManager depuis WSL" `'
    echo '         -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow'
    echo
    exit 1
    ;;
  *) jaune "  Réponse inattendue (HTTP $CODE) — on continue quand même." ;;
esac

# ─────────────────────────────────────────────────────────────────────
etape "3/6  Le jeton est-il valide pour ce site ?"

REPONSE=$(curl -s --max-time 10 -X POST "$API/agent/ping" \
  -H "Authorization: Bearer $JETON" \
  -H 'Content-Type: application/json' \
  -d "{\"id_site\":$ID_SITE}" 2>/dev/null)

if echo "$REPONSE" | grep -q '"ok":true'; then
  vert "  Jeton accepté."
else
  rouge "  Jeton refusé pour le site $ID_SITE."
  echo "  Réponse du serveur : $REPONSE"
  echo
  echo "  Récupérez le bon jeton dans MySQL Workbench :"
  echo "    SELECT id_site, nom, agent_token FROM SITE;"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
etape "4/6  Node.js est-il disponible dans WSL ?"

# Le Node.js installé sous Windows n'est PAS visible depuis Linux : ce
# sont deux systèmes distincts qui partagent seulement des fichiers.
# D'où « node: command not found » alors que Node tourne très bien côté
# Windows.
if ! command -v node >/dev/null 2>&1; then
  # Ubuntu installe parfois le binaire sous le nom « nodejs ».
  if command -v nodejs >/dev/null 2>&1; then
    ln -sf "$(command -v nodejs)" /usr/local/bin/node
    vert "  Lien créé : node -> nodejs"
  else
    jaune "  Node.js absent de WSL. Installation en cours (1 à 3 minutes)..."
    apt-get update -qq 2>/dev/null
    if ! apt-get install -y nodejs npm >/dev/null 2>&1; then
      rouge "  Installation échouée."
      echo "  Lancez à la main :  sudo apt install nodejs npm -y"
      exit 1
    fi
    if ! command -v node >/dev/null 2>&1 && command -v nodejs >/dev/null 2>&1; then
      ln -sf "$(command -v nodejs)" /usr/local/bin/node
    fi
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  rouge "  node reste introuvable après installation."
  exit 1
fi
vert "  Node.js $(node -v)"

# ─────────────────────────────────────────────────────────────────────
etape "5/6  Copie locale de l'agent"

# POURQUOI COPIER PLUTÔT QUE LANCER DEPUIS /mnt/c :
#
#   1. Les node_modules du dossier Windows contiennent des programmes
#      compilés POUR WINDOWS. Linux ne peut pas les charger.
#   2. Lancer un `npm install` dans le dossier Windows les remplacerait
#      par des versions Linux — et casserait le backend côté Windows.
#      C'est le vrai danger, et il est silencieux jusqu'au prochain
#      `npm start`.
#   3. /mnt/c est un montage lent : npm install y prend plusieurs
#      minutes contre quelques dizaines de secondes en local.
#
# On travaille donc sur une copie, dans le système de fichiers Linux.
DEST=/opt/nsm-agent
mkdir -p "$DEST"
cp -r "$RACINE/src" "$DEST/" 2>/dev/null
cp "$RACINE/package.json" "$DEST/" 2>/dev/null
[[ -d "$RACINE/data" ]] && cp -r "$RACINE/data" "$DEST/" 2>/dev/null

echo "  Copié dans $DEST"

if [[ ! -d "$DEST/node_modules" ]]; then
  echo "  Installation des dépendances (1 à 2 minutes)..."
  if ! (cd "$DEST" && npm install --omit=dev --silent --no-audit --no-fund 2>&1 | tail -3); then
    rouge "  npm install a échoué."
    echo "  Relancez à la main :  cd $DEST && npm install --omit=dev"
    exit 1
  fi
fi
vert "  Dépendances prêtes."

# ─────────────────────────────────────────────────────────────────────
etape "6/6  Lancement de l'agent"

# Sans CIDR, on donne une plage d'une seule adresse : le balayage se
# termine instantanément et l'agent enchaîne sur la politique web, qui
# est la seule chose qu'on veut tester ici.
MODE_POLITIQUE_SEULE=0
if [[ -z "$CIDR" ]]; then
  CIDR="127.0.0.1/32"
  MODE_POLITIQUE_SEULE=1
  jaune "  Aucune plage fournie : mode « politique seule »."
  echo "  Ni scan, ni transmission de relevés — uniquement le blocage web."
  echo
  echo "  Ce n'est pas qu'une économie de temps. Sur le site CENTRAL, une"
  echo "  transmission renseigne SITE.dernier_push, et c'est ce champ qui"
  echo "  dit au serveur « un agent s'occupe de ce site, arrête de le"
  echo "  superviser toi-même ». Le test couperait la supervision du site"
  echo "  sans aucun message, et l'interface aurait l'air normale."
fi

ENV_AGENT=/tmp/agent-wsl.env
cat > "$ENV_AGENT" <<EOF
CENTRAL_API_URL=$API
AGENT_TOKEN=$JETON
ID_SITE=$ID_SITE
CIDR=$CIDR
SCAN_INTERVAL_MINUTES=5
INVENTAIRE_TOUS_LES_N_CYCLES=0
POLITIQUE_SEULE=$MODE_POLITIQUE_SEULE
EOF
# Le jeton vaut un mot de passe : lisible par root seulement.
chmod 600 "$ENV_AGENT"

echo
echo "  ── Journal de l'agent (Ctrl+C pour arrêter) ──"
echo
echo "  À surveiller : la ligne « Politique web vN appliquée »."
echo "  Si vous lisez « NON appliquée », le message dit pourquoi."
echo

cd "$DEST"
ENV_FILE="$ENV_AGENT" node src/agent/agent.js

# ─────────────────────────────────────────────────────────────────────
# Après Ctrl+C : on ne laisse pas le jeton traîner dans /tmp.
rm -f "$ENV_AGENT"
echo
echo "Agent arrêté. Pour vérifier ce qui a été appliqué :"
echo "  cat /etc/dnsmasq.d/netsecuremanager.conf | head -20"
echo "  grep -c '^address=' /etc/dnsmasq.d/netsecuremanager.conf"
