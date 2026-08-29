[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DeployArguments)
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

if (-not (Get-Command python.exe -ErrorAction SilentlyContinue)) {
    winget install --exact --id Python.Python.3.12 `
      --accept-package-agreements --accept-source-agreements --silent
    Refresh-Path
}

Push-Location $ScriptDir
try {
    & python.exe 'distributionDeployApp-docker.py' @DeployArguments
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
