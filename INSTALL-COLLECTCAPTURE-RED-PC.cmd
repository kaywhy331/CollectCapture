@echo off
setlocal EnableExtensions
title CollectCapture RED PC Installer

set "BOOTSTRAP_URL=https://raw.githubusercontent.com/kaywhy331/CollectCapture/refs/heads/main/bootstrap-red-pc.ps1"
set "BOOTSTRAP_SHA256=3e0c7fc4ffdcb834f960ac572d82fe1d7e57850d60dc4150e1ae6acdb21e4b00"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP 'CollectCapture-bootstrap.ps1'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest '%BOOTSTRAP_URL%' -OutFile $p -UseBasicParsing; if((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash -ne '%BOOTSTRAP_SHA256%'){throw 'CollectCapture bootstrap checksum mismatch.'}; & $p"
if errorlevel 1 (
  echo.
  echo CollectCapture setup did not complete. Review the message above.
  pause
  exit /b 1
)

echo.
echo CollectCapture setup completed successfully.
pause
