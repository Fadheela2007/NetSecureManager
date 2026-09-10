# ---------------------------------------------------------------------
# mise-a-jour.ps1 — tout ce qu'il faut faire apres une modification.
#
#   Clic droit sur ce fichier -> « Executer avec PowerShell »
#   ou, dans un terminal ouvert a la racine du projet :
#       powershell -ExecutionPolicy Bypass -File .\mise-a-jour.ps1
#
# Applique les migrations, reconstruit l'interface, et DIT ce qui a
# marche et ce qui n'a pas marche. Ne demarre pas le backend : celui-ci
# doit vivre dans sa propre fenetre, qu'on garde ouverte.
#
# POURQUOI CE SCRIPT EXISTE. Les memes quatre commandes revenaient a
# chaque changement, dans le bon ordre, depuis les bons dossiers. Une
# oubliee et on teste l'ancienne version en croyant tester la nouvelle —
# ce qui fait chercher un defaut la ou il n'y en a pas.
# ---------------------------------------------------------------------

$ErrorActionPreference = "Continue"
$racine = Split-Path -Parent $MyInvocation.MyCommand.Definition
$backend = Join-Path $racine "backend"
$frontend = Join-Path $racine "frontend"

$echecs = @()

function Titre($texte) {
    Write-Host ""
    Write-Host "=== $texte " -ForegroundColor Cyan -NoNewline
    Write-Host ("=" * [Math]::Max(0, 55 - $texte.Length)) -ForegroundColor Cyan
}

function Bilan($nom, $ok, $conseil) {
    if ($ok) {
        Write-Host "  OK   $nom" -ForegroundColor Green
    } else {
        Write-Host "  ECHEC $nom" -ForegroundColor Red
        if ($conseil) { Write-Host "       $conseil" -ForegroundColor DarkGray }
        $script:echecs += $nom
    }
}

# --- 0. Node est-il la ? -----------------------------------------------
Titre "Verifications"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  Node.js est introuvable dans le PATH." -ForegroundColor Red
    Write-Host "  Rien ne peut fonctionner sans lui. Installez-le, puis relancez." -ForegroundColor DarkGray
    Read-Host "`nAppuyez sur Entree pour fermer"
    exit 1
}
Write-Host "  Node $(node --version)" -ForegroundColor Green

# --- 1. Migrations de la base ------------------------------------------
#
# En premier, et c'est important : l'interface reconstruite peut demander
# des colonnes que la base n'a pas encore. Dans l'autre ordre, on verrait
# des ecrans vides sans comprendre pourquoi.
Titre "Base de donnees"
Push-Location $backend
node tools\appliquer-migrations.js
$migrationsOk = ($LASTEXITCODE -eq 0)
Pop-Location
Bilan "migrations appliquees" $migrationsOk `
      "MySQL est-il demarre ? Verifiez aussi backend\.env (DB_USER, DB_PASSWORD)."

# --- 2. Interface ------------------------------------------------------
Titre "Interface"
Push-Location $frontend
if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Host "  node_modules absent — installation des dependances (une seule fois)..." -ForegroundColor DarkGray
    npm install
}
npm run build
$buildOk = ($LASTEXITCODE -eq 0)
Pop-Location
Bilan "interface reconstruite" $buildOk `
      "Si l'erreur parle de 'native binding' : supprimez frontend\node_modules et relancez."

# --- 3. Tests ----------------------------------------------------------
#
# Apres le reste : ils ne touchent ni la base ni le reseau, ils ne
# peuvent donc rien casser. Un echec ici signale une regression dans le
# code, pas un probleme d'installation.
Titre "Tests"
# La sortie est ecrite dans un fichier plutot que capturee au vol.
#
# `npm test 2>&1 | Out-String` rendait une chaine vide sur ce poste : npm
# est un .cmd, et son flux traverse deux interpreteurs avant d'arriver a
# PowerShell. Le script concluait alors « la suite n'a pas pu s'executer »
# alors que les 342 tests passaient — un faux echec, exactement le genre
# de message qui fait chercher un defaut inexistant.
Push-Location $backend
$journal = Join-Path $env:TEMP "netsecure-tests.txt"
& npm test *> $journal
$codeSortie = $LASTEXITCODE
Pop-Location

$sortie = if (Test-Path $journal) { Get-Content $journal -Raw } else { "" }
$passes = if ($sortie -match "# pass (\d+)") { $Matches[1] } else { $null }
$rates  = if ($sortie -match "# fail (\d+)") { [int]$Matches[1] } else { $null }

if ($null -ne $rates) {
    Bilan "$passes tests passent, $rates echouent" ($rates -eq 0) `
          "Dites-le-moi : une regression est entree dans le code."
} elseif ($codeSortie -eq 0) {
    # Code de sortie 0 : les tests ont reussi, seul l'affichage a manque.
    Bilan "tests passes" $true $null
} else {
    Bilan "tests executes" $false "Detail complet dans $journal"
}

# --- Bilan -------------------------------------------------------------
Titre "Et maintenant"
if ($echecs.Count -eq 0) {
    Write-Host "  Tout est pret." -ForegroundColor Green
    Write-Host ""
    Write-Host "  1. Demarrez le backend dans SA PROPRE fenetre, a laisser ouverte :" -ForegroundColor White
    Write-Host "       cd `"$backend`"" -ForegroundColor DarkGray
    Write-Host "       npm start" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  2. Dans le navigateur : Ctrl + Maj + R" -ForegroundColor White
    Write-Host "     Sans ce raccourci, le navigateur ressert l'ancienne interface" -ForegroundColor DarkGray
    Write-Host "     depuis son cache — et vous testeriez la version d'avant." -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  3. Relancez un scan : les versions des logiciels ne se lisent" -ForegroundColor White
    Write-Host "     qu'au scan, pas retroactivement." -ForegroundColor DarkGray
} else {
    Write-Host "  A regler avant de tester :" -ForegroundColor Yellow
    foreach ($e in $echecs) { Write-Host "    - $e" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "  Rien n'a ete casse : ce script n'efface aucune donnee." -ForegroundColor DarkGray
}

Write-Host ""
Read-Host "Appuyez sur Entree pour fermer"
