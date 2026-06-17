@echo off
rem RUN THIS WHEN YOU ARE AT THE KEYBOARD. Test 3 pops a Windows security prompt (Hello / PIN) you must approve.
call build.cmd || exit /b 1
Probe.exe interactive
echo.
pause
