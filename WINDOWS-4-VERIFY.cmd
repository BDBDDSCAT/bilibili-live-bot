@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\verify-package.ps1" %*
if errorlevel 1 (
  echo.
  echo Package verification failed. Do not run this copy.
  if not defined CI pause
  exit /b 1
)
echo.
echo Package verification passed.
if not defined CI pause
