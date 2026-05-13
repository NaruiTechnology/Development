@echo off
setlocal
title IobeamTech One-Key Deploy

cd /d "%~dp0"
set "APP=%~dp0Development\DistributionDeploy\distributionDeployApp.py"
set "CONFIG=%~dp0Development\DistributionDeploy\Json\DistributionDeploy.json"
set "BUILDER_PYTHON=C:\Project\IobeamTech\Development\.venv\Scripts\python.exe"

if not exist "%APP%" (
    echo Deploy entrypoint not found:
    echo   "%APP%"
    pause
    exit /b 1
)

if not exist "%CONFIG%" (
    echo Deploy config not found:
    echo   "%CONFIG%"
    pause
    exit /b 1
)

if exist "%~dp0.venv\Scripts\python.exe" (
    set "PYTHON=%~dp0.venv\Scripts\python.exe"
    goto run_deploy
)

if exist "%BUILDER_PYTHON%" (
    set "PYTHON=%BUILDER_PYTHON%"
    goto run_deploy
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    py -3 "%APP%" -j "%CONFIG%" %*
    set "DEPLOY_EXIT=%ERRORLEVEL%"
    goto done
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    python "%APP%" -j "%CONFIG%" %*
    set "DEPLOY_EXIT=%ERRORLEVEL%"
    goto done
)

echo Python was not found on PATH. Install Python 3 or run from a shell that has Python available.
pause
exit /b 1

:run_deploy
"%PYTHON%" "%APP%" -j "%CONFIG%" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"

:done
echo.
if "%DEPLOY_EXIT%"=="0" (
    echo Deploy workflow completed successfully.
) else (
    echo Deploy workflow failed with exit code %DEPLOY_EXIT%.
)
pause
exit /b %DEPLOY_EXIT%
