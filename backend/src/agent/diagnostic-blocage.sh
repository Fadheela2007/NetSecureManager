#!/usr/bin/env bash
#
# diagnostic-blocage.sh — dit lequel des maillons du blocage est cassé.
#
#   sudo bash diagnostic-blocage.sh [domaine-a-tester]
#
# Sans argument, teste doubleclick.net.
#
# ─────────────────────────────────────────────────────────────────────
# À QUOI ÇA SERT
#
# Quand un domaine n'est pas bloqué, il y a quatre explications
# possibles, et elles produisent le MÊME symptôme :
#
#   1. dnsmasq ne tourne pas
#   2. il ne lit pas le fichier de politique
#   3. le fichier existe mais ce domaine précis n'y est pas
#   4. tout est bon côté Linux, et c'est le poste Windows qui interroge
#      un autre résolveur
#
# Chercher au hasard entre ces quatre-là coûte une heure. Ce script les
# départage en dix secondes.
# ─────────────────────────────────────────────────────────────────────

set -uo pipefail

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
jaune() { printf '\033[33m%s\033[0m\n' "$1"; }
titre() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DOMAINE="${1:-doubleclick.net}"
CONF=/etc/dnsmasq.d/netsecuremanager.conf
CONF_WSL=/etc/dnsmasq.d/00-wsl.conf

IP=$(ip -4 addr show "$(ip -4 route show default | awk '{print $5}' | head -1)" 2>/dev/null \
      | grep -oP 'inet \K[\d.]+' | head -1)

echo
echo "══════════════════════════════════════════════════════"
echo "  DIAGNOSTIC DU BLOCAGE — $DOMAINE"
echo "  Résolveur : ${IP:-inconnu}"
echo "══════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────────
titre "1. dnsmasq tourne-t-il ?"

if systemctl is-active --quiet dnsmasq 2>/dev/null; then
  vert "  Oui, actif."
else
  rouge "  NON. C'est la cause."
  echo "  Relancez :  sudo bash preparer-wsl.sh"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
titre "2. Les fichiers de configuration"

# CE QU'ON COMPTE ICI, ET POURQUOI CE N'EST PAS LE NOMBRE DE DOMAINES.
#
# Chaque domaine bloqué produit DEUX lignes « address= » : une qui répond
# à la question IPv4, une qui répond à la question IPv6. Un blocage qui
# n'en poserait qu'une se contournerait tout seul, les navigateurs
# préférant l'IPv6 quand elle existe.
#
# Le script annonçait donc « 87402 blocage(s) » là où l'agent venait de
# dire « 43701 règles » : le double, exactement. Deux écrans, deux
# chiffres, aucun moyen de savoir lequel croire. On affiche maintenant
# les deux nombres et ce qui les relie.
for f in "$CONF_WSL" "$CONF"; do
  if [[ -f "$f" ]]; then
    N=$(grep -c '^address=' "$f" 2>/dev/null || echo 0)
    N4=$(grep -c '^address=/.*/[0-9]' "$f" 2>/dev/null || echo 0)
    printf "  %-45s %s ligne(s) · %s domaine(s)\n" "$(basename "$f")" "$N" "$N4"
  else
    jaune "  $(basename "$f") — ABSENT"
  fi
done

if [[ ! -f "$CONF" ]]; then
  rouge "  La politique n'a jamais été livrée par l'agent."
  echo "  Relancez :  sudo bash lancer-agent-wsl.sh <site> <jeton>"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────
titre "3. Ce domaine figure-t-il dans la liste ?"

# On cherche le domaine ET tous ses parents : « ad.doubleclick.net » est
# couvert si « doubleclick.net » est bloqué, mais PAS l'inverse. C'est la
# confusion la plus fréquente avec les listes publiques, qui bloquent
# souvent les sous-domaines publicitaires sans bloquer le domaine racine.
TROUVE=0
CANDIDAT="$DOMAINE"
while [[ "$CANDIDAT" == *.*.* || "$CANDIDAT" == *.* ]]; do
  if grep -q "^address=/${CANDIDAT}/" "$CONF" "$CONF_WSL" 2>/dev/null; then
    vert "  Trouvé : address=/${CANDIDAT}/"
    [[ "$CANDIDAT" != "$DOMAINE" ]] && echo "    (couvre $DOMAINE en tant que sous-domaine)"
    TROUVE=1
    break
  fi
  SUIVANT="${CANDIDAT#*.}"
  [[ "$SUIVANT" == "$CANDIDAT" ]] && break
  CANDIDAT="$SUIVANT"
done

if [[ $TROUVE -eq 0 ]]; then
  rouge "  NON — ce domaine n'est pas dans la liste."
  echo
  echo "  Ce n'est PAS une panne : la liste ne contient tout simplement"
  echo "  pas ce domaine. Les listes publiques bloquent souvent les"
  echo "  sous-domaines publicitaires sans bloquer la racine."
  echo
  echo "  Voici ce qui est réellement bloqué autour :"
  grep "^address=.*$(echo "$DOMAINE" | cut -d. -f1)" "$CONF" 2>/dev/null | head -5 | sed 's/^/    /'
  echo
  echo "  Testez plutôt un domaine réellement présent :"
  grep -m3 '^address=' "$CONF" | sed 's|^address=/||; s|/.*||' | sed 's/^/    /'
fi

# ─────────────────────────────────────────────────────────────────────
titre "4. Que répond réellement dnsmasq ?"

# On interroge dnsmasq directement, en IPv4 ET en IPv6. Le second point
# compte autant que le premier : si le domaine est bloqué en A mais
# répond en AAAA, un navigateur moderne prendra l'IPv6 et le blocage sera
# sans effet — sans que rien ne le signale.
if command -v node >/dev/null 2>&1; then
  node - "$IP" "$DOMAINE" <<'JS'
const dns = require("dns");
const [ip, domaine] = process.argv.slice(2);
const r = new dns.Resolver({ timeout: 3000, tries: 1 });
r.setServers([ip]);

const interroger = (type) =>
  new Promise((res) => {
    r.resolve(domaine, type, (err, adr) => res({ type, err: err && err.code, adr }));
  });

(async () => {
  for (const type of ["A", "AAAA"]) {
    const { err, adr } = await interroger(type);
    if (err === "ENODATA" || err === "ENOTFOUND") {
      console.log(`  ${type.padEnd(5)} aucune réponse  -> BLOQUÉ`);
    } else if (err) {
      console.log(`  ${type.padEnd(5)} erreur ${err}`);
    } else if (adr.some((a) => a === "0.0.0.0" || a === "::" || a === ip)) {
      console.log(`  ${type.padEnd(5)} ${adr.join(", ")}  -> BLOQUÉ`);
    } else {
      console.log(`  ${type.padEnd(5)} ${adr.join(", ")}  -> NON BLOQUÉ`);
    }
  }
})();
JS
else
  jaune "  node absent : test impossible depuis Linux."
  echo "  Testez depuis PowerShell :  nslookup $DOMAINE $IP"
fi

# ─────────────────────────────────────────────────────────────────────
titre "5. Le témoin de contrôle"

# Ce domaine est posé par preparer-wsl.sh et ne dépend NI de l'agent NI
# de la politique. S'il est bloqué, dnsmasq lit bien ses fichiers : tout
# écart sur un autre domaine vient donc de la liste, pas de la plomberie.
if command -v node >/dev/null 2>&1; then
  node - "$IP" <<'JS'
const dns = require("dns");
const [ip] = process.argv.slice(2);
const r = new dns.Resolver({ timeout: 3000, tries: 1 });
r.setServers([ip]);
r.resolve4("exemple-bloque-nsm.com", (err, adr) => {
  if (!err && adr && (adr.includes("0.0.0.0") || adr.includes(ip))) {
    console.log("  \x1b[32mBloqué — dnsmasq lit bien ses fichiers.\x1b[0m");
  } else if (err === null) {
    console.log(`  \x1b[31mRépond ${adr} — anormal.\x1b[0m`);
  } else {
    console.log(`  \x1b[31mNon bloqué (${err.code}) — dnsmasq ne lit pas /etc/dnsmasq.d/\x1b[0m`);
  }
});
JS
fi

echo
echo "══════════════════════════════════════════════════════"
echo "  Étape 4 « NON BLOQUÉ » + étape 3 « pas dans la liste »"
echo "  = tout fonctionne, le domaine n'est simplement pas listé."
echo
echo "  Étape 4 « NON BLOQUÉ » + étape 3 « trouvé »"
echo "  = dnsmasq n'a pas rechargé. Relancez l'agent."
echo "══════════════════════════════════════════════════════"
echo
