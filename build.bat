@echo off
REM Build script for React Example App (Windows)
REM Creates Windows EXE installers and portable executables

echo.
echo ================================
echo React Example App Build Script (Windows)
echo ================================
echo.

REM Check if npm is installed
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: npm is not installed
    exit /b 1
)

REM Run the Windows build
echo Building for Windows (EXE)...
echo This will create .exe installer and portable executable
echo.

call npm run build-electron-win

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Build failed!
    exit /b 1
)

echo.
echo ╔════════════════════════════════╗
echo ║ Windows build complete!        ║
echo ╚════════════════════════════════╝
echo.
echo Outputs are in: dist-electron\
dir dist-electron\*.exe 2>nul
echo.
echo Build artifacts saved to: %cd%\dist-electron\
echo.
