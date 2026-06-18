@echo off
rem Build the tray if the exe is missing OR older than the source, then launch it.
rem (Extra args, e.g. --ephemeral --root <dir>, pass through.)
setlocal enabledelayedexpansion
set DIR=%~dp0
set EXE=%DIR%AiMcpBridgeTray.exe
set SRC=%DIR%AiMcpBridgeTray.cs
set BUILD=
if not exist "%EXE%" set BUILD=1
if not defined BUILD (
  rem newest-first listing: if the source sorts first, it's newer than the exe -> rebuild
  for /f "delims=" %%i in ('dir /b /o-d "%SRC%" "%EXE%" 2^>nul') do if not defined NEWEST set NEWEST=%%i
  if /i "!NEWEST!"=="AiMcpBridgeTray.cs" set BUILD=1
)
if defined BUILD call "%DIR%build.cmd" || exit /b 1
start "" "%EXE%" %*
