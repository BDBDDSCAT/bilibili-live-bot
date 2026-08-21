@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\start.ps1" %*
if errorlevel 1 (
  echo.
  echo Start failed. See docs\WINDOWS.md for help.
  if not defined CI pause
  exit /b 1
)
