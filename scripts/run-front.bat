@echo off
chcp 65001 >nul
title LeadScore Front :5175
cd /d "%~dp0.."

if not exist "node_modules" (
  echo [ERRO] node_modules nao encontrado. Rode o start.bat na raiz do projeto.
  pause
  exit /b 1
)

echo Iniciando o front em http://localhost:5175  (Ctrl+C para parar)
echo.
call npm run dev

echo.
echo O front foi encerrado.
pause
