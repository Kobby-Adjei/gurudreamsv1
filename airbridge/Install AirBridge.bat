@echo off
rem Double-click this file to set up AirBridge on your Windows PC.
setlocal
cd /d "%~dp0"
title Install AirBridge

rem Find a Python that is 3.11 or newer. The Python launcher (py) is preferred;
rem the Microsoft Store "python" shortcut fails the version check and is skipped.
set "PYTHON="
for %%V in (-3.13 -3.12 -3.11 -3) do call :try py %%V
if not defined PYTHON call :try python
if not defined PYTHON goto :nopython

%PYTHON% install.py %*
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%

:try
if defined PYTHON exit /b 0
%* -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 set "PYTHON=%*"
exit /b 0

:nopython
echo.
echo   AirBridge needs Python 3.11 or newer, and this PC doesn't have it yet.
echo.
echo   1. Download Python from https://www.python.org/downloads/
echo   2. Run the installer and tick "Add python.exe to PATH".
echo   3. Double-click Install AirBridge again.
echo.
echo   Press any key to open the download page, or close this window.
pause >nul
start "" "https://www.python.org/downloads/"
exit /b 1
