<#
    installer.ps1 — met en service l'agent NetSecureManager sur un site distant.

    Usage (PowerShell en administrateur) :
      .\installer.ps1 -Url "https://superviseur.exemple.com/api" `
                      -Token "<jeton du site>" `
                      -Site 2 `
                      -Cidr "192.168.10.0/24"

    La commande complète, jeton inclus, est fournie par l'interface :
      Sites -> le site concerné -> « Mettre en service l'agent ».

    Le script installe l'agent, crée une tâche planifiée qui démarre au boot,
    puis VÉRIFIE que la première remontée arrive bien à la plateforme.
#>

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][int]$Site,
  [Parameter(Mandatory = $true)][string]$Cidr,
  [int]$Intervalle = 5,
  [string]$Communaute = "public",
  [string]$Dest = "C:\Program Files\NetSecureManager-Agent"
)

$ErrorActionPreference = "Stop"
$Tache = "NetSecureManagerAgent"

function Etape($t) { Write-Host "`n$t" -ForegroundColor White }
function Info($t)  { Write-Host "  $t" }
function Vert($t)  { Write-Host $t -ForegroundColor Green }
function Rouge($t) { Write-Host $t -ForegroundColor Red }

$estAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $estAdmin) {
  Rouge "Ouvrez PowerShell en tant qu'administrateur (le script cree une tache planifiee)."
  exit 1
}

Etape "1/5  Verification des prerequis"
try {
  $v = node -v
  Info "Node.js $v"
} catch {
  Rouge "Node.js est absent."
  Info "Installez-le depuis https://nodejs.org (version LTS), puis relancez ce script."
  exit 1
}
if (-not (Get-Command nmap -ErrorAction SilentlyContinue)) {
  Info "nmap absent - l'agent fonctionnera, mais sans identification par empreinte TCP/IP."
  Info "Pour l'ajouter : https://nmap.org/download.html"
}

Etape "2/5  Installation dans $Dest"
$Source = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if (-not (Test-Path (Join-Path $Source "package.json"))) {
  Rouge "Sources introuvables. Lancez ce script depuis backend\src\agent du projet."
  exit 1
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item (Join-Path $Source "src") $Dest -Recurse -Force
Copy-Item (Join-Path $Source "package.json") $Dest -Force
if (Test-Path (Join-Path $Source "data")) {
  Copy-Item (Join-Path $Source "data") $Dest -Recurse -Force
}
Push-Location $Dest
npm install --omit=dev --silent --no-audit --no-fund
Pop-Location
Info "Dependances installees"

Etape "3/5  Configuration"
$env_contenu = "CENTRAL_API_URL=$Url`nAGENT_TOKEN=$Token`nID_SITE=$Site`nCIDR=$Cidr`nSCAN_INTERVAL_MINUTES=$Intervalle`nSNMP_COMMUNITY=$Communaute"
$cheminEnv = Join-Path $Dest ".env"
Set-Content -Path $cheminEnv -Value $env_contenu -Encoding UTF8

# Le jeton vaut un mot de passe : on retire l'heritage et on ne laisse que
# les administrateurs et le compte systeme y acceder.
$acl = Get-Acl $cheminEnv
$acl.SetAccessRuleProtection($true, $false)
foreach ($compte in @("BUILTIN\Administrateurs", "BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) {
  try {
    $regle = New-Object System.Security.AccessControl.FileSystemAccessRule($compte, "FullControl", "Allow")
    $acl.AddAccessRule($regle)
  } catch { }
}
Set-Acl $cheminEnv $acl
Info "Site $Site, plage $Cidr, scan toutes les $Intervalle min"

Etape "4/5  Tache planifiee"
$node = (Get-Command node).Source
$script = Join-Path $Dest "src\agent\agent.js"

# Remplacement de l'ancien schtasks.exe par les commandes natives PowerShell
$tacheExistante = Get-ScheduledTask -TaskName $Tache -ErrorAction SilentlyContinue
if ($tacheExistante) {
  Unregister-ScheduledTask -TaskName $Tache -Confirm:$false | Out-Null
}

$action    = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $Dest
$demarrage = New-ScheduledTaskTrigger -AtStartup
$reglages  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 0)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $Tache -Action $action -Trigger $demarrage -Settings $reglages -Principal $principal -Description "Agent NetSecureManager (site $Site)" | Out-Null
Start-ScheduledTask -TaskName $Tache
Info "Tache creee - elle demarrera automatiquement au boot"

Etape "5/5  Verification de la remontee"

# ---------------------------------------------------------------------
# DUREE D'ATTENTE PROPORTIONNELLE A LA PLAGE.
#
# L'attente etait fixee a 90 s, ce qui ne convient qu'a une petite plage.
# Un /23 compte 510 adresses : le balayage ping seul prend une vingtaine
# de secondes, puis CHAQUE machine trouvee est interrogee en SNMP puis,
# si le type reste indetermine, par empreinte nmap - jusqu'a 15 s par
# machine. Sur 25 machines actives, le premier cycle depasse largement
# les cinq minutes.
#
# Conclure "la transmission n'a pas abouti" au bout de 90 s etait donc
# FAUX dans le cas le plus courant : l'agent fonctionnait, il n'avait
# simplement pas fini. Un diagnostic faux coute plus cher qu'une attente
# plus longue.
# ---------------------------------------------------------------------
$prefixe = 24
if ($Cidr -match '/(\d+)\s*$') { $prefixe = [int]$Matches[1] }
$nbHotes = [math]::Max(1, [math]::Pow(2, 32 - $prefixe) - 2)

# Plafonne a 4 min, meme pour une tres grande plage. Attendre 12 minutes
# devant un installateur serait absurde : une reponse 200 au ping prouve
# deja que l'URL est bonne, que le pare-feu laisse passer et que le jeton
# est accepte. La remontee elle-meme n'ajoute qu'une confirmation - le
# site passera Actif tout seul, avec ou sans nous.
$budget  = [int][math]::Min(240, [math]::Max(90, $nbHotes * 1.5))

Info "Plage de $nbHotes adresses - verification pendant $budget s au plus."
Info "Le premier cycle est le plus long : chaque machine trouvee est identifiee une a une."

# Quatre issues possibles, et elles ne se soignent pas de la meme facon.
#   injoignable : la plateforme n'a jamais repondu
#   jeton       : elle a repondu 403 - inutile d'insister
#   attente     : elle repond, le jeton est bon, le scan n'a pas fini
#   ok          : une remontee est arrivee
$etat = "injoignable"
$detail = ""
$debut = Get-Date

while (((Get-Date) - $debut).TotalSeconds -lt $budget) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-RestMethod -Uri "$Url/agent/ping" -Method Post -TimeoutSec 10 `
           -Headers @{ Authorization = "Bearer $Token" } -ContentType "application/json" `
           -Body (@{ id_site = $Site } | ConvertTo-Json -Depth 2)

    # Reponse 200 : la plateforme est joignable ET le jeton est valide.
    # Ces deux causes d'echec sont donc definitivement ecartees.
    if ($r.dernier_push) { $etat = "ok"; $detail = $r.site; break }
    $etat = "attente"
    $detail = $r.site
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }

    if ($code -eq 403) {
      # Reessayer ne changera rien : le jeton ne se repare pas tout seul.
      $etat = "jeton"
      break
    }
    if ($code -eq 404) {
      $etat = "route"
      break
    }
    if ($null -ne $code) {
      # La plateforme repond, mais pas ce qu'on attend (500, 502...).
      $etat = "erreur"
      $detail = "HTTP $code"
    }
  }

  $ecoule = [int]((Get-Date) - $debut).TotalSeconds
  Write-Host "`r  $ecoule s / $budget s ecoulees..." -NoNewline
}
Write-Host ""

Write-Host ""
switch ($etat) {
  "ok" {
    Vert "OK Agent en service. La plateforme a bien recu une remontee."
    Info "Verifiez dans l'interface : Sites -> $detail doit afficher Actif."
  }
  "attente" {
    # Ce n'est PAS un echec : l'installation est correcte et verifiee.
    Vert "OK Installation correcte. Plateforme joignable, jeton accepte."
    Write-Host ""
    Info "La premiere remontee n'est pas encore arrivee - c'est normal sur une"
    Info "plage de $nbHotes adresses : le premier cycle identifie chaque machine"
    Info "une par une et peut durer plusieurs minutes."
    Write-Host ""
    Info "Rien a faire : le site passera Actif tout seul dans l'interface."
    Info "Pour suivre en direct :  cd `"$Dest`" ; node src\agent\agent.js"
  }
  "jeton" {
    Rouge "Jeton refuse par la plateforme (403)."
    Info "Le jeton du site a probablement ete regenere depuis l'interface."
    Info "Recuperez le nouveau : Sites -> le site -> Mettre en service l'agent."
    exit 1
  }
  "route" {
    Rouge "La plateforme repond, mais /agent/ping est introuvable (404)."
    Info "L'URL pointe peut-etre a cote : elle doit se terminer par /api"
    Info "  actuellement : $Url"
    Info "Ou le serveur central est plus ancien que cet agent."
    exit 1
  }
  "erreur" {
    Rouge "La plateforme repond en erreur ($detail)."
    Info "Regardez la console du serveur central : la cause y est journalisee."
    exit 1
  }
  default {
    Rouge "Plateforme injoignable depuis cette machine."
    Info "Aucune reponse de $Url/agent/ping. Causes frequentes :"
    Info "  - URL incorrecte (elle doit se terminer par /api)"
    Info "  - serveur central arrete"
    Info "  - pare-feu bloquant la sortie"
    Write-Host ""
    Info "Test direct :  Invoke-RestMethod -Uri `"$Url/sites`" -Method Get"
    exit 1
  }
}

Write-Host ""
Write-Host "Commandes utiles :"
Write-Host "  Get-ScheduledTask $Tache          etat de la tache"
Write-Host "  Start-ScheduledTask $Tache          relancer"
Write-Host "  cd `"$Dest`" ; node src\agent\agent.js   execution manuelle (journal a l'ecran)"