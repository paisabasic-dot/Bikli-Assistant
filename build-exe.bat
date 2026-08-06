@echo off
cd /d "D:\Ass\Bikli"
echo ========================================
echo Building BIKLI EXE (Setup + Portable)
echo ========================================
echo.

echo [1/3] Vite build (frontend)...
call npx vite build
if %ERRORLEVEL% neq 0 (
    echo VITE BUILD FAILED
    pause
    exit /b %ERRORLEVEL%
)
echo OK
echo.

echo [2/3] esbuild server bundle...
call npx esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs
if %ERRORLEVEL% neq 0 (
    echo ESBUILD FAILED
    pause
    exit /b %ERRORLEVEL%
)
echo OK
echo.

echo [3/3] electron-builder (NSIS + Portable)...
call npx electron-builder --win nsis portable
if %ERRORLEVEL% neq 0 (
    echo ELECTRON-BUILDER FAILED
    pause
    exit /b %ERRORLEVEL%
)
echo.

echo ========================================
echo BUILD COMPLETE
echo ========================================
echo Setup:    release\BIKLI-Setup-1.0.1.exe
echo Portable: release\BIKLI-Portable-1.0.1.exe
echo.
pause
