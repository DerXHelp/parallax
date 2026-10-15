@echo off
rem Parallax launcher without installation (Plan "Server-Betrieb", WP-21): builds dist\ if needed,
rem starts the server hidden in the background and opens an Edge app window - or, if Parallax
rem already runs, only another window. Options: parallax.cmd --help (details: README "Starten").
setlocal
rem Never pick up programs from the current directory (cmd searches it before the PATH).
set "NoDefaultCurrentDirectoryInExePath=1"
set "PARALLAX_ROOT=%~dp0"
set "PARALLAX_TSX=%PARALLAX_ROOT%node_modules\tsx\dist\cli.mjs"
if not exist "%PARALLAX_TSX%" goto nodeps
"%SystemRoot%\System32\where.exe" node >nul 2>nul
if errorlevel 1 goto nonode
node "%PARALLAX_TSX%" --tsconfig "%PARALLAX_ROOT%src\server\tsconfig.json" "%PARALLAX_ROOT%src\server\launcher\main.ts" %*
if errorlevel 1 goto failed
exit /b 0

:nodeps
echo Parallax: dependencies are missing - run "pnpm install" in the Parallax folder first.
goto failed

:nonode
echo Parallax: Node.js was not found on the PATH - install Node.js 22 or newer.
goto failed

:failed
set "PARALLAX_EXIT=%errorlevel%"
if "%PARALLAX_EXIT%"=="0" set "PARALLAX_EXIT=1"
rem Keep a double-clicked window open so the message can be read (PARALLAX_NO_PAUSE=1 skips it).
if not defined PARALLAX_NO_PAUSE pause
exit /b %PARALLAX_EXIT%
