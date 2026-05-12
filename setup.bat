@echo off
setlocal EnableDelayedExpansion
SET "PORTABLE_ROOT=%~dp0"
SET "PORTABLE_ROOT=%PORTABLE_ROOT:~0,-1%"

echo ============================================
echo  Claude Portable - Ersteinrichtung
echo ============================================
echo.

:: ---- 1. Portable Node.js ----
echo [1/5] Portable Node.js installieren...
SET "NODE_DIR=%PORTABLE_ROOT%\bin\node"
SET "NODE_ZIP=%PORTABLE_ROOT%\bin\node-portable.zip"

IF NOT EXIST "%NODE_DIR%\node.exe" (
    echo Lade Node.js 22 LTS herunter ^(ca. 18 MB^)...
    powershell -Command "$v=''; foreach($i in (Invoke-RestMethod 'https://nodejs.org/dist/index.json')){if($i.lts -and $i.version -like 'v22*'){$v=$i.version;break}}; if(-not $v){Write-Error 'v22 LTS not found';exit 1}; $url='https://nodejs.org/dist/'+$v+'/node-'+$v+'-win-x64.zip'; Write-Host('Lade '+$url+' ...'); Invoke-WebRequest -Uri $url -OutFile '%NODE_ZIP%' -UseBasicParsing"
    IF ERRORLEVEL 1 ( echo FEHLER: Download fehlgeschlagen. Internetverbindung pruefen. & pause & exit /b 1 )
    echo Entpacke...
    powershell -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%PORTABLE_ROOT%\bin\_nodetemp' -Force"
    FOR /D %%D IN ("%PORTABLE_ROOT%\bin\_nodetemp\node-*") DO (
        move "%%D" "%NODE_DIR%"
    )
    rmdir /S /Q "%PORTABLE_ROOT%\bin\_nodetemp" 2>nul
    del "%NODE_ZIP%" 2>nul
    echo Node.js bereit: %NODE_DIR%
) ELSE (
    echo Node.js bereits vorhanden.
)

:: ---- 2. npm globals installieren ----
echo.
echo [2/5] npm-Pakete installieren (claude-flow, ruflo, github-mcp)...
SET "PATH=%NODE_DIR%;%PATH%"
SET "NPM_CONFIG_PREFIX=%NODE_DIR%"
call "%NODE_DIR%\npm.cmd" install -g @claude-flow/cli@latest ruflo @modelcontextprotocol/server-github
IF ERRORLEVEL 1 (
    echo WARNUNG: npm install mit Fehlern. Bitte Ausgabe pruefen.
) ELSE (
    echo npm-Pakete installiert.
)

:: ---- 3. Claude-Binary kopieren ----
echo.
echo [3/5] Claude-Binary kopieren...
SET "CLAUDE_SRC=%USERPROFILE%\.local\bin\claude.exe"
SET "CLAUDE_DST=%PORTABLE_ROOT%\bin\claude.exe"
IF EXIST "%CLAUDE_SRC%" (
    copy /Y "%CLAUDE_SRC%" "%CLAUDE_DST%"
    echo Claude-Binary kopiert ^(ca. 216 MB^).
) ELSE (
    echo FEHLER: %CLAUDE_SRC% nicht gefunden.
    echo Bitte manuell: copy "%USERPROFILE%\.local\bin\claude" "%CLAUDE_DST%"
)

:: ---- 4. API-Key verschluesseln ----
echo.
echo [4/5] API-Key verschluesseln...
IF EXIST "%PORTABLE_ROOT%\.key" (
    echo .key bereits vorhanden. Zum Neuerstellen loeschen und setup.bat erneut ausfuehren.
) ELSE (
    IF NOT EXIST "%NODE_DIR%\node.exe" (
        echo FEHLER: node.exe nicht gefunden. Node.js-Download in Schritt 1 pruefen.
    ) ELSE (
        "%NODE_DIR%\node.exe" "%PORTABLE_ROOT%\bin\encrypt.js" "%PORTABLE_ROOT%\.key"
        IF ERRORLEVEL 1 ( echo FEHLER: Verschluesselung fehlgeschlagen. )
    )
)

:: ---- 5. Vault-Git initialisieren ----
echo.
echo [5/5] Vault-Git einrichten...
SET "VAULT_DIR=%PORTABLE_ROOT%\vault"
IF NOT EXIST "%VAULT_DIR%\.git" (
    git -C "%VAULT_DIR%" init
    echo.
    SET /P VAULT_REMOTE=GitHub-URL des privaten Vault-Repos ^(leer = spaeter setzen^):
    IF NOT "!VAULT_REMOTE!"=="" (
        git -C "%VAULT_DIR%" remote add origin "!VAULT_REMOTE!"
        echo Remote gesetzt: !VAULT_REMOTE!
    ) ELSE (
        echo Remote nicht gesetzt. Spaeter: git -C vault remote add origin ^<url^>
    )
) ELSE (
    echo Vault-Git bereits vorhanden.
)

echo.
echo ============================================
echo  Einrichtung abgeschlossen!
echo  Starten: start.bat
echo ============================================
pause
endlocal
