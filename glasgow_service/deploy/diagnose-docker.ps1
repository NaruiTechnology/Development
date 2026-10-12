[CmdletBinding()]
param([string]$OutputPath = (Join-Path $env:USERPROFILE 'Downloads\docker-init-diagnostics.log'))
$ErrorActionPreference = 'Continue'
"Docker initialization diagnostics $(Get-Date -Format o)" | Set-Content -LiteralPath $OutputPath -Encoding UTF8
function Record {
    param([string]$Title, $Value)
    "`r`n=== $Title ===" | Add-Content -LiteralPath $OutputPath -Encoding UTF8
    ($Value | Out-String) -replace "`0", '' | Add-Content -LiteralPath $OutputPath -Encoding UTF8
}
function Query-Native {
    param([string]$Executable, [string]$Arguments)
    if (-not (Test-Path -LiteralPath $Executable)) { return "Not found: $Executable" }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill() # only this read-only diagnostic command
            $process.WaitForExit()
            return "Timed out after 10 seconds. $($stdout.Result) $($stderr.Result)"
        }
        return "Exit code $($process.ExitCode)`r`n$($stdout.Result)`r`n$($stderr.Result)"
    } catch { return $_.Exception.Message }
    finally { $process.Dispose() }
}
Record 'Windows' (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
Record 'Machine and hypervisor' (Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, HypervisorPresent)
Record 'CPU virtualization' (Get-CimInstance Win32_Processor | Select-Object VirtualizationFirmwareEnabled, VMMonitorModeExtensions, SecondLevelAddressTranslationExtensions)
Record 'Windows optional features' (@('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux') | ForEach-Object {
    Get-WindowsOptionalFeature -Online -FeatureName $_ | Select-Object FeatureName, State
})
Record 'Docker and WSL services' (Get-Service -Name 'com.docker.service', 'WslService', 'LxssManager', 'vmcompute' -ErrorAction SilentlyContinue | Select-Object Name, Status, StartType)
Record 'Docker processes' (Get-Process -Name 'Docker Desktop', 'com.docker.backend' -ErrorAction SilentlyContinue | Select-Object Name, Id, StartTime)
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
Record 'WSL version' (Query-Native $wsl '--version')
Record 'WSL status' (Query-Native $wsl '--status')
Record 'WSL distributions' (Query-Native $wsl '--list --verbose')
$docker = (Get-Command docker.exe -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }
Record 'Docker Desktop status' (Query-Native $docker 'desktop status')
Record 'Docker version' (Query-Native $docker 'version')
Record 'Docker engine endpoint overrides' (@('DOCKER_HOST', 'DOCKER_CONTEXT') | ForEach-Object {
    "$_=$([Environment]::GetEnvironmentVariable($_))"
})
$hostLogs = Join-Path $env:LOCALAPPDATA 'Docker\log\host'
Get-ChildItem -LiteralPath $hostLogs -Filter '*backend*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 2 | ForEach-Object {
        $errors = Get-Content -LiteralPath $_.FullName -Tail 300 |
            Where-Object { $_ -match '(?i)error|fatal|failed|virtualization|WSL' } |
            ForEach-Object { if ($_ -match '(?i)password|token|authorization|credential') { '[sensitive diagnostic line omitted]' } else { $_ } }
        Record "Docker backend errors: $($_.Name)" $errors
    }
Write-Host "Read-only diagnostics saved to $OutputPath"
