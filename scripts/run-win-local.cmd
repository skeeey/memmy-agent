@echo off
rem Start the packaged Memmy with the cuberouter settings for local testing.
rem Edit the values below, then double-click or run from cmd/PowerShell.
rem The line table: id=url pairs; one entry means no line picker in the app.
rem The exe path is relative to this script, so it works wherever the repo lives.

set MEMMY_CUBEROUTER_URLS=cn=https://test.cuberouter.cn
rem Must be a model that really exists on the instance above (K4 in the tracking doc).
set MEMMY_CUBEROUTER_MODEL=kimi-k3-a

start "" "%~dp0..\App\shell\desktop\release\win-unpacked\Memmy.exe"
