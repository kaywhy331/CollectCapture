@echo off
setlocal EnableExtensions
title CollectCapture RED PC Installer

set "BOOTSTRAP_URL=https://raw.githubusercontent.com/kaywhy331/CollectCapture/refs/heads/agent/collectcapture-card-lookup/bootstrap-red-pc.ps1"
set "BOOTSTRAP_SHA256=0313e2d72b67bbd75234538f04dad3c4280e0b709b171b2760cc460be1ee1e73"

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
