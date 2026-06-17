@echo off
rem Safe to run any time (no prompts): Tests 0-2 — TPM-backed encrypt/decrypt + the multi-machine envelope.
call build.cmd || exit /b 1
Probe.exe noninteractive
