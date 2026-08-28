# Blocage web — où vous en êtes

Une page. À relire quand vous êtes perdue.

---

## 1. Ce qu'on essaie de faire

Quand vous tapez `facebook.com`, votre ordinateur **ne sait pas où c'est**.
Il pose la question à un annuaire — le **serveur DNS** :

> « facebook.com, c'est quelle adresse ? »
> « 157.240.1.35 »

Puis il s'y connecte. Aujourd'hui, cet annuaire est celui de votre box.

**Bloquer un site, c'est mentir dans l'annuaire.** On met notre propre
annuaire, et quand quelqu'un demande un site interdit, il répond une
adresse qui ne mène nulle part. Le site ne s'ouvre pas.

C'est tout. Le reste n'est que de la plomberie pour arriver là.

---

## 2. Les quatre pièces

```
   VOTRE PC              WSL (le Linux dans Windows)         WINDOWS
   ────────              ───────────────────────────         ───────

   ┌────────┐            ┌──────────┐    ┌──────────┐    ┌─────────────┐
   │ Chrome │──── ? ────▶│ dnsmasq  │◀───│  agent   │◀───│ plateforme  │
   └────────┘            │(annuaire)│    │(livreur) │    │ (la liste)  │
       D                 └──────────┘    └──────────┘    └─────────────┘
                              C               B                 A
```

| | Pièce | Son rôle | Où elle tourne |
|---|---|---|---|
| **A** | La plateforme | détient la liste des 95 664 domaines interdits | Windows |
| **B** | L'agent | va chercher la liste et la donne à dnsmasq | WSL |
| **C** | dnsmasq | l'annuaire qui répond aux questions | WSL |
| **D** | Votre PC | doit poser ses questions à dnsmasq | Windows |

**Il en faut quatre sur quatre.** C'est pour ça que ça paraît long : chacune
prise seule ne fait rien de visible.

---

## 3. Où vous en êtes exactement

| | Pièce | État |
|---|---|---|
| A | La plateforme a la liste | ✅ **fait** — 95 664 domaines, politique active |
| B | L'agent la livre à dnsmasq | ❌ **il manque ça** |
| C | dnsmasq tourne | ✅ **fait** — il répond sur `172.24.145.179` |
| D | Votre PC l'interroge | ⏸ à faire après B |

**Il ne manque que la pièce B.** dnsmasq tourne bien, mais sa liste de
domaines interdits est vide — personne ne la lui a encore apportée.

C'est exactement ce que dit votre écran : *« Version 2 enregistrée,
l'agent applique encore la — »*. Le tiret veut dire : l'agent n'a jamais
rien livré.

**Pourquoi il n'a rien livré :** il s'est arrêté sur `node: command not
found`. Node.js était installé côté Windows, pas dans WSL. C'est réparé.

---

## 4. La seule commande à lancer

Dans la fenêtre **Ubuntu** (celle dont l'invite finit par `$`) :

```bash
sudo bash /mnt/c/Users/LENOVO/Documents/NetSecureManager/backend/src/agent/lancer-agent-wsl.sh 1 votre-jeton
```

*(remplacez `votre-jeton` par la valeur trouvée avec
`SELECT id_site, nom, agent_token FROM SITE;`)*

La première fois, comptez **2 à 3 minutes** : il installe Node.js dans
WSL et les dépendances.

### Ce que vous devez voir

```
[Agent site 1] Cycle 1 — politique web uniquement.
[Agent site 1] Politique web v2 appliquée — 95664 domaine(s) bloqué(s).
```

**Cette ligne, c'est la pièce B.** Quand elle apparaît, arrêtez avec
**Ctrl + C**.

### Si vous voyez autre chose

| Message | Ce que ça veut dire |
|---|---|
| `Politique web NON appliquée : ...` | la suite du message dit pourquoi |
| `Jeton refusé` | mauvais jeton — revoyez la requête SQL |
| `Backend injoignable` | `npm start` n'est pas lancé côté Windows |

---

## 5. Vérifier que la pièce B est passée

Dans **PowerShell** (invite `PS C:\>`) :

```powershell
nslookup doubleclick.net 172.24.145.179
```

**Réussite** = `0.0.0.0` **ou** `172.24.145.179`.
*(Les deux sont bons. La plateforme utilise la seconde quand elle la
connaît, pour pouvoir un jour y afficher une page d'explication.)*

**Échec** = une adresse de Google (`142.250...`). La liste n'est pas
arrivée jusqu'à dnsmasq.

---

## 6. Ensuite seulement, la pièce D

Une fois le test ci-dessus réussi, on fait interroger votre PC :

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses 172.24.145.179
```

Et pour tout remettre comme avant, à n'importe quel moment :

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ResetServerAddresses
```

**Gardez cette deuxième commande sous la main.** C'est votre marche
arrière : elle vous rend internet en une seconde si quelque chose vous
inquiète.

---

## 7. Deux choses qui vous ont fait perdre du temps

Elles n'étaient pas de votre fait, autant les nommer.

**L'adresse de WSL change** à chaque redémarrage de Windows. Si demain
`172.24.145.179` ne répond plus, relisez-la dans Ubuntu avec
`hostname -I`, et relancez `preparer-wsl.sh`.

**Deux fenêtres, deux mondes.** Ubuntu et PowerShell ne partagent que des
fichiers. Une commande Linux dans PowerShell ne marche pas, et
inversement. Le repère :

| Fenêtre | L'invite ressemble à | Pour |
|---|---|---|
| **Ubuntu** | `lenovo@Fadheela:~$` | `sudo`, `apt`, `hostname` |
| **PowerShell** | `PS C:\>` | `nslookup`, `Set-DnsClient...`, `npm` |
