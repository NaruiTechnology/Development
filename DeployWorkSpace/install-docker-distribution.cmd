@echo off
setlocal
set "PACKAGE_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PACKAGE_ROOT%install-docker-distribution.ps1" %*
exit /b %ERRORLEVEL%
