@echo off
rem ============================================================
rem  Inventaire du poste - NetSecureManager
rem
rem  A placer DANS LE MEME DOSSIER que le fichier
rem  inventaire-poste-site-1.ps1 telecharge depuis la plateforme.
rem
rem  La personne n'a qu'a double-cliquer sur ce fichier.
rem  Aucun droit administrateur n'est necessaire, rien n'est
rem  installe, la fenetre se ferme apres quelques secondes.
rem ============================================================
setlocal
cd /d "%~dp0"

set "SCRIPT="
for %%f in (inventaire-poste*.ps1) do set "SCRIPT=%%f"

if not defined SCRIPT (
  echo.
  echo   Fichier inventaire-poste....ps1 introuvable dans ce dossier.
  echo   Placez ce .bat a cote du script telecharge, puis relancez.
  echo.
  pause
  exit /b 1
)

echo.
echo   Lecture de ce qui tourne sur cette machine...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
echo   Termine. Vous pouvez fermer cette fenetre.
echo.
pause
