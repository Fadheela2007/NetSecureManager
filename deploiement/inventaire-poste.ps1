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
    - le nom de la machine, son systeme, son adresse.

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

$VERSION = "1.0.0-ps"

# Le journal vit dans ProgramData : lisible par l'administrateur, ecrit
# par SYSTEM, et il survit au changement d'utilisateur. Sans journal, un
# script pousse par GPO qui echoue le fait en silence sur 559 postes.
$dossierJournal = Join-Path $env:ProgramData "NetSecureManager"
$journal = Join-Path $dossierJournal "inventaire.log"

function Ecrire($message) {
    $ligne = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
    Write-Host $ligne
    try {
        if (-not (Test-Path $dossierJournal)) {
            New-Item -ItemType Directory -Path $dossierJournal -Force | Out-Null
        }
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
    $json = $corps | ConvertTo-Json -Depth 4 -Compress

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
    }

    if ($Test) {
        Ecrire "ESSAI — rien n'est envoye."
        Ecrire "  Machine  : $($corps.nom_machine)  $($corps.adresse_ip)"
        Ecrire "  Systeme  : $($corps.systeme)"
        Ecrire "  Logiciels: $(@($corps.logiciels).Count)"
        Ecrire "  Processus: $(@($corps.processus).Count)"
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
