<#
    src/services/inventaire-windows.ps1

    Lit ce qui tourne sur UN poste Windows, sans rien installer dessus.

    Appele par inventaireWindowsService.js. Ecrit un seul objet JSON sur
    la sortie standard, et rien d'autre : toute ligne parasite casserait
    la lecture cote Node.

    LES IDENTIFIANTS ARRIVENT PAR L'ENTREE STANDARD, jamais en argument.
    Un mot de passe passe en ligne de commande est visible de tout le
    systeme, dans le gestionnaire des taches comme dans les journaux.

    DEUX VOIES, ESSAYEES DANS CET ORDRE.

      WinRM (port 5985) - la voie moderne. Elle permet en plus de lire
        les logiciels installes en UN aller-retour.
      DCOM (port 135)   - la voie historique, active par defaut sur
        Windows depuis toujours. Elle donne les programmes en cours,
        mais pas les logiciels installes a un cout raisonnable.

    POURQUOI PAS Win32_Product POUR LES LOGICIELS. Interroger cette
    classe declenche une reparation MSI de CHAQUE logiciel installe sur
    la machine interrogee. C'est un piege connu de WMI, et il se paierait
    sur le parc du client. On lit la base de registre a la place.
#>

param([Parameter(Mandatory = $true)][string]$Machine)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$WarningPreference = "SilentlyContinue"

function Rendre($objet) {
    # -Compress : une seule ligne, plus simple a lire cote Node.
    $objet | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# ── Identifiants : deux lignes sur l'entree standard ──
$utilisateur = [Console]::In.ReadLine()
$motDePasse = [Console]::In.ReadLine()

$identifiants = $null
if ($utilisateur) {
    try {
        $secret = ConvertTo-SecureString $motDePasse -AsPlainText -Force
        $identifiants = New-Object System.Management.Automation.PSCredential($utilisateur, $secret)
    } catch {
        Rendre @{ ok = $false; raison = "identifiants_invalides" }
    }
}

# ── Ouverture de la session, WinRM puis DCOM ──
$session = $null
$voie = $null

foreach ($essai in @("WinRM", "DCOM")) {
    try {
        $p = @{ ComputerName = $Machine; OperationTimeoutSec = 12; ErrorAction = "Stop" }
        if ($identifiants) { $p.Credential = $identifiants }
        if ($essai -eq "DCOM") { $p.SessionOption = New-CimSessionOption -Protocol Dcom }
        $session = New-CimSession @p
        $voie = $essai
        break
    } catch {
        $dernierEchec = $_.Exception.Message
        $session = $null
    }
}

if (-not $session) {
    # On distingue « je n'ai pas pu entrer » de « on m'a refuse l'entree » :
    # le premier se corrige par une GPO, le second par un compte.
    $raison = "injoignable"
    if ($dernierEchec -match "Acc|denied|refus|0x80070005") { $raison = "acces_refuse" }
    Rendre @{ ok = $false; raison = $raison; detail = $dernierEchec }
}

$resultat = @{ ok = $true; voie = $voie; systeme = $null; processus = $null; logiciels = $null }

# ── Le systeme ──
try {
    $os = Get-CimInstance -CimSession $session -ClassName Win32_OperatingSystem -ErrorAction Stop
    $resultat.systeme = $os.Caption
} catch { }

# ── Les programmes en cours ──
#
# Regroupes par nom : un navigateur ouvre trente processus du meme
# executable, et les lister trente fois n'apprend rien. Ce qu'on veut
# savoir c'est QUOI tourne, en combien d'exemplaires, et ce que ca pese
# au total.
#
# La memoire vient de WorkingSetSize, en octets - convertie en kilo-octets
# pour tenir dans la meme colonne que les autres sources.
try {
    $procs = Get-CimInstance -CimSession $session -ClassName Win32_Process `
                             -Property Name, WorkingSetSize -ErrorAction Stop
    if ($procs) {
        $resultat.processus = @(
            $procs | Group-Object -Property Name | ForEach-Object {
                [pscustomobject]@{
                    nom         = $_.Name
                    occurrences = $_.Count
                    memoire_ko  = [int64]((($_.Group | Measure-Object -Property WorkingSetSize -Sum).Sum) / 1024)
                    utilisateur = $null
                }
            } | Sort-Object -Property memoire_ko -Descending | Select-Object -First 200
        )
    }
} catch { }

# ── Les logiciels installes, seulement par WinRM ──
#
# Un aller-retour unique, contre plusieurs centaines par la voie DCOM.
# Sur DCOM on rend `null` - c'est-a-dire « je n'ai pas regarde » - et
# jamais une liste vide, qui effacerait ce qu'un autre releve a trouve.
if ($voie -eq "WinRM") {
    try {
        $p = @{ ComputerName = $Machine; ErrorAction = "Stop" }
        if ($identifiants) { $p.Credential = $identifiants }
        $brut = Invoke-Command @p -ScriptBlock {
            $cles = @(
                "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
                "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
            )
            Get-ItemProperty -Path $cles -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
                Select-Object @{ n = "nom"; e = { $_.DisplayName } },
                              @{ n = "version"; e = { $_.DisplayVersion } },
                              @{ n = "editeur"; e = { $_.Publisher } }
        }
        if ($brut) {
            $resultat.logiciels = @(
                $brut | Sort-Object -Property nom -Unique | Select-Object -First 500 |
                    ForEach-Object {
                        [pscustomobject]@{ nom = $_.nom; version = $_.version; editeur = $_.editeur }
                    }
            )
        }
    } catch { }
}

Remove-CimSession -CimSession $session -ErrorAction SilentlyContinue
Rendre $resultat
