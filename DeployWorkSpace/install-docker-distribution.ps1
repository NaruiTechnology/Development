[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DeployArguments)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Installer = Join-Path $ScriptDir 'Development\DistributionDeploy\install-docker-distribution.ps1'
& $Installer @DeployArguments
exit $LASTEXITCODE
