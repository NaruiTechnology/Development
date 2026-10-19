@echo off
setlocal
title IobeamTech One-Key Deploy
cd /d "%~dp0"
echo Running one-key deploy from: %~dp0

set "APP=%~dp0Development\DistributionDeploy\distributionDeployApp.py"
set "CONFIG=%~dp0Development\DistributionDeploy\Json\DistributionDeploy.json"
if not exist "%APP%" goto missing_files
if not exist "%CONFIG%" goto missing_files

set "PYTHON="
set "PYTHON_ARGS="
call :try_python "%~dp0.venv\Scripts\python.exe" ""
for /f "delims=" %%P in ('where py.exe 2^>nul') do call :try_python "%%P" "-3"
for /f "delims=" %%P in ('where python.exe 2^>nul') do call :try_python "%%P" ""
if defined PYTHON goto run_deploy
echo No working Python 3 interpreter was found. Install Python 3 and add it to PATH.
pause
exit /b 1

:missing_files
echo Deployment entrypoint or configuration is missing:
echo   "%APP%"
echo   "%CONFIG%"
pause
exit /b 1

:run_deploy
echo Using Python: "%PYTHON%" %PYTHON_ARGS%
"%PYTHON%" %PYTHON_ARGS% "%APP%" -j "%CONFIG%" %*
set "DEPLOY_EXIT=%ERRORLEVEL%"
echo.
if "%DEPLOY_EXIT%"=="0" (
    echo Deploy workflow completed successfully.
) else (
    echo Deploy workflow failed with exit code %DEPLOY_EXIT%.
)
pause
exit /b %DEPLOY_EXIT%

:try_python
if defined PYTHON exit /b 0
if not exist "%~1" exit /b 0
"%~1" %~2 -c "import sys; sys.exit(0 if sys.version_info.major == 3 else 1)" >nul 2>nul
if errorlevel 1 exit /b 0
set "PYTHON=%~1"
set "PYTHON_ARGS=%~2"
exit /b 0
