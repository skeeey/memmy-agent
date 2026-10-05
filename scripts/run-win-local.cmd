@echo off
rem Start the packaged Memmy with the cuberouter settings for local testing.
rem Edit the values below, then double-click or run from cmd/PowerShell.
rem Both are commented out by default, so the packaged build's own defaults
rem apply: the shipped cn + hk line table — which is what makes the line picker
rem appear — and the shipped default model. Uncomment to override either.
rem The exe path is relative to this script, so it works wherever the repo lives.

rem The line table: id=url pairs; one entry means no line picker in the app.
rem set MEMMY_CUBEROUTER_URLS=cn=https://test.cuberouter.cn
rem Must be a model that really exists on the instance the line points at (K4 in the tracking doc).
rem set MEMMY_CUBEROUTER_MODEL=deepseek-v4.1-flash

start "" "%~dp0..\App\shell\desktop\release\win-unpacked\Memmy.exe"
