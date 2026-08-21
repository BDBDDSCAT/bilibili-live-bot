@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1" %*
if errorlevel 1 (
  echo.
  echo Setup failed. See docs\WINDOWS.md for help.
  if not defined CI pause
  exit /b 1
)
echo.
echo Setup completed.
if not defined CI pause
