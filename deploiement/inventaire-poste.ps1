#Requires -Version 5.1
<#
 =====================================================================
  inventaire-poste.ps1
  L'inventaire d'un poste, sans rien installer dessus.

  A DEPLOYER PAR STRATEGIE DE GROUPE (GPO). Une regle ecrite une fois
  couvre tout le parc : le script vit sur le partage NETLOGON du
  domaine, chaque poste l'execute en tache planifiee. Aucune
  installation, aucun logiciel a maintenir sur 559 machines.

 ---------------------------------------------------------------------
  POURQUOI CE SCRIPT REMPLACE L'AGENT NODE

  L'agent Node fait le meme travail, mais il exige Node.js sur chaque
  poste. C'est CA, le vrai cout : pas le programme, sa dependance.

  PowerShell est deja present sur tout Windows depuis 2009. Ce script
  n'installe rien, ne telecharge rien, ne laisse rien derriere lui a
  part son journal. Il se lit en entier, ce qui compte quand on demande
  a un service informatique l'autorisation de le passer sur son parc.

  L'agent Node reste utile pour les serveurs Linux et les machines hors
  domaine. Les deux envoient exactement le meme message.

 ---------------------------------------------------------------------
  CE QU'IL COLLECTE

    - les logiciels installes (registre, les DEUX ruches) ;
    - les programmes en cours, regroupes par nom ;
    - le nom de la machine, son systeme, son adresse ;
    - ses interfaces reseau, leur passerelle et leur type de media ;
    - sa table de voisinage : quelles adresses il a reellement jointes ;
    - le BSSID de la borne Wi-Fi a laquelle il est associe, s'il l'est.

  Ces trois dernieres lignes servent a DESSINER LA CARTE DU RESEAU
  sans que personne ne la dessine a la main. Elles ne disent rien de
  l'utilisateur : ce sont des adresses d'equipements, pas des
  usages.

  CE QU'IL NE COLLECTE PAS, ET C'EST DELIBERE

    - le nom de l'utilisateur ;
    - les lignes de commande, qui contiennent regulierement des mots de
      passe et des chemins personnels ;
    - aucun fichier, aucun document, aucune frappe clavier.

  Il ne fait qu'ENVOYER. Il n'ouvre aucun port, n'attend aucune
  connexion, et ne peut recevoir aucun ordre de la plateforme.

 ---------------------------------------------------------------------
  UTILISATION

    Essai sur un poste, sans rien envoyer :
        .\inventaire-poste.ps1 -Test

    Envoi reel :
        .\inventaire-poste.ps1

  Les trois valeurs ci-dessous sont a renseigner UNE FOIS, dans la
  copie posee sur le partage. Les modifier la met a jour tout le parc.
 =====================================================================
#>

param(
    # Affiche ce qui serait envoye, sans rien envoyer. A utiliser sur un
    # poste avant de deployer sur le parc : on ne pousse pas par GPO un
    # script qu'on n'a pas vu tourner une fois.
    [switch]$Test,

    # Surchargent les valeurs ci-dessous, pour essayer sans modifier le
    # fichier du partage.
    [string]$Url,
    [string]$Jeton,
    [int]$Site
)

# ── A RENSEIGNER ────────────────────────────────────────────────────
$CENTRAL_API_URL = "http://192.168.0.10:5000/api"
$AGENT_TOKEN     = ""
$ID_SITE         = 1
# ─────────────────────────────────────────────────────────────────────

if ($Url)   { $CENTRAL_API_URL = $Url }
if ($Jeton) { $AGENT_TOKEN = $Jeton }
if ($Site)  { $ID_SITE = $Site }

$VERSION = "1.1.0-ps"

# Le journal vit dans ProgramData : lisible par l'administrateur, ecrit
# par SYSTEM, et il survit au changement d'utilisateur. Sans journal, un
# script pousse par GPO qui echoue le fait en silence sur 559 postes.
#
# ── AVEC UN REPLI DANS LE DOSSIER DE L'UTILISATEUR ──
#
# Ce script ne demande AUCUN droit d'administration : lire le registre
# des logiciels installes et lister les processus, un utilisateur
# ordinaire le fait. C'est ce qui permet de le poser en SCRIPT
# D'OUVERTURE DE SESSION plutot qu'en tache planifiee — la demande la
# plus facile a obtenir d'un service informatique, parce qu'elle ne
# donne aucun privilege a personne.
#
# Mais un utilisateur ordinaire n'ecrit pas toujours dans ProgramData :
# selon la strategie du domaine, le dossier peut lui etre ferme. Le
# journal basculait alors dans le vide silencieusement — et un script
# qui echoue sans journal sur 559 postes est exactement ce qu'on
# cherchait a eviter en ecrivant un journal.
#
# On verifie donc qu'on peut vraiment ecrire, et sinon on retombe sur le
# dossier personnel, ou tout utilisateur ecrit par construction.
function Trouver-DossierJournal {
    foreach ($base in @($env:ProgramData, $env:LOCALAPPDATA, $env:TEMP)) {
        if (-not $base) { continue }
        $candidat = Join-Path $base "NetSecureManager"
        try {
            if (-not (Test-Path $candidat)) {
                New-Item -ItemType Directory -Path $candidat -Force -ErrorAction Stop | Out-Null
            }
            # Test d'ecriture reel : un dossier qui existe n'est pas un
            # dossier ou l'on peut ecrire.
            $temoin = Join-Path $candidat ".ecriture"
            Set-Content -Path $temoin -Value "1" -ErrorAction Stop
            Remove-Item $temoin -Force -ErrorAction SilentlyContinue
            return $candidat
        } catch {
            continue
        }
    }
    return $null
}

$dossierJournal = Trouver-DossierJournal
$journal = if ($dossierJournal) { Join-Path $dossierJournal "inventaire.log" } else { $null }

function Ecrire($message) {
    $ligne = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Write-Host $ligne
    if (-not $journal) { return }   # aucun dossier accessible : l'ecran suffit
    try {
        # Rotation simple : au-dela de 1 Mo on repart de zero. Un journal
        # qui grossit sans fin sur 559 postes finit par etre le probleme.
        if ((Test-Path $journal) -and ((Get-Item $journal).Length -gt 1MB)) {
            Remove-Item $journal -Force -ErrorAction SilentlyContinue
        }
        Add-Content -Path $journal -Value $ligne -Encoding UTF8
    } catch {
        # Un journal indisponible ne doit jamais empecher l'inventaire.
    }
}

# ══ LOGICIELS INSTALLES ═════════════════════════════════════════════
#
# LES DEUX RUCHES, ET C'EST LE PIEGE PRINCIPAL. Un logiciel 32 bits
# installe sur un Windows 64 bits n'apparait que sous WOW6432Node.
# N'interroger que la ruche principale fait manquer une bonne partie
# d'un parc bureautique — et cette moitie manquante ne se voit pas : la
# liste a l'air complete.
#
# LIMITE ASSUMEE : execute en tant que SYSTEM (le cas d'une tache GPO),
# le script ne voit pas les logiciels installes pour un utilisateur seul
# (ruche HKCU), Teams ou Zoom personnels par exemple. Les lire
# supposerait de charger la ruche de chaque profil — beaucoup de
# complexite pour une minorite de cas, et une intrusion supplementaire
# dans l'espace de chaque personne.
function Get-LogicielsInstalles {
    $chemins = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    $brut = Get-ItemProperty -Path $chemins -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and -not $_.SystemComponent }

    $liste = @()
    foreach ($l in $brut) {
        $date = $null
        # Le registre ecrit la date en « AAAAMMJJ », sans separateur. Une
        # date fausse en base serait pire qu'une case vide : elle passerait
        # tous les filtres par periode.
        if ($l.InstallDate -match '^(\d{4})(\d{2})(\d{2})$') {
            $a = [int]$Matches[1]; $m = [int]$Matches[2]; $j = [int]$Matches[3]
            if ($m -ge 1 -and $m -le 12 -and $j -ge 1 -and $j -le 31) {
                $date = "{0:d4}-{1:d2}-{2:d2}" -f $a, $m, $j
            }
        }

        $liste += [ordered]@{
            nom     = [string]$l.DisplayName
            version = if ($l.DisplayVersion) { [string]$l.DisplayVersion } else { $null }
            editeur = if ($l.Publisher) { [string]$l.Publisher } else { $null }
            date_installation = $date
        }
    }

    # Doublons : un meme logiciel est parfois inscrit dans les deux ruches.
    $liste | Group-Object { "$($_.nom)|$($_.version)" } | ForEach-Object { $_.Group[0] }
}

# ══ PROGRAMMES EN COURS ═════════════════════════════════════════════
#
# Regroupes par nom : un navigateur ouvre vingt processus, et les lister
# vingt fois ne dit rien de plus que « il tourne, en vingt exemplaires ».
function Get-ProgrammesEnCours {
    Get-Process -ErrorAction SilentlyContinue |
        Group-Object -Property ProcessName |
        ForEach-Object {
            [ordered]@{
                nom         = $_.Name
                occurrences = $_.Count
                # WorkingSet est en octets ; la plateforme attend des Ko.
                memoire_ko  = [int64](($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1024)
                utilisateur = $null
            }
        }
}

# ══ SANTE DE LA MACHINE ═════════════════════════════════════════════
#
# CE QU'UN INVENTAIRE NE DIT PAS. Savoir quels logiciels sont installes
# ne dit pas si la machine va bien. Quatre choses le disent : la memoire
# qui reste, l'espace disque qui reste, depuis quand elle n'a pas
# redemarre, et l'etat des trois services qui la protegent.
#
# AUCUN DROIT D'ADMINISTRATION N'EST NECESSAIRE. Un utilisateur ordinaire
# lit tout ceci sur SA machine. C'est ce qui permet de garder ce script
# en script d'ouverture de session, sans elevation.
#
# CHAQUE VOLET EST INDEPENDANT : un poste qui refuse la liste des
# services rend quand meme sa memoire et ses disques. Un volet manquant
# vaut $null — « je n'ai pas regarde » — et jamais zero, qui se lirait
# « 0 Go libres » et declencherait une alarme fausse.
# ---------------------------------------------------------------------
# LA CHARGE DU PROCESSEUR
#
# Win32_Processor.LoadPercentage, et NON un compteur de performance.
#
# "\Processeur(_Total)\% temps processeur" fonctionne sur un Windows
# francais et rend $null sur un Windows anglais : les noms de compteurs
# sont TRADUITS. Le meme script donnerait donc des graphiques pleins chez
# un client et vides chez le suivant, sans qu'aucune erreur ne s'affiche.
#
# LoadPercentage est un instantane, pas une moyenne sur la minute. C'est
# moins precis qu'un compteur de performance, et c'est assume : une
# mesure par minute sur une machine de bureau sert a voir une tendance et
# les pics longs, pas a facturer du temps de calcul.
# ---------------------------------------------------------------------
function Get-ChargeProcesseur {
    try {
        $charges = @(Get-CimInstance Win32_Processor -ErrorAction Stop |
                     Select-Object -ExpandProperty LoadPercentage |
                     Where-Object { $null -ne $_ })
        if ($charges.Count -eq 0) { return $null }
        return [int][math]::Round(($charges | Measure-Object -Average).Average)
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------------
# LES COMPTEURS DE LA CARTE RESEAU
#
# On envoie des COMPTEURS CUMULES, jamais un debit. Le serveur fait la
# difference entre deux envois — c'est exactement ce qu'il fait deja pour
# le SNMP, avec la meme fonction. Calculer le debit ici obligerait a
# garder un etat entre deux executions d'une tache planifiee, et a le
# refaire correctement (debordement de compteur, redemarrage) une
# deuxieme fois.
#
# SEULES LES CARTES CONNECTEES sont envoyees. Une machine porte souvent
# des cartes virtuelles (VPN, machines virtuelles, Bluetooth) a l'arret :
# leurs compteurs sont figes et n'ajouteraient que du bruit.
#
# La boucle locale, elle, est ecartee PAR LE SERVEUR, sur son nom
# ("Loopback Pseudo-Interface") — le meme filtre que pour le SNMP. Une
# seule regle, un seul endroit.
# ---------------------------------------------------------------------
function Get-Reseau {
    try {
        $stats = @(Get-NetAdapterStatistics -ErrorAction Stop)
    } catch {
        # Windows 7 / 2008 R2 : le module NetAdapter n'existe pas. On rend
        # $null — « je n'ai pas regarde » — et le serveur n'ecrit rien,
        # plutot qu'un zero qui se lirait « cette machine ne consomme
        # rien ».
        return $null
    }
    if ($stats.Count -eq 0) { return $null }

    $cartes = @{}
    try {
        foreach ($c in @(Get-NetAdapter -ErrorAction Stop)) { $cartes[$c.Name] = $c }
    } catch { }

    $sortie = New-Object System.Collections.ArrayList
    $rang = 0

    foreach ($st in $stats) {
        $rang++
        $carte = $cartes[$st.Name]

        if ($carte -and $carte.Status -ne "Up") { continue }

        # ifIndex quand Windows le donne : c'est le meme numero que celui
        # que verrait un agent SNMP sur cette machine, donc le meme
        # identifiant d'une execution a l'autre. Le rang n'est qu'un
        # repli, et il suffit : ce qui compte est la STABILITE de la cle
        # entre deux envois.
        $index = $rang
        if ($carte -and $carte.ifIndex) { $index = [int]$carte.ifIndex }

        $vitesse = $null
        if ($carte -and $carte.Speed -and $carte.Speed -gt 0) {
            $vitesse = [int][math]::Round($carte.Speed / 1000000)
        }

        [void]$sortie.Add([ordered]@{
            index        = $index
            nom          = [string]$st.Name
            in_octets    = [int64]$st.ReceivedBytes
            out_octets   = [int64]$st.SentBytes
            vitesse_mbps = $vitesse
        })
    }

    if ($sortie.Count -eq 0) { return $null }
    return @($sortie)
}

# == TOPOLOGIE : DE QUOI CETTE MACHINE EST VOISINE ===================
#
# Trois sources, et aucune n'est un dessin.
#
#   - LES INTERFACES, avec leur passerelle et leur type de media. Une
#     machine en Wi-Fi n'est pas au bout d'un cable, et une carte
#     virtuelle (VirtualBox, WSL, VPN) ne mene nulle part. Mais ce
#     n'est PAS au script de trancher : il remonte les preuves — carte
#     materielle ou non, passerelle presente ou non — et le serveur
#     classe. Un seul endroit decide, et il est verifiable.
#
#   - LA TABLE DE VOISINAGE, avec l'etat de chaque entree. `Reachable`
#     veut dire « joint a l'instant ». `Stale` veut dire « vu un jour,
#     plus verifie depuis ». Confondre les deux ferait dessiner des
#     liens morts. `Unreachable` et `Incomplete` sont ecartes ici :
#     l'entree existe parce qu'on a ESSAYE de joindre l'adresse, pas
#     parce que quelqu'un a repondu — ce n'est pas une preuve.
#
#   - LE BSSID DE LA BORNE WI-FI : l'adresse MAC de la radio a
#     laquelle ce poste est associe. C'est le seul lien PHYSIQUE qu'un
#     poste connait de lui-meme avec certitude, et aucun outil de
#     supervision classique ne va le chercher.
#
# CE QUE CELA NE DONNE PAS : le numero de port d'un switch. Il faut
# pour cela que le switch reponde en SNMP. Sans lui, on sait sur quel
# SEGMENT se trouve une machine — pas au bout de quel cable. La carte
# devra le dire, au lieu de laisser croire le contraire.
#
# `$null` partout ou la collecte a echoue, `@()` quand elle a abouti
# sans rien trouver. Le serveur distingue les deux : « je ne sais pas »
# n'est pas « il n'y en a pas ».
# ---------------------------------------------------------------------
function Get-Topologie {
    $interfaces = $null
    $voisins    = $null
    $wifi       = $null

    # -- Les interfaces, et ce qui prouve qu'elles menent quelque part --
    try {
        $cartes = @{}
        try {
            foreach ($c in @(Get-NetAdapter -ErrorAction Stop)) { $cartes[[int]$c.ifIndex] = $c }
        } catch { }

        # Les passerelles par defaut, par interface. Une interface sans
        # passerelle ne sort pas de son segment : c'est la premiere
        # preuve qu'une carte virtuelle ne mene nulle part.
        $passerelles = @{}
        try {
            foreach ($r in @(Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop)) {
                $ix = [int]$r.ifIndex
                if (-not $passerelles.ContainsKey($ix)) { $passerelles[$ix] = [string]$r.NextHop }
            }
        } catch { }

        $liste = New-Object System.Collections.ArrayList
        foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)) {
            $index = [int]$a.ifIndex
            $carte = $cartes[$index]

            # `PhysicalMediaType` est une valeur d'enumeration, pas un
            # libelle : « 802.11 » reste « 802.11 » sur un Windows
            # francais. Un nom de carte, lui, serait traduit — et une
            # regle qui depend de la langue du poste casse en clientele.
            $media = $null
            if ($carte -and $carte.PhysicalMediaType) { $media = [string]$carte.PhysicalMediaType }

            [void]$liste.Add([ordered]@{
                index       = $index
                nom         = if ($carte) { [string]$carte.Name } else { $null }
                adresse_ip  = [string]$a.IPAddress
                masque      = [int]$a.PrefixLength
                passerelle  = if ($passerelles.ContainsKey($index)) { $passerelles[$index] } else { $null }
                adresse_mac = if ($carte -and $carte.MacAddress) { [string]$carte.MacAddress } else { $null }
                media       = $media
                materielle  = if ($carte -and $null -ne $carte.HardwareInterface) { [bool]$carte.HardwareInterface } else { $null }
                etat        = if ($carte) { [string]$carte.Status } else { $null }
            })
        }
        $interfaces = @($liste)
    } catch {
        # Windows 7 : le module NetTCPIP n'existe pas. $null, pas @().
    }

    # -- La table de voisinage --
    try {
        $v = New-Object System.Collections.ArrayList
        foreach ($n in @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop)) {
            $etat = [string]$n.State
            if ($etat -eq "Unreachable" -or $etat -eq "Incomplete") { continue }
            $mac = [string]$n.LinkLayerAddress
            if (-not $mac) { continue }
            # Diffusion et multidiffusion ne sont pas des machines.
            if ($mac -eq "ff-ff-ff-ff-ff-ff") { continue }
            if ($mac -like "01-00-5e-*" -or $mac -like "33-33-*") { continue }
            [void]$v.Add([ordered]@{
                index       = [int]$n.ifIndex
                adresse_ip  = [string]$n.IPAddress
                adresse_mac = $mac
                etat        = $etat
            })
        }
        $voisins = @($v)
    } catch { }

    # -- La borne Wi-Fi, quand il y en a une --
    #
    # `netsh` est le seul chemin present sur tout Windows depuis 7. On ne
    # se fie pas aux etiquettes traduites : on cherche une adresse MAC
    # sur une ligne qui contient BSSID. Une sortie en japonais donnerait
    # le meme resultat.
    try {
        $sortie = & netsh wlan show interfaces 2>$null
        if ($sortie) {
            $bssid = $null
            $ssid  = $null
            foreach ($ligne in @($sortie)) {
                if ($ligne -match 'BSSID[^:]*:\s*([0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})') {
                    $bssid = $Matches[1]
                } elseif (-not $ssid -and $ligne -match '^\s*SSID[^:]*:\s*(\S.*?)\s*$') {
                    $ssid = $Matches[1]
                }
            }
            # Pas de BSSID : soit aucune radio, soit radio non associee.
            # Dans les deux cas il n'y a AUCUN lien sans fil a dessiner,
            # et c'est la seule chose que la carte a besoin de savoir.
            if ($bssid) { $wifi = [ordered]@{ bssid = $bssid; ssid = $ssid } }
        }
    } catch { }

    if ($null -eq $interfaces -and $null -eq $voisins -and $null -eq $wifi) { return $null }

    return [ordered]@{
        interfaces = $interfaces
        voisins    = $voisins
        wifi       = $wifi
    }
}

function Get-Sante {
    $sante = [ordered]@{
        memoire_totale_mo = $null
        memoire_libre_mo  = $null
        dernier_demarrage = $null
        disques           = $null
        services          = $null
        antivirus         = $null
    }

    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
        if ($os.TotalVisibleMemorySize) {
            $sante.memoire_totale_mo = [int]([math]::Round($os.TotalVisibleMemorySize / 1024))
        }
        if ($os.FreePhysicalMemory) {
            $sante.memoire_libre_mo = [int]([math]::Round($os.FreePhysicalMemory / 1024))
        }
        if ($os.LastBootUpTime) {
            # Format ISO : le serveur le relit sans dependre de la langue
            # du poste. « 25/09/2026 » et « 09/25/2026 » ne se distinguent
            # pas, et une date lue a l'envers passerait inapercue.
            $sante.dernier_demarrage = $os.LastBootUpTime.ToString("yyyy-MM-dd HH:mm:ss")
        }
    } catch { }

    # DriveType = 3 : disques fixes seulement. Les cles USB et les
    # lecteurs reseau vont et viennent ; les compter ferait varier
    # l'espace libre du poste sans que rien n'ait change dessus.
    try {
        $volumes = Get-CimInstance Win32_LogicalDisk -Filter "DriveType = 3" -ErrorAction Stop
        if ($volumes) {
            $sante.disques = @(
                $volumes | ForEach-Object {
                    [ordered]@{
                        lettre   = $_.DeviceID
                        total_go = [math]::Round($_.Size / 1GB, 1)
                        libre_go = [math]::Round($_.FreeSpace / 1GB, 1)
                    }
                }
            )
        }
    } catch { }

    # Les trois services qu'un logiciel malveillant arrete en premier, et
    # que l'on desactive « juste pour installer un truc ». On ne lit QUE
    # ceux-la : la liste entiere pese des centaines de lignes et
    # n'apprend rien.
    try {
        $attendus = @{
            "MpsSvc"    = "Pare-feu Windows"
            "WinDefend" = "Antivirus Microsoft Defender"
            "wuauserv"  = "Mises a jour Windows"
        }
        $svc = Get-Service -Name $attendus.Keys -ErrorAction SilentlyContinue
        if ($svc) {
            $sante.services = @(
                $svc | ForEach-Object {
                    [ordered]@{
                        nom       = $_.Name
                        libelle   = $attendus[$_.Name]
                        # Meme vocabulaire que la voie WMI : le serveur
                        # compare a « Running », et deux sources qui
                        # ecrivent le meme etat de deux facons produiraient
                        # deux affichages differents pour un meme fait.
                        etat      = if ($_.Status -eq "Running") { "Running" } else { [string]$_.Status }
                        demarrage = [string]$_.StartType
                    }
                }
            )
        }
    } catch { }

    # root\SecurityCenter2 est l'endroit ou tout antivirus installe se
    # declare, y compris les produits tiers. On ne lit que le NOM : l'etat
    # y est encode dans un entier non documente, et une plateforme qui
    # annonce « protege » doit pouvoir le prouver.
    try {
        $av = Get-CimInstance -Namespace "root\SecurityCenter2" -ClassName AntiVirusProduct -ErrorAction Stop
        if ($av) { $sante.antivirus = @($av | ForEach-Object { $_.displayName }) }
    } catch { }

    return $sante
}

# ══ IDENTITE DE LA MACHINE ══════════════════════════════════════════
#
# L'adresse par laquelle cette machine est connue du RESTE du reseau.
# Les cartes virtuelles et le bouclage sont ecartes : une machine qui
# s'annoncerait en 127.0.0.1 ne pourrait etre rapprochee d'aucun
# equipement de l'inventaire, et le script semblerait ne rien remonter.
function Get-Identite {
    $carte = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
             Where-Object {
                 $_.IPv4Address -and
                 $_.NetAdapter.Status -eq "Up" -and
                 $_.IPv4DefaultGateway
             } | Select-Object -First 1

    if ($carte) {
        return [ordered]@{
            adresse_ip  = $carte.IPv4Address.IPAddress
            adresse_mac = if ($carte.NetAdapter.MacAddress) {
                              $carte.NetAdapter.MacAddress.Replace("-", ":").ToLower()
                          } else { $null }
        }
    }

    # Repli pour les vieux Windows, ou Get-NetIPConfiguration n'existe pas.
    $ip = (Test-Connection -ComputerName $env:COMPUTERNAME -Count 1 -ErrorAction SilentlyContinue).IPV4Address.IPAddressToString
    return [ordered]@{ adresse_ip = $ip; adresse_mac = $null }
}

# ══ ENVOI ═══════════════════════════════════════════════════════════
function Envoyer($corps) {
    # Profondeur 6 : le volet `sante` ajoute un niveau (sante > disques >
    # objet > proprietes). A 4, ConvertTo-Json aurait rendu la chaine
    # « System.Collections.Hashtable » a la place des disques — et le
    # serveur aurait enregistre du texte sans s'en apercevoir.
    $json = $corps | ConvertTo-Json -Depth 6 -Compress

    # UTF-8 EXPLICITE. Sans cette conversion, un logiciel nomme
    # « Microsoft Office Édition Familiale » part en caracteres abimes et
    # se retrouve tel quel dans la base — illisible, et impossible a
    # rapprocher d'une version connue.
    $octets = [System.Text.Encoding]::UTF8.GetBytes($json)

    # TLS 1.2 : PowerShell 5.1 propose encore TLS 1.0 par defaut, que les
    # serveurs refusent depuis longtemps. L'erreur qui en resulte parle de
    # « connexion fermee », jamais de protocole — une heure perdue garantie.
    try {
        [Net.ServicePointManager]::SecurityProtocol =
            [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
    } catch { }

    Invoke-RestMethod -Uri "$CENTRAL_API_URL/agent/inventaire-poste" `
        -Method Post -Body $octets -ContentType "application/json; charset=utf-8" `
        -Headers @{ Authorization = "Bearer $AGENT_TOKEN" } `
        -TimeoutSec 30
}

# ══ DEROULEMENT ═════════════════════════════════════════════════════
try {
    if (-not $AGENT_TOKEN -and -not $Test) {
        Ecrire "ARRET : le jeton du site n'est pas renseigne dans ce script."
        Ecrire "        Un script sans jeton tournerait en silence sur tout le parc."
        exit 1
    }

    $moi = Get-Identite
    if (-not $moi.adresse_ip) {
        Ecrire "ARRET : aucune adresse reseau utilisable sur cette machine."
        exit 1
    }

    # `$null` et `@()` ne veulent PAS dire la meme chose pour le serveur :
    # `@()` signifie « collecte, rien trouve », `$null` signifie « la
    # collecte a echoue ». Les confondre effacerait l'inventaire d'une
    # machine sur un simple refus temporaire.
    $logiciels = $null
    $processus = $null
    try { $logiciels = @(Get-LogicielsInstalles) } catch { Ecrire "Logiciels non collectes : $($_.Exception.Message)" }
    try { $processus = @(Get-ProgrammesEnCours) } catch { Ecrire "Programmes non collectes : $($_.Exception.Message)" }

    $sante = $null
    try { $sante = Get-Sante } catch { Ecrire "Sante non collectee : $($_.Exception.Message)" }

    # Les deux mesures qui alimentent les courbes : charge du processeur
    # et compteurs reseau. `$null` en cas d'echec — jamais 0.
    $processeur = $null
    $reseau = $null
    try { $processeur = Get-ChargeProcesseur } catch { Ecrire "Charge processeur non collectee : $($_.Exception.Message)" }
    try { $reseau = Get-Reseau } catch { Ecrire "Compteurs reseau non collectes : $($_.Exception.Message)" }

    # La topologie : des preuves de voisinage, pas un dessin.
    $topologie = $null
    try { $topologie = Get-Topologie } catch { Ecrire "Topologie non collectee : $($_.Exception.Message)" }

    $corps = [ordered]@{
        id_site       = $ID_SITE
        agent_version = $VERSION
        adresse_ip    = $moi.adresse_ip
        adresse_mac   = $moi.adresse_mac
        nom_machine   = $env:COMPUTERNAME
        systeme       = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
        # Bornes d'envoi : elles ne servent pas au cas normal (80 a 150
        # processus, 60 a 200 logiciels) mais evitent qu'une machine
        # anormale envoie un corps que le serveur refuserait EN ENTIER.
        # Un inventaire tronque et recu vaut mieux qu'un inventaire
        # complet et rejete.
        logiciels     = if ($null -ne $logiciels) { @($logiciels | Select-Object -First 600) } else { $null }
        processus     = if ($null -ne $processus) { @($processus | Select-Object -First 400) } else { $null }
        sante         = $sante
        processeur_pourcent = $processeur
        reseau        = $reseau
        topologie     = $topologie
    }

    if ($Test) {
        Ecrire "ESSAI — rien n'est envoye."
        Ecrire "  Machine  : $($corps.nom_machine)  $($corps.adresse_ip)"
        Ecrire "  Systeme  : $($corps.systeme)"
        Ecrire "  Logiciels: $(@($corps.logiciels).Count)"
        Ecrire "  Processus: $(@($corps.processus).Count)"
        if ($corps.sante) {
            $d = @($corps.sante.disques) | ForEach-Object { "$($_.lettre) $($_.libre_go)/$($_.total_go) Go" }
            Ecrire "  Memoire  : $($corps.sante.memoire_libre_mo) Mo libres sur $($corps.sante.memoire_totale_mo)"
            Ecrire "  Disques  : $($d -join '  ')"
            Ecrire "  Demarrage: $($corps.sante.dernier_demarrage)"
            $arretes = @($corps.sante.services) | Where-Object { $_.etat -ne "Running" }
            if ($arretes) {
                Ecrire "  ATTENTION: $(@($arretes | ForEach-Object { $_.libelle }) -join ', ') arrete(s)"
            } else {
                Ecrire "  Protection: pare-feu, antivirus et mises a jour actifs"
            }
        }
        if ($corps.topologie) {
            $t = $corps.topologie
            $avecP = @(@($t.interfaces) | Where-Object { $_.passerelle })
            Ecrire "  Interfaces: $(@($t.interfaces).Count) vues, $(@($avecP).Count) avec une passerelle"
            foreach ($i in @($t.interfaces)) {
                $p = if ($i.passerelle) { "vers $($i.passerelle)" } else { "sans passerelle" }
                $m = if ($null -eq $i.materielle) { "indetermine" } elseif ($i.materielle) { "materielle" } else { "virtuelle" }
                $e = if ($i.etat) { [string]$i.etat } else { "etat inconnu" }
                Ecrire ("    {0}/{1}  {2}  [{3}/{4}]  {5}  {6}" -f $i.adresse_ip, $i.masque, $p, $m, $e, $i.media, $i.nom)
            }
            if ($null -eq $t.voisins) {
                Ecrire "  Voisins  : non collectes sur ce Windows"
            } else {
                $joign = @(@($t.voisins) | Where-Object { $_.etat -eq "Reachable" })
                Ecrire "  Voisins  : $(@($t.voisins).Count) entrees, dont $(@($joign).Count) joignables a l'instant"
                # Reparti par interface : un total melange les voisins de
                # la vraie carte avec ceux des cartes virtuelles.
                $noms = @{}
                foreach ($i in @($t.interfaces)) { $noms[[string]$i.index] = [string]$i.nom }
                $parIndex = @{}
                foreach ($v in @($t.voisins)) {
                    $k = [string]$v.index
                    if (-not $parIndex.ContainsKey($k)) { $parIndex[$k] = @(0, 0) }
                    $parIndex[$k][0]++
                    if ($v.etat -eq "Reachable") { $parIndex[$k][1]++ }
                }
                foreach ($k in (@($parIndex.Keys) | Sort-Object { [int]$_ })) {
                    $libelle = if ($noms.ContainsKey($k)) { $noms[$k] } else { "interface $k" }
                    Ecrire ("      {0} joignables sur {1}   {2}" -f $parIndex[$k][1], $parIndex[$k][0], $libelle)
                }
            }
            if ($t.wifi) {
                Ecrire "  Wi-Fi    : associe a la borne $($t.wifi.bssid)  ($($t.wifi.ssid))"
            } else {
                Ecrire "  Wi-Fi    : aucune association (filaire, ou radio eteinte)"
            }
        }
        Ecrire "  Destination : $CENTRAL_API_URL/agent/inventaire-poste"
        Write-Host ""
        Write-Host "Les dix premiers logiciels vus :" -ForegroundColor Cyan
        @($corps.logiciels) | Select-Object -First 10 | ForEach-Object {
            Write-Host ("  {0}  {1}" -f $_.nom, $_.version)
        }
        exit 0
    }

    $reponse = Envoyer $corps
    Ecrire ("Envoye : {0} logiciel(s), {1} processus (equipement #{2})." -f
            $reponse.logiciels, $reponse.processus, $reponse.id_equipement)
    exit 0

} catch {
    # Aucune exception ne remonte au planificateur : une tache en erreur
    # sur 559 postes remplit le journal du domaine sans rien apprendre.
    # Le detail utile est ici, sur la machine concernee.
    $detail = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
    Ecrire "ECHEC : $detail"
    exit 1
}
