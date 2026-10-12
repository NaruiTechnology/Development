[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

# Docker runs Linux containers without provisioning an interactive Ubuntu user.
$restartRequired = $false
foreach ($featureName in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $featureName
    if ($feature.State -eq 'EnablePending') {
        $restartRequired = $true
    } elseif ($feature.State -ne 'Enabled') {
        Write-Host "Enabling Docker prerequisite: $featureName"
        $result = Enable-WindowsOptionalFeature -Online -FeatureName $featureName -All -NoRestart
        if ($result.RestartNeeded) { $restartRequired = $true }
    }
}
if ($restartRequired) {
    Write-Host 'Docker prerequisites were enabled. Restart Windows, then rerun OneKeyDeploy.bat. No reboot was initiated.'
    exit 3010
}

$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$minimumVersion = [version]'2.1.5'
$script:lastWslOutput = ''
$script:lastWslExitCode = 0
function Get-WslVersion {
    # Native WSL output can contain UTF-16 NULs when redirected by PowerShell.
    $previousErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = (& $wsl --version 2>&1 | Out-String) -replace "`0", ''
        $script:lastWslExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    $script:lastWslOutput = $output.Trim()
    if ($script:lastWslExitCode -eq 0 -and $output -match '(\d+\.\d+\.\d+(?:\.\d+)?)') {
        return [version]$Matches[1]
    }
    return $null
}
function Wait-WslVersion {
    param([int]$Attempts = 60)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $version = Get-WslVersion
        if ($null -ne $version) { return $version }
        if ($attempt -eq 0) {
            Write-Host 'Waiting for WSL runtime initialization or upgrade to finish...'
        }
        Start-Sleep -Seconds 2
    }
    return $null
}

$version = Get-WslVersion
if ($null -eq $version -and $script:lastWslOutput -match '(?i)upgrade|updat|progress') {
    $version = Wait-WslVersion
    if ($null -eq $version) {
        throw "WSL upgrade did not become ready. Exit code $script:lastWslExitCode. $script:lastWslOutput. Restart Windows and rerun OneKeyDeploy.bat. If it persists, WSL requires repair."
    }
}
if ($null -eq $version -or $version -lt $minimumVersion) {
    $winget = Get-Command winget.exe -ErrorAction Stop
    $operation = if ($null -eq $version) { 'install' } else { 'upgrade' }
    & $winget.Source $operation --id Microsoft.WSL --exact --silent --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
    if ($LASTEXITCODE -eq 3010) { exit 3010 }
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the WSL 2 runtime.' }
    $version = Wait-WslVersion
    if ($null -eq $version -or $version -lt $minimumVersion) {
        throw "WSL runtime is not ready after installation. Exit code $script:lastWslExitCode. $script:lastWslOutput. Restart Windows and rerun OneKeyDeploy.bat."
    }
}
# An adequate installed runtime must not be updated on every deployment.
Write-Host "Using WSL runtime $version"
& $wsl --set-default-version 2
if ($LASTEXITCODE -ne 0) { throw 'WSL 2 initialization failed. Check hardware virtualization or nested virtualization on a VM.' }
# Version and default-version queries can succeed while Windows components
# are unavailable to the WSL service. Check service readiness before proceeding.
$previousErrorAction = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $status = (& $wsl --status 2>&1 | Out-String) -replace "`0", ''
    $statusExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorAction
}
if ($statusExitCode -ne 0) {
    if ($status -match 'WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED') {
        Write-Host $status.Trim()
        Write-Host 'WSL Windows components are not available. Run wsl.exe --install --no-distribution in Administrator PowerShell, restart Windows, then rerun OneKeyDeploy.bat. No reboot was initiated.'
        exit 3010
    }
    throw "WSL service readiness check failed (exit $statusExitCode): $($status.Trim())"
}
Write-Host 'Docker WSL 2 prerequisites are ready.'
