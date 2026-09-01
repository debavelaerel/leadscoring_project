@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Lead Score Vicio - parar

echo Encerrando o que estiver ouvindo nas portas 8787 e 5175 ...
set "ACHOU="
for %%P in (8787 5175) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /r /c:":%%P .*LISTENING" 2^>nul') do (
    echo   porta %%P - encerrando PID %%A
    taskkill /PID %%A /F >nul 2>&1
    set "ACHOU=1"
  )
)
if not defined ACHOU echo   nada rodando nessas portas.
echo.
echo Pronto.
timeout /t 3 >nul
