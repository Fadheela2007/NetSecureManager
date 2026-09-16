# ---------------------------------------------------------------------
# NetSecureManager - nettoyage des documents remplaces
#
# Supprime les 23 documents dont le contenu a ete repris dans
# ETAT-DU-PROJET.md, plus deux fichiers morts.
#
# Le script AFFICHE d'abord ce qu'il va supprimer et attend que vous
# tapiez OUI. Rien n'est touche avant.
#
# A lancer depuis le dossier du projet :
#     powershell -ExecutionPolicy Bypass -File .\nettoyage.ps1
# ---------------------------------------------------------------------

$ErrorActionPreference = "Stop"
$racine = $PSScriptRoot
if (-not $racine) { $racine = (Get-Location).Path }

# Garde-fou : on refuse de tourner ailleurs que dans le projet.
if (-not (Test-Path (Join-Path $racine "backend\src\server.js"))) {
    Write-Host "Ce script doit etre lance depuis le dossier NetSecureManager." -ForegroundColor Red
    Write-Host "Dossier courant : $racine"
    exit 1
}

$fichiers = @(
    # Etat du projet - repris dans ETAT-DU-PROJET.md
    "A-FAIRE.md",
    "OU-EN-EST-LE-PROJET.md",
    "OU-EN-SUIS-JE.md",
    "RESTE_A_FAIRE_revu.md",
    "VALIDATION-FINALE.md",
    "RAPPORT-SEMAINE-2026-08-28.md",
    "SUITE-DES-TESTS.md",
    "FICHE-TEST.md",
    # Rapports par fonction, ecrits en aout, tous remplaces
    "RAPPORT_ALIGNEMENT_SCHEMA.md",
    "RAPPORT_AUDIT.md",
    "RAPPORT_DISPONIBILITE.md",
    "RAPPORT_FIABILITE.md",
    "RAPPORT_GESTION_UTILISATEURS.md",
    "RAPPORT_OUI_FABRICANT.md",
    "RAPPORT_RAPPORTS_PLANIFIES.md",
    "RAPPORT_RELEVES_AGENT.md",
    "RAPPORT_SEUILS_PERFORMANCE.md",
    "RAPPORT_SUPERVISION_DISTANTE.md",
    "RAPPORT_TABLES_INEXPLOITEES.md",
    "RAPPORT_THEME_MOBILE.md",
    "RAPPORT_TYPES_COHERENTS.md",
    "RAPPORT-bande-passante.md",
    # Fichiers morts
    "CLAUDE.md",
    "frontend\src\api.js"
)

$dossiers = @("Claude outputs")

Write-Host ""
Write-Host "A SUPPRIMER :" -ForegroundColor Yellow
$poids = 0
$presents = @()
foreach ($f in $fichiers) {
    $chemin = Join-Path $racine $f
    if (Test-Path $chemin) {
        $taille = (Get-Item $chemin).Length
        $poids += $taille
        $presents += $chemin
        "{0,10:N0} o   {1}" -f $taille, $f | Write-Host
    }
}
foreach ($d in $dossiers) {
    $chemin = Join-Path $racine $d
    if (Test-Path $chemin) {
        $presents += $chemin
        Write-Host "    dossier   $d"
    }
}

Write-Host ""
Write-Host ("Total : {0} element(s), {1:N0} octets." -f $presents.Count, $poids)
Write-Host ""
Write-Host "CONSERVES : README, ETAT-DU-PROJET, les deux AUDIT-COMPLET," -ForegroundColor Green
Write-Host "ARCHITECTURE-EXPLIQUEE, LE-SCAN-EXPLIQUE, DEMONSTRATION-20-MINUTES," -ForegroundColor Green
Write-Host "PREPARATION-TEST-TECHNIQUE, TESTER-LA-PLATEFORME, TEST-PAR-MODULE," -ForegroundColor Green
Write-Host "les trois documents d'installation, RAPPORT-ENCADREUR, LICENSE." -ForegroundColor Green
Write-Host ""

if ($presents.Count -eq 0) {
    Write-Host "Rien a supprimer - le nettoyage a deja ete fait."
    exit 0
}

$reponse = Read-Host "Tapez OUI pour supprimer, autre chose pour annuler"
if ($reponse -ne "OUI") {
    Write-Host "Annule. Rien n'a ete supprime." -ForegroundColor Yellow
    exit 0
}

$supprimes = 0
foreach ($chemin in $presents) {
    try {
        Remove-Item -LiteralPath $chemin -Recurse -Force
        $supprimes++
    } catch {
        Write-Host ("Impossible de supprimer {0} : {1}" -f $chemin, $_.Exception.Message) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("$supprimes element(s) supprime(s).") -ForegroundColor Green
Write-Host "Il reste 14 documents a la racine. Commencez par ETAT-DU-PROJET.md."
Write-Host ""
Write-Host "Ce script peut etre supprime a son tour : il ne sert qu'une fois."
