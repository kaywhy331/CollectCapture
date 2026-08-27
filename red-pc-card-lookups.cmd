@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\red-pc-card-lookups.ps1" %*
exit /b %ERRORLEVEL%
