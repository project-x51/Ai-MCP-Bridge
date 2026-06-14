@echo off
rem Build the tray exe with the in-box .NET Framework compiler (no SDK / runtime install needed).
setlocal
set DIR=%~dp0
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo Could not find the in-box C# compiler ^(csc.exe^). .NET Framework 4.x is required.
  exit /b 1
)
"%CSC%" /nologo /target:winexe /out:"%DIR%AiMcpBridgeTray.exe" ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Management.dll ^
  "%DIR%AiMcpBridgeTray.cs"
