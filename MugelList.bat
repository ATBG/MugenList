@echo off
setlocal enabledelayedexpansion

:: ===================================================================
:: MugelList Unified Launcher
:: ===================================================================

title MugelList — Streaming Engine
color 0b

:: ANSI Escape Sequence Trick
for /F "tokens=1,2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"

echo.
echo    %ESC%[95m__  __                      _      _     _    %ESC%[0m
echo    %ESC%[95m^|  \/  ^|_   _  __ _  ___^| ^|    (_)___^| ^|_  %ESC%[0m
echo    %ESC%[94m^| ^|/^\^| ^| ^| ^| ^|/ _` ^|/ _ \ ^|    ^| / __^| __^| %ESC%[0m
echo    %ESC%[94m^| ^|  ^| ^| ^|_^| ^| (_^| ^|  __/ ^|___ ^| ^\__ \ ^|_  %ESC%[0m
echo    %ESC%[96m^|_^|  ^|_^|\__,_^|\__, ^|\___^|_____^| ^|_^|___/\__^| %ESC%[0m
echo    %ESC%[96m              ^|___/           ^|__/         %ESC%[0m
echo.
echo    %ESC%[90m────────────────────────────────────────────── %ESC%[0m
echo    %ESC%[97m  MugelList Streaming Engine ^| v2.2.1 %ESC%[0m
echo    %ESC%[90m────────────────────────────────────────────── %ESC%[0m
echo.

:: Resolve project root
pushd "%~dp0"

:: 1. Environment Check
echo  %ESC%[90m[ %ESC%[94m1/4 %ESC%[90m] %ESC%[0m Checking Environment...
if exist .venv\Scripts\python.exe (
    set PYTHON=.venv\Scripts\python.exe
    echo       %ESC%[32m^> %ESC%[0m Using virtual environment Python.
) else (
    set PYTHON=python
    echo       %ESC%[33m! %ESC%[0m No .venv found - using system Python.
)

:: 2. Dependency Validation
echo  %ESC%[90m[ %ESC%[94m2/4 %ESC%[90m] %ESC%[0m Validating Dependencies...
%PYTHON% -c "import flask, flask_cors, requests" 2>nul
if errorlevel 1 (
    echo       %ESC%[33m! %ESC%[0m Missing dependencies. Installing...
    %PYTHON% -m pip install -r requirements.txt --quiet
    if errorlevel 1 (
        echo       %ESC%[31mX %ESC%[0m Failed to install dependencies.
        pause
        exit /b 1
    )
    echo       %ESC%[32m^> %ESC%[0m Dependencies updated.
) else (
    echo       %ESC%[32m^> %ESC%[0m All required packages found.
)

:: 3. Backend Launch
set MUGELLIST_PORT=8000
echo  %ESC%[90m[ %ESC%[94m3/4 %ESC%[90m] %ESC%[0m Starting Unified Backend...

:: Check if port is busy
netstat -ano | findstr :%MUGELLIST_PORT% | findstr LISTENING > nul
if not errorlevel 1 (
    echo       %ESC%[31m! %ESC%[0m CRITICAL: Port %MUGELLIST_PORT% is already in use.
    echo       %ESC%[90m      Please close any existing "MugelList Backend" windows first. %ESC%[0m
    echo.
    echo    %ESC%[90mPress any key to retry or close... %ESC%[0m
    pause > nul
    goto :start_backend
)

:start_backend
:: Start the backend with /K to keep window open on crash
start "MugelList Backend" cmd /k "%PYTHON% scripts/backend.py"
echo       %ESC%[32m^> %ESC%[0m Server initiated on http://localhost:%MUGELLIST_PORT%

:: 4. Frontend Activation
echo  %ESC%[90m[ %ESC%[94m4/4 %ESC%[90m] %ESC%[0m Opening Web Interface...
timeout /t 2 /nobreak > nul
start http://localhost:%MUGELLIST_PORT%

echo.
echo    %ESC%[92mSUCCESS: %ESC%[0m MugelList is now active.
echo    %ESC%[90mKeep this window open or close it after use. %ESC%[0m
echo.
echo    %ESC%[90mPress any key to exit launcher... %ESC%[0m
popd
pause > nul
