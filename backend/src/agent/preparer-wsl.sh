#!/usr/bin/env bash
#
# preparer-wsl.sh — rend dnsmasq utilisable dans WSL.
#
# À lancer APRÈS `sudo apt install dnsmasq`, en root :
#   sudo bash preparer-wsl.sh
#
# ─────────────────────────────────────────────────────────────────────
# POURQUOI CE SCRIPT EXISTE
#
# `apt install dnsmasq` réussit dans WSL, mais laisse le service à
# l'arrêt. Une seule ligne le signale, noyée dans cent autres :
#
#   Could not execute systemctl:  at /usr/bin/deb-systemd-invoke line 148
#
# Trois obstacles s'enchaînent, et aucun ne se voit :
#
#   1. WSL démarre sans systemd. Le service n'a jamais été lancé, et
#      l'agent — qui pilote dnsmasq par `systemctl` — ne pourra rien
#      faire.
#
#   2. systemd-resolved, une fois systemd actif, occupe le port 53 sur
#      127.0.0.53. dnsmasq qui tente d'écouter partout entre en conflit
#      et refuse de démarrer.
#
#   3. WSL réécrit /etc/resolv.conf à chaque démarrage. Toute
#      configuration DNS posée à la main disparaît sans prévenir.
#
# Le symptôme final de ces trois causes est le même — « le port 53 ne
# répond pas » — ce qui ne dit rien sur laquelle a échoué. D'où ce
# script : il les traite dans l'ordre et dit précisément où ça bloque.
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
jaune() { printf '\033[33m%s\033[0m\n' "$1"; }
etape() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
  rouge "Ce script doit être lancé avec sudo."
  echo "  sudo bash $0"
  exit 1
fi

if ! grep -qi microsoft /proc/version 2>/dev/null; then
  jaune "Ce système ne semble pas être WSL."
  echo "  Sur un Linux normal (VM, Raspberry Pi), dnsmasq fonctionne"
  echo "  directement après l'installation. Ce script ne sert à rien."
  echo
  read -rp "  Continuer quand même ? [o/N] " reponse
  [[ "$reponse" =~ ^[oO]$ ]] || exit 0
fi

# ─────────────────────────────────────────────────────────────────────
etape "1/4  dnsmasq est-il installé ?"

if ! command -v dnsmasq >/dev/null 2>&1; then
  rouge "dnsmasq est absent."
  echo "  Lancez d'abord :  sudo apt update && sudo apt install dnsmasq -y"
  exit 1
fi
vert "  $(dnsmasq --version | head -1)"

# ─────────────────────────────────────────────────────────────────────
etape "2/4  systemd est-il actif ?"

# `/run/systemd/system` n'existe que si systemd est le gestionnaire de
# services en cours. C'est le test fiable, plus que la présence du
# binaire — présent même quand il ne tourne pas.
if [[ -d /run/systemd/system ]]; then
  vert "  systemd est actif."
else
  jaune "  systemd n'est pas actif — c'est le comportement par défaut de WSL."

  if grep -qs '^\s*systemd\s*=\s*true' /etc/wsl.conf; then
    echo "  /etc/wsl.conf demande déjà systemd : il manque juste le redémarrage."
  else
    # On complète /etc/wsl.conf sans l'écraser : il peut déjà contenir
    # des réglages de montage ou de réseau que l'utilisateur a posés.
    if [[ -f /etc/wsl.conf ]] && grep -q '^\[boot\]' /etc/wsl.conf; then
      sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
    else
      printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
    fi
    vert "  /etc/wsl.conf mis à jour."
  fi

  echo
  rouge "  ══ IL FAUT REDÉMARRER WSL ══"
  echo
  echo "  1. Ouvrez une fenêtre PowerShell (côté Windows)"
  echo "  2. Tapez :  wsl --shutdown"
  echo "  3. Fermez TOUTES les fenêtres Ubuntu"
  echo "  4. Attendez dix secondes — l'arrêt n'est pas instantané"
  echo "  5. Rouvrez Ubuntu et relancez ce script"
  echo
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────
etape "3/4  Configuration de dnsmasq"

# L'interface réseau de WSL s'appelle presque toujours eth0, mais on la
# détecte plutôt que de le supposer : une supposition fausse ici donne
# un dnsmasq qui refuse de démarrer, sans message clair.
INTERFACE=$(ip -4 route show default 2>/dev/null | awk '{print $5}' | head -1)
[[ -z "$INTERFACE" ]] && INTERFACE=eth0

IP=$(ip -4 addr show "$INTERFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
if [[ -z "$IP" ]]; then
  rouge "  Aucune adresse IPv4 sur $INTERFACE."
  echo "  WSL n'a peut-être pas de réseau. Essayez : wsl --shutdown puis rouvrez."
  exit 1
fi
echo "  Interface : $INTERFACE"
echo "  Adresse   : $IP"

# Toutes les adresses de la machine, pour le diagnostic. WSL en pose
# plusieurs, dont 10.255.255.254 qui est justement celle qui bloque.
echo
echo "  Adresses présentes sur cette machine :"
ip -4 -o addr show 2>/dev/null | awk '{print "    " $2 "  " $4}'

# ── Le conflit de port 53 ──
#
# Deux occupants possibles, et il faut savoir lequel avant de choisir la
# parade. On regarde plutôt que de supposer.
echo
echo "  Qui occupe déjà le port 53 ?"
OCCUPANTS=$(ss -ulnp 2>/dev/null | awk '$5 ~ /:53$/ {print "    " $5 "  " $7}')
if [[ -n "$OCCUPANTS" ]]; then
  echo "$OCCUPANTS"
else
  echo "    (personne pour l'instant)"
fi

mkdir -p /etc/dnsmasq.d
cat > /etc/dnsmasq.d/00-wsl.conf <<EOF
# Fichier généré par preparer-wsl.sh — réglages propres à WSL.
# La politique de blocage, elle, arrive dans netsecuremanager.conf,
# écrit par l'agent. Ne pas mélanger les deux.

# ── ÉCOUTE SUR UNE SEULE ADRESSE ──
#
# Le port 53 est déjà pris dans WSL, à deux endroits :
#   • 10.255.255.254 — le relais DNS interne de WSL, sur la boucle locale
#   • 127.0.0.53     — systemd-resolved, quand systemd est actif
#
# « interface=$INTERFACE » ne suffisait PAS : dnsmasq attache aussi la
# boucle locale par défaut, pour répondre aux requêtes locales. Il y
# trouvait 10.255.255.254 déjà occupé et refusait de démarrer avec
# « Address already in use » — sans dire quelle adresse posait problème
# autrement que par le journal.
#
# On lui désigne donc UNE adresse précise et on lui interdit la boucle
# locale. Conséquence assumée : le Linux lui-même ne peut pas interroger
# dnsmasq sur 127.0.0.1. Sans importance ici — c'est Windows qui
# l'interroge, sur l'adresse ci-dessous.
#
# On ne touche NI à systemd-resolved NI au relais de WSL : les arrêter
# couperait la résolution DNS du Linux, donc apt, git et npm.
listen-address=$IP
bind-interfaces
except-interface=lo

# Ne pas lire /etc/resolv.conf : WSL le réécrit à chaque démarrage, et
# il pointe vers le résolveur de Windows — ce qui créerait une boucle
# une fois Windows configuré pour interroger dnsmasq.
no-resolv
server=9.9.9.9
server=1.1.1.1

# Ne pas transmettre aux résolveurs publics les noms sans domaine ni les
# adresses privées inversées : c'est une fuite d'information sur le
# réseau interne.
domain-needed
bogus-priv

# ── DOMAINE TÉMOIN ──
# Ce domaine n'existe pas et ne sert qu'au diagnostic. Il permet de
# tester la chaîne « poste Windows -> dnsmasq » SANS dépendre de l'agent
# ni de la politique.
#
# Sans lui, on testerait directement un domaine de la liste publicité —
# et un échec pourrait venir de trois endroits (dnsmasq arrêté, poste mal
# configuré, ou politique jamais reçue) sans qu'on sache lequel. Le
# témoin ne dépend que de dnsmasq : s'il répond 0.0.0.0, les deux
# premiers maillons sont bons, et le problème est forcément l'agent.
address=/exemple-bloque-nsm.com/0.0.0.0
EOF
vert "  /etc/dnsmasq.d/00-wsl.conf écrit."

if ! dnsmasq --test 2>&1 | grep -q "syntax check OK"; then
  rouge "  Configuration refusée par dnsmasq :"
  dnsmasq --test 2>&1 | sed 's/^/    /'
  exit 1
fi
vert "  Syntaxe validée."

# ─────────────────────────────────────────────────────────────────────
etape "4/4  Démarrage du service"

systemctl enable dnsmasq >/dev/null 2>&1
if ! systemctl restart dnsmasq 2>/dev/null; then
  rouge "  Le service refuse de démarrer."
  echo
  echo "  Les dix dernières lignes du journal :"
  journalctl -u dnsmasq -n 10 --no-pager | sed 's/^/    /'

  # Le message « Address already in use » est le seul cas fréquent, et il
  # a une cause précise qu'on peut nommer. Le laisser brut obligerait à
  # chercher pendant une heure ce qui se règle en une ligne.
  if journalctl -u dnsmasq -n 20 --no-pager 2>/dev/null | grep -q "Address already in use"; then
    echo
    jaune "  ── Diagnostic ──"
    echo "  Une autre application occupe déjà le port 53 sur l'adresse"
    echo "  que dnsmasq tente d'utiliser. Voici qui écoute actuellement :"
    echo
    ss -ulnp 2>/dev/null | awk 'NR==1 || $5 ~ /:53$/' | sed 's/^/    /'
    echo
    echo "  Si vous voyez « systemd-resolved » sur 127.0.0.53, ou le relais"
    echo "  de WSL sur 10.255.255.254 : c'est normal, ils doivent rester."
    echo "  Le problème vient de la configuration de dnsmasq, envoyez-moi"
    echo "  le contenu de /etc/dnsmasq.d/00-wsl.conf et ces lignes."
  fi
  exit 1
fi

sleep 1
if ! systemctl is-active --quiet dnsmasq; then
  rouge "  Le service s'est arrêté juste après le démarrage. Journal :"
  journalctl -u dnsmasq -n 20 --no-pager | sed 's/^/    /'
  exit 1
fi
vert "  dnsmasq est actif."

# ── Vérification réelle ──
#
# « Le service est actif » ne prouve pas qu'il répond. On lui pose une
# vraie question, sur la vraie adresse. C'est la seule preuve qui
# compte, et elle évite de chercher côté Windows un problème qui est ici.
etape "Vérification"

TEST_OK=0
if command -v dig >/dev/null 2>&1; then
  dig +short +timeout=3 @"$IP" example.com >/dev/null 2>&1 && TEST_OK=1
elif command -v nslookup >/dev/null 2>&1; then
  nslookup example.com "$IP" >/dev/null 2>&1 && TEST_OK=1
else
  # Ni dig ni nslookup : on se contente de vérifier que le port écoute.
  ss -ulnp 2>/dev/null | grep -q ":53 " && TEST_OK=1
fi

echo
if [[ $TEST_OK -eq 1 ]]; then
  vert "══════════════════════════════════════════════════════"
  vert "  dnsmasq répond sur $IP"
  vert "══════════════════════════════════════════════════════"
  echo
  echo "  Testez depuis PowerShell, côté Windows :"
  echo
  echo "    nslookup exemple-bloque-nsm.com $IP"
  echo
  echo "  Attendu : Address: 0.0.0.0  (c'est le domaine témoin)"
  echo
  echo "  Si vous obtenez 0.0.0.0, la chaîne Windows -> dnsmasq est"
  echo "  bonne. Les vrais domaines seront bloqués quand l'agent aura"
  echo "  transmis la politique."
  echo
  jaune "  ⚠ Cette adresse CHANGE à chaque redémarrage de Windows."
  echo "    Relancez ce script après chaque redémarrage pour la relire,"
  echo "    ou lisez-la avec :  hostname -I"
else
  rouge "  Le service tourne mais ne répond pas sur $IP."
  echo "  Journal :"
  journalctl -u dnsmasq -n 20 --no-pager | sed 's/^/    /'
  exit 1
fi
echo
