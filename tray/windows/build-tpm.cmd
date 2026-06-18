@echo off
rem Build Tpm.exe — the TPM vault helper used by the bridge `tpm` vault facet (secret recovery, §21).
rem In-box .NET Framework compiler (csc) + the OS WinRT metadata (for the Windows Hello prompt). Needs
rem .NET Framework 4.x. C# 5 source. No (...) command-grouping blocks (a "(x86)" path would break the parser).
setlocal
set "DIR=%~dp0"
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" echo Could not find csc.exe (.NET Framework 4.x required). & exit /b 1

set "PF=%ProgramFiles(x86)%"
set "RA=%PF%\Reference Assemblies\Microsoft\Framework\.NETFramework"
set "FACADE="
if exist "%RA%\v4.8.1\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.8.1\Facades\System.Runtime.dll"
if not defined FACADE if exist "%RA%\v4.8\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.8\Facades\System.Runtime.dll"
if not defined FACADE if exist "%RA%\v4.7.2\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.7.2\Facades\System.Runtime.dll"
if not defined FACADE if exist "%RA%\v4.7.1\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.7.1\Facades\System.Runtime.dll"
if not defined FACADE if exist "%RA%\v4.7\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.7\Facades\System.Runtime.dll"
if not defined FACADE if exist "%RA%\v4.6.2\Facades\System.Runtime.dll" set "FACADE=%RA%\v4.6.2\Facades\System.Runtime.dll"
if not defined FACADE echo Could not find the System.Runtime facade (.NET Framework 4.6+ reference assemblies). & exit /b 1

set "WINRT=%WINDIR%\Microsoft.NET\assembly\GAC_MSIL\System.Runtime.WindowsRuntime\v4.0_4.0.0.0__b77a5c561934e089\System.Runtime.WindowsRuntime.dll"
set "FOUND=%WINDIR%\System32\WinMetadata\Windows.Foundation.winmd"
set "SEC=%WINDIR%\System32\WinMetadata\Windows.Security.winmd"
if not exist "%FOUND%" echo Missing OS WinRT metadata (Windows.Foundation.winmd). & exit /b 1

"%CSC%" /nologo /target:exe /out:"%DIR%Tpm.exe" /r:System.Core.dll /r:"%FACADE%" /r:"%WINRT%" /r:"%FOUND%" /r:"%SEC%" "%DIR%Tpm.cs"
