@echo off
rem Reset the packaged Memmy's local app data: onboarding state, localStorage
rem (guidanceCompleted), the login session, and logs all live in %APPDATA%\Memmy.
rem Use this to re-run the first-run guidance (e.g. to verify onboarding changes).
rem Does NOT touch %USERPROFILE%\.memmy — the model config and workspace stay.

choice /C YN /N /M "This closes Memmy and deletes %APPDATA%\Memmy. Continue? (Y/N)"
if errorlevel 2 exit /b 0

taskkill /F /IM Memmy.exe >nul 2>&1
rem Process teardown is asynchronous; give it a moment before deleting its files.
timeout /t 2 /nobreak >nul

if exist "%APPDATA%\Memmy" (
  rmdir /s /q "%APPDATA%\Memmy"
  echo Deleted %APPDATA%\Memmy
) else (
  echo Nothing to delete: %APPDATA%\Memmy does not exist
)

rem Keep the window open when double-clicked, so the outcome is visible.
pause
