@echo off
chcp 65001 >nul
title LeadScore API :8787
cd /d "%~dp0.."

if not exist "node_modules\wrangler" (
  echo.
  echo [ERRO] O wrangler nao esta instalado neste projeto.
  echo.
  echo        Rode na raiz do projeto:   npm install
  echo.
  echo        Se o npm falhar com ENOTFOUND registry.npmjs.org, o problema e
  echo        rede/DNS da maquina - veja se ha VPN ou proxy corporativo ativo:
  echo            nslookup registry.npmjs.org
  echo            npm config get proxy
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\pg" (
  echo [ERRO] Falta a dependencia "pg". Rode: npm install
  pause
  exit /b 1
)

if not exist ".dev.vars" (
  echo [AVISO] .dev.vars nao encontrado - rode: npm run db:dev-vars
  echo.
)

REM O wrangler exige que a pasta de assets exista, mesmo em dev (quem serve o
REM front aqui e o Vite). Sem isto ele morre com "assets.directory does not exist".
if not exist "dist\index.html" (
  echo Gerando o dist/ pela primeira vez ...
  call npm run build
  if errorlevel 1 (
    echo.
    echo [ERRO] O build do front falhou - veja a mensagem acima.
    pause
    exit /b 1
  )
  echo.
)

echo Iniciando o Worker em http://localhost:8787  (Ctrl+C para parar)
echo.
REM usa o wrangler local (nao vai na rede buscar nada)
call node_modules\.bin\wrangler dev --port 8787

echo.
echo O Worker foi encerrado.
pause
