@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp01_CONNECT_AND_PUSH_STAGING.ps1"
if errorlevel 1 (
  echo.
  echo The script stopped with an error. Take a screenshot of this window.
)
pause
