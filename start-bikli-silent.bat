@echo off
REM ===========================================================================
REM BIKLI — Silent Auto-Start Launcher
REM ===========================================================================
REM Invoked by the Windows "Run" registry key (HKCU\...\Run\Bikli) on login.
REM Starts the desktop agent + Node server silently and opens the UI tab.
REM Prefers frozen bikli-agent.exe so a system Python install is not required.
REM ===========================================================================

setlocal
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

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
        goto :pyfound
    )
)
:pyfound

REM --- 1. Clear any stale processes on our ports (silent) ---------------------
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING" 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)

REM --- 2. Start the Desktop Control Agent (port 8765) -------------------------
if exist "%AGENT_EXE%" (
    start "" /B "%AGENT_EXE%"
) else if defined PYTHON_EXE (
    start "" /B "%PYTHON_EXE%" -m uvicorn desktop_agent.main:app --host 127.0.0.1 --port 8765 > nul 2>&1
) else (
    REM No agent runtime — continue; Node may still serve the UI.
    rem
)

timeout /t 3 /nobreak >nul

REM --- 3. Start the BIKLI web server (Node, port 3000) ------------------------
if exist "%PROJECT_DIR%dist\server.cjs" (
    start "" /B cmd /c "cd /d "%PROJECT_DIR%" && node dist\server.cjs > nul 2>&1"
) else (
    start "" /B cmd /c "cd /d "%PROJECT_DIR%" && npm run dev > nul 2>&1"
)

REM --- 4. Wait for the web server, then open the UI ---------------------------
for /l %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3000' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        start "" "http://localhost:3000"
        goto :done
    )
)
start "" "http://localhost:3000"

:done
endlocal
exit /b 0
