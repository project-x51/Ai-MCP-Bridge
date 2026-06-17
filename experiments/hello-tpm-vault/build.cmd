@echo off
rem Compile the probe with the in-box .NET Framework C# compiler (same as the tray).
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
"%CSC%" /nologo /target:exe /out:Probe.exe /r:System.Core.dll Probe.cs
