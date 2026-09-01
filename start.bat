@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Lead Score Vicio - start
cd /d "%~dp0"

echo.
echo ==========================================================
echo   Lead Score Vicio - subindo o ambiente local
echo   API (Worker): http://localhost:8787
echo   Painel:       http://localhost:5175
echo ==========================================================
echo.

REM ---------------------------------------------------------------------- Node
node --version >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado no PATH.
  echo        Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
  goto :erro
)

REM ------------------------------------------------------------- dependencias
REM Nao basta a pasta node_modules existir: o projeto ganhou dependencias novas
REM (wrangler, pg). Checamos as que importam.
set "FALTA="
if not exist "%CD%\node_modules"          set "FALTA=1"
if not exist "%CD%\node_modules\wrangler" set "FALTA=1"
if not exist "%CD%\node_modules\pg"       set "FALTA=1"
if not exist "%CD%\node_modules\vite"     set "FALTA=1"

if defined FALTA (
  echo [1/3] Instalando dependencias que faltam ...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] O npm nao conseguiu instalar.
    echo        Se a mensagem acima fala em ENOTFOUND registry.npmjs.org, o
    echo        problema e rede/DNS desta maquina, nao o projeto. Cheque:
    echo            nslookup registry.npmjs.org
    echo            npm config get proxy
    echo            npm config get https-proxy
    echo        VPN ou proxy corporativo ligado costuma ser a causa.
    goto :erro
  )
) else (
  echo [1/3] dependencias ...... ok
)

REM -------------------------------------------------------------- .dev.vars ---
if not exist "%CD%\.dev.vars" (
  echo [2/3] .dev.vars nao existe - gerando a partir do .env ...
  call npm run db:dev-vars --silent
  if errorlevel 1 (
    echo       [AVISO] nao consegui gerar. Preencha o .dev.vars na mao
    echo               ^(copie do .dev.vars.example^).
  )
) else (
  findstr /r /c:"^DATABASE_URL=..*" "%CD%\.dev.vars" >nul
  if errorlevel 1 (
    echo [2/3] .dev.vars ......... [AVISO] DATABASE_URL vazia - rode: npm run db:dev-vars
  ) else (
    echo [2/3] .dev.vars ........ ok
  )
)

REM ------------------------------------------------------------------ dist ---
REM O wrangler valida a pasta de assets antes de subir, mesmo em dev.
if not exist "%CD%\dist\index.html" (
  echo       dist/ ainda nao existe - gerando ...
  call npm run build
  if errorlevel 1 goto :erro
)

REM ------------------------------------------------------- sobe os servicos ---
set "API_UP="
set "WEB_UP="
for /f "tokens=*" %%A in ('netstat -ano ^| findstr /r /c:":8787 .*LISTENING" 2^>nul') do set "API_UP=1"
for /f "tokens=*" %%A in ('netstat -ano ^| findstr /r /c:":5175 .*LISTENING" 2^>nul') do set "WEB_UP=1"

if defined API_UP (
  echo [3/3] porta 8787 ja ocupada - reaproveitando o Worker que ja esta no ar.
) else (
  echo [3/3] Abrindo a janela do Worker ...
  start "LeadScore API :8787" cmd /k call "%CD%\scripts\run-api.bat"
)
if defined WEB_UP (
  echo       porta 5175 ja ocupada - reaproveitando o front que ja esta no ar.
) else (
  echo       Abrindo a janela do front ...
  start "LeadScore Front :5175" cmd /k call "%CD%\scripts\run-front.bat"
)

echo.
echo Aguardando a API responder ...
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$r=Invoke-WebRequest -UseBasicParsing 'http://localhost:8787/api/health' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}}catch{}; Start-Sleep -Milliseconds 500}; exit 1"
if errorlevel 1 (
  echo [AVISO] O Worker nao respondeu em 45s.
  echo         Olhe a janela "LeadScore API :8787" - o erro esta la.
) else (
  echo API no ar em http://localhost:8787
)

echo Aguardando o front ...
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{$r=Invoke-WebRequest -UseBasicParsing 'http://localhost:5175' -TimeoutSec 2; if($r.StatusCode -eq 200){exit 0}}catch{}; Start-Sleep -Milliseconds 500}; exit 1"
if errorlevel 1 (
  echo [AVISO] O front nao respondeu em 30s. Olhe a janela "LeadScore Front :5175".
) else (
  start "" http://localhost:5175
)

echo.
echo ----------------------------------------------------------
echo   Painel:  http://localhost:5175
echo   API:     http://localhost:8787/api/health
echo   Parar:   parar.bat (ou feche as duas janelas)
echo ----------------------------------------------------------
echo.
timeout /t 8 >nul
exit /b 0

:erro
echo.
echo [FALHOU] Corrija o erro acima e rode start.bat de novo.
pause
exit /b 1
