@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup-ai.ps1" %*
if errorlevel 1 (
  echo.
  echo AI setup needs attention. See docs\WINDOWS.md for help.
  if not defined CI pause
  exit /b 1
)
echo.
echo Qwen setup completed.
if not defined CI pause
