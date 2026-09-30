@echo off
rem Reset the packaged Memmy's session state: onboarding progress, localStorage
rem (guidanceCompleted), the login session, and logs all live in %APPDATA%\Memmy.
rem Use this to re-run the first-run guidance (e.g. to verify onboarding changes).
rem
rem This is not a full reset, and the halves are not interchangeable. What it
rem leaves behind in %USERPROFILE%\.memmy — the model config and the workspace —
rem is the half the app reads to choose its first screen. So clearing this
rem directory alone gives a signed-out machine with its model config intact,
rem while clearing the model config alone, or clearing the two out of step,
rem leaves a machine that still holds a session and boots to the API-key page
rem instead of the login form. To start from a state as new as a fresh install,
rem run scripts\clear-all-windows.ps1, which clears both.

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
