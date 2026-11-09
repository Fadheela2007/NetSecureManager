# ---------------------------------------------------------------------
# installer-agent-poste.ps1 — installe l'agent SUR CETTE MACHINE.
#
#   Clic droit -> « Executer avec PowerShell »
#   ou : powershell -ExecutionPolicy Bypass -File .\installer-agent-poste.ps1
#
# A copier sur chaque poste dont on veut voir l'interieur, avec les deux
# fichiers agent-poste.js et collecteurs.js (le script les cherche a cote
# de lui, puis dans backend\src\agent-poste).
#
# Il pose trois questions, installe, envoie un premier inventaire, et
# propose de declarer la tache au demarrage. Il ne fait RIEN d'autre :
# aucun fichier du systeme n'est modifie, rien n'est ajoute au registre
# en dehors de la tache planifiee, que ce script peut aussi retirer.
# ---------------------------------------------------------------------

$ErrorActionPreference = "Continue"
$ici = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "=== Agent de poste — installation ======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Cet agent remonte les logiciels installes et les programmes" -ForegroundColor DarkGray
Write-Host "en cours de CETTE machine. Il n'observe aucune autre machine." -ForegroundColor DarkGray
Write-Host ""

# --- Node ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js est introuvable sur ce poste." -ForegroundColor Red
    Write-Host "L'agent ne peut pas tourner sans lui. Deux possibilites :" -ForegroundColor DarkGray
    Write-Host "  - installer Node.js sur ce poste ;" -ForegroundColor DarkGray
    Write-Host "  - ou empaqueter l'agent en un seul .exe, a preparer une fois" -ForegroundColor DarkGray
    Write-Host "    pour tout le parc." -ForegroundColor DarkGray
    Read-Host "`nEntree pour fermer"
    exit 1
}

# --- Ou installer -------------------------------------------------------
$defaut = "C:\NetSecureAgent"
$dossier = Read-Host "Dossier d'installation [$defaut]"
if ([string]::IsNullOrWhiteSpace($dossier)) { $dossier = $defaut }
New-Item -ItemType Directory -Force -Path $dossier | Out-Null

# --- Retrouver les deux fichiers ---------------------------------------
#
# A cote du script, ou dans l'arborescence du projet. On ne devine pas
# plus loin : un fichier introuvable doit se dire, pas se chercher
# indefiniment.
$sources = @("agent-poste.js", "collecteurs.js")
$origines = @($ici, (Join-Path $ici "backend\src\agent-poste"), (Join-Path $ici "..\backend\src\agent-poste"))

foreach ($f in $sources) {
    $trouve = $null
    foreach ($o in $origines) {
        $chemin = Join-Path $o $f
        if (Test-Path $chemin) { $trouve = $chemin; break }
    }
    if (-not $trouve) {
        Write-Host "`nFichier introuvable : $f" -ForegroundColor Red
        Write-Host "Copiez agent-poste.js et collecteurs.js a cote de ce script." -ForegroundColor DarkGray
        Read-Host "`nEntree pour fermer"
        exit 1
    }
    Copy-Item $trouve (Join-Path $dossier $f) -Force
}
Write-Host "  Fichiers copies dans $dossier" -ForegroundColor Green

# --- Configuration ------------------------------------------------------
# DEUX VALEURS AU LIEU DE TROIS, ET SURTOUT PLUS DE JETON DE SITE.
#
# Le jeton du site vaut pour TOUTES les machines du site. Le recopier sur
# chaque poste, c'est le laisser dans autant de fichiers et de
# presse-papiers ; le jour ou il fuit, il faut le changer partout.
#
# Desormais, l'administrateur demande un CODE pour CE poste, depuis sa
# fiche dans la plateforme. Le code vaut 30 minutes, ne sert qu'une fois,
# et cette machine l'echange contre un jeton qui n'appartient qu'a elle.
Write-Host ""
Write-Host "Deux valeurs, lisibles dans la plateforme :" -ForegroundColor White
Write-Host "Le code s'obtient sur la fiche de CE poste, bouton Rattacher ce poste." -ForegroundColor DarkGray
$url = Read-Host "  Adresse de l'API (ex. http://192.168.0.10:5000/api)"
$code = Read-Host "  Code de rattachement (ex. K7P4-2Q9M)"

if ([string]::IsNullOrWhiteSpace($url) -or [string]::IsNullOrWhiteSpace($code)) {
    Write-Host "`nLes deux valeurs sont obligatoires. Installation annulee." -ForegroundColor Red
    Write-Host "Un agent configure a moitie tournerait en silence, et on le" -ForegroundColor DarkGray
    Write-Host "croirait en place." -ForegroundColor DarkGray
    Read-Host "`nEntree pour fermer"
    exit 1
}

# --- Echange du code contre le jeton de ce poste ------------------------
#
# On le fait MAINTENANT, avant d'ecrire quoi que ce soit : un code refuse
# doit arreter l'installation ici, pas produire un agent qui tournera en
# silence sans jamais etre accepte.
Write-Host ""
Write-Host "Presentation du code a la plateforme..." -ForegroundColor DarkGray
try {
    $reponse = Invoke-RestMethod -Uri "$url/agent/rattacher" -Method Post -TimeoutSec 20 `
                                 -ContentType "application/json" `
                                 -Body (@{ code = $code; nom_machine = $env:COMPUTERNAME } | ConvertTo-Json)
} catch {
    $detail = $_.ErrorDetails.Message
    Write-Host "`nRattachement refuse." -ForegroundColor Red
    if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray }
    Write-Host "  Causes habituelles : code expire (30 minutes), code deja utilise," -ForegroundColor DarkGray
    Write-Host "  adresse de l'API incorrecte, ou plateforme injoignable depuis ce poste." -ForegroundColor DarkGray
    Read-Host "`nEntree pour fermer"
    exit 1
}

$jeton = $reponse.jeton
$site = $reponse.id_site

if ([string]::IsNullOrWhiteSpace($jeton)) {
    Write-Host "`nLa plateforme n'a pas rendu de jeton. Installation annulee." -ForegroundColor Red
    Read-Host "`nEntree pour fermer"
    exit 1
}

Write-Host "  Poste rattache — jeton propre a cette machine recu." -ForegroundColor Green
Write-Host "  Ce jeton ne permet d'ecrire QUE l'inventaire de ce poste." -ForegroundColor DarkGray

Write-Host ""
Write-Host "Le nom de l'utilisateur de chaque programme peut etre remonte." -ForegroundColor White
Write-Host "Par defaut il ne l'est PAS : la liste des programmes qu'une" -ForegroundColor DarkGray
Write-Host "personne fait tourner dit beaucoup d'elle." -ForegroundColor DarkGray
$utilisateur = Read-Host "  Collecter le nom d'utilisateur ? (o/N)"
$collecte = if ($utilisateur -match "^[oO]") { "1" } else { "0" }

@"
CENTRAL_API_URL=$url
AGENT_TOKEN=$jeton
ID_SITE=$site
INTERVALLE_MINUTES=60
COLLECTER_UTILISATEUR=$collecte
"@ | Set-Content -Path (Join-Path $dossier ".env") -Encoding UTF8

Write-Host "  Configuration ecrite" -ForegroundColor Green

# --- Dependances --------------------------------------------------------
Write-Host ""
Write-Host "Installation des trois bibliotheques necessaires..." -ForegroundColor DarkGray
Push-Location $dossier
if (-not (Test-Path (Join-Path $dossier "package.json"))) { npm init -y | Out-Null }
npm install axios node-cron dotenv --silent
$depsOk = ($LASTEXITCODE -eq 0)
Pop-Location

if (-not $depsOk) {
    Write-Host "  Installation echouee — ce poste a-t-il acces a internet ?" -ForegroundColor Red
    Write-Host "  Sans acces, copiez le dossier node_modules depuis un poste deja" -ForegroundColor DarkGray
    Write-Host "  installe : les trois bibliotheques n'ont aucun binaire natif." -ForegroundColor DarkGray
    Read-Host "`nEntree pour fermer"
    exit 1
}
Write-Host "  Bibliotheques installees" -ForegroundColor Green

# --- Premier envoi ------------------------------------------------------
#
# Immediatement, et c'est le point du script : sans lui il faudrait
# attendre une heure pour savoir si l'installation a reussi.
Write-Host ""
Write-Host "Premier inventaire..." -ForegroundColor DarkGray
Push-Location $dossier
$sortie = node -e "require('./agent-poste.js').collecterEtEnvoyer().then(()=>process.exit(0))" 2>&1 | Out-String
Pop-Location
Write-Host $sortie

if ($sortie -match "refuse|refused|Erreur") {
    Write-Host "L'envoi a ete refuse. Rien n'est casse — corrigez le .env" -ForegroundColor Yellow
    Write-Host "dans $dossier et relancez : node agent-poste.js" -ForegroundColor DarkGray
} else {
    Write-Host "Inventaire transmis. Ouvrez la fiche de cette machine dans la" -ForegroundColor Green
    Write-Host "plateforme : les logiciels doivent y apparaitre." -ForegroundColor Green
}

# --- Tache planifiee ----------------------------------------------------
Write-Host ""
$auto = Read-Host "Lancer l'agent automatiquement au demarrage ? (O/n)"
if ($auto -notmatch "^[nN]") {
    $nomTache = "NetSecureManager - agent de poste"
    $action = New-ScheduledTaskAction -Execute "node.exe" `
        -Argument "agent-poste.js" -WorkingDirectory $dossier
    $declencheur = New-ScheduledTaskTrigger -AtStartup
    $reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

    try {
        Register-ScheduledTask -TaskName $nomTache -Action $action `
            -Trigger $declencheur -Settings $reglages -RunLevel Highest -Force | Out-Null
        Write-Host "  Tache creee : « $nomTache »" -ForegroundColor Green
        Write-Host "  Pour la retirer : Unregister-ScheduledTask -TaskName '$nomTache'" -ForegroundColor DarkGray
    } catch {
        Write-Host "  Creation de la tache refusee : $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  Relancez ce script en tant qu'administrateur, ou declarez la" -ForegroundColor DarkGray
        Write-Host "  tache a la main (Planificateur de taches Windows)." -ForegroundColor DarkGray
    }
}

Write-Host ""
Read-Host "Termine. Entree pour fermer"
