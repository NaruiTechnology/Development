[CmdletBinding()]
param(
    [string]$Venv,
    [switch]$SkipPip,
    [switch]$SkipSmoke,
    [switch]$NoDesktopEntry
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$developmentRoot = Split-Path -Parent $appRoot
if (-not $Venv) { $Venv = Join-Path (Split-Path -Parent $developmentRoot) '.venv' }
$python = Join-Path $Venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Virtual environment missing: $python" }
if (-not $SkipPip) {
    & $python -m pip install -r (Join-Path $appRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Native client dependency installation failed.' }
}
$env:PYTHONPATH = "$appRoot;$developmentRoot;$(Join-Path $developmentRoot 'glasgow_service');$env:PYTHONPATH"
$env:IONBEAM_DEVELOPMENT_ROOT = $developmentRoot
& $python -c 'import ionbeam_native.engine.engine; import ionbeam_native.ui.main_window'
if ($LASTEXITCODE -ne 0) { throw 'Native client import check failed.' }
$launcher = Join-Path $appRoot 'start-native.ps1'
$template = @'
$env:IONBEAM_DEVELOPMENT_ROOT = '__DEVELOPMENT__'
$env:PYTHONPATH = '__APP__;__DEVELOPMENT__;__DEVELOPMENT__\glasgow_service;' + $env:PYTHONPATH
& '__PYTHON__' -m ionbeam_native @args
exit $LASTEXITCODE
'@
$template.Replace('__DEVELOPMENT__', $developmentRoot.Replace("'", "''")).Replace('__APP__', $appRoot.Replace("'", "''")).Replace('__PYTHON__', $python.Replace("'", "''")) | Set-Content -LiteralPath $launcher -Encoding UTF8
if (-not $NoDesktopEntry) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'Ion Beam (native).lnk'))
    $shortcut.TargetPath = (Get-Command powershell.exe).Source
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $shortcut.WorkingDirectory = $appRoot
    $shortcut.Save()
}
if (-not $SkipSmoke) {
    $smoke = Join-Path $PSScriptRoot 'smoke.py'
    if (-not (Test-Path -LiteralPath $smoke)) { $smoke += 'c' }
    & $python $smoke --seconds 5
    if ($LASTEXITCODE -ne 0) { throw 'Native client emulator smoke test failed.' }
}
Write-Output "Native client installed. Launcher: $launcher"
