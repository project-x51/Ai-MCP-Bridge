@echo off
rem Build the tray if needed, then launch it. Extra args (e.g. --ephemeral --root <dir>) pass through.
setlocal
set DIR=%~dp0
if not exist "%DIR%AiMcpBridgeTray.exe" call "%DIR%build.cmd" || exit /b 1
start "" "%DIR%AiMcpBridgeTray.exe" %*
