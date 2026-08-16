[CmdletBinding()]
param(
    [ValidateSet("install", "start", "restart", "stop", "status", "logs")]
    [string]$Operation = "restart"
)

$manager = Join-Path $PSScriptRoot "manage-local-system.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $manager $Operation
exit $LASTEXITCODE
