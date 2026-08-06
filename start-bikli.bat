@echo off
chcp 65001 >nul
title BIKLI Launcher
color 0B

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

REM Prefer frozen agent (no system Python required), then PATH / LOCALAPPDATA Python.
set "AGENT_EXE=%PROJECT_DIR%agent_dist\bikli-agent\bikli-agent.exe"
if not exist "%AGENT_EXE%" set "AGENT_EXE=%PROJECT_DIR%agent_dist\bikli-agent.exe"
if defined BIKLI_AGENT_EXE if exist "%BIKLI_AGENT_EXE%" set "AGENT_EXE=%BIKLI_AGENT_EXE%"

set "PYTHON_EXE="
if defined BIKLI_PYTHON if exist "%BIKLI_PYTHON%" set "PYTHON_EXE=%BIKLI_PYTHON%"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if not defined PYTHON_EXE (
    for /f "delims=" %%P in ('where python 2^>nul') do (
        set "PYTHON_EXE=%%P"
        goto :py_ok
    )
)
:py_ok

echo ============================================================
echo                 BIKLI ALL-IN-ONE LAUNCHER
echo ============================================================
echo.

echo [1/4] Cleaning up any old instances...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 3000 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    echo     Killing stale process on port 8765 ^(PID %%a^)
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo     Done.
echo.

echo [2/4] Starting Desktop Control Agent ^(port 8765^)...
if exist "%AGENT_EXE%" (
    echo     Using frozen agent: %AGENT_EXE%
    start "BIKLI Desktop Agent" /MIN "%AGENT_EXE%"
) else if defined PYTHON_EXE (
    echo     Using Python: %PYTHON_EXE%
    start "BIKLI Desktop Agent" /MIN cmd /k "cd /d "%PROJECT_DIR%" && "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765"
) else (
    echo     [WARNING] No agent exe and no Python found.
    echo     Desktop control may be unavailable until the agent is built.
)
echo.

echo [3/4] Waiting for agent to be ready...
set "READY=0"
for /l %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8765/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        set "READY=1"
        echo     Desktop Agent is ONLINE.
        goto :agent_ready
    )
    echo     ...waiting %%i/15
)
:agent_ready
if "%READY%"=="0" (
    echo     [WARNING] Desktop Agent did not respond in time.
    echo     BIKLI will still run, but desktop control may be unavailable.
)
echo.

echo [4/4] Starting BIKLI Server ^(Node, port 3000^)...
echo ============================================================
echo   Desktop Agent : http://127.0.0.1:8765
echo   BIKLI UI      : http://localhost:3000
echo ============================================================
echo.
echo   Close this window to stop BIKLI.
echo   ^(Desktop Agent runs in its own minimized window.^)
echo.

cd /d "%PROJECT_DIR%"
call npm run dev

echo.
echo BIKLI has stopped. Cleaning up Desktop Agent...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
)
pause
