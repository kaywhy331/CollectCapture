@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title CollectCapture HTTPS Launcher

set "SETTINGS_FILE=%~dp0.env.card-lookups.red-pc"
set "SETTINGS_TEMPLATE=%~dp0.env.card-lookups.red-pc.example"
set "LAUNCHER=%~dp0red-pc-card-lookups.cmd"
set "SETUP_GUIDE=%~dp0docs\red-pc-cloudflare-tunnel.md"

if not exist "%LAUNCHER%" goto MissingFiles
call :EnsureSettings
if errorlevel 1 goto SetupFailed

:Menu
cls
echo ============================================================
echo              CollectCapture HTTPS Launcher
echo ============================================================
echo.
echo Start options always include the secure Cloudflare Tunnel.
echo Groq is the recommended first test because it starts quickly.
echo.
echo   1. Start with Groq Cloud
echo   2. Start with Ollama Cloud
echo   3. Start with local Ollama + NVIDIA GPU
echo   4. Start with local Ollama on CPU
echo   5. Show container status
echo   6. Follow logs ^(press Ctrl+C to stop following^)
echo   7. Stop CollectCapture and its tunnel
echo   8. Edit private settings
echo   9. Open the HTTPS setup guide
echo   0. Exit
echo.
choice /C 1234567890 /N /M "Choose an option: "

if errorlevel 10 goto End
if errorlevel 9 goto OpenGuide
if errorlevel 8 goto EditSettings
if errorlevel 7 goto StopStack
if errorlevel 6 goto ShowLogs
if errorlevel 5 goto ShowStatus
if errorlevel 4 goto StartCpu
if errorlevel 3 goto StartNvidia
if errorlevel 2 goto StartOllamaCloud
if errorlevel 1 goto StartGroq
goto Menu

:StartGroq
call :StartStack -Provider Groq -Tunnel
goto Menu

:StartOllamaCloud
call :StartStack -Provider OllamaCloud -Tunnel
goto Menu

:StartNvidia
call :StartStack -Provider OllamaLocal -Nvidia -Tunnel
goto Menu

:StartCpu
call :StartStack -Provider OllamaLocal -Tunnel
goto Menu

:ShowStatus
call :RunLauncher -Action Status -Provider Groq -Tunnel
pause
goto Menu

:ShowLogs
echo.
echo Press Ctrl+C when you are finished viewing logs.
call :RunLauncher -Action Logs -Provider Groq -Tunnel
pause
goto Menu

:StopStack
echo.
echo Stopping the API, model services, and tunnel...
rem Omit -Tunnel so rollback still works if the token was removed or revoked.
call :RunLauncher -Action Down -Provider Groq
pause
goto Menu

:EditSettings
start "" /wait notepad.exe "%SETTINGS_FILE%"
goto Menu

:OpenGuide
if not exist "%SETUP_GUIDE%" goto MissingFiles
start "" notepad.exe "%SETUP_GUIDE%"
goto Menu

:StartStack
echo.
echo Building and starting CollectCapture. The first start may take a while...
call :RunLauncher %*
if errorlevel 1 goto StartFailed
echo.
echo CollectCapture is running. The public HTTPS URL is shown above.
echo Use option 5 for status or option 6 for logs.
pause
exit /b 0

:StartFailed
echo.
echo Start did not complete. Review the message above, then use option 8
echo to correct the private settings before trying again.
pause
exit /b 1

:RunLauncher
call "%LAUNCHER%" %*
if errorlevel 1 exit /b 1
exit /b 0

:EnsureSettings
if exist "%SETTINGS_FILE%" exit /b 0
if not exist "%SETTINGS_TEMPLATE%" exit /b 1
copy /Y "%SETTINGS_TEMPLATE%" "%SETTINGS_FILE%" >nul
if errorlevel 1 exit /b 1
cls
echo ============================================================
echo                 First-time setup
echo ============================================================
echo.
echo A private settings file was created and will open in Notepad.
echo Follow its comments and fill in:
echo.
echo   - the CollectFolio connection values;
echo   - the API key for the cloud provider you plan to use;
echo   - the Cloudflare tunnel hostname and connector token.
echo.
echo Save and close Notepad to continue to the launcher menu.
echo This private file is ignored by Git.
echo.
pause
start "" /wait notepad.exe "%SETTINGS_FILE%"
exit /b 0

:MissingFiles
echo.
echo Required CollectCapture launcher files are missing.
echo Keep START-COLLECTCAPTURE-HTTPS.cmd in the CollectCapture repository root.
pause
exit /b 1

:SetupFailed
echo.
echo The private settings file could not be created.
echo Verify this folder is writable, then try again.
pause
exit /b 1

:End
exit /b 0
