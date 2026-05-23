$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$backendDir = if ($env:IONBEAM_BACKEND_DIR) { $env:IONBEAM_BACKEND_DIR } else { Join-Path $repoRoot "ionbeam-web\backend" }
$startCmd = if ($env:IONBEAM_BACKEND_START_CMD) { $env:IONBEAM_BACKEND_START_CMD } else { "npm.cmd run dev" }
$logFile = if ($env:IONBEAM_BACKEND_LOG) { $env:IONBEAM_BACKEND_LOG } else { Join-Path $env:TEMP "ionbeam-backend.log" }
$pidFile = if ($env:IONBEAM_BACKEND_PID) { $env:IONBEAM_BACKEND_PID } else { Join-Path $env:TEMP "ionbeam-backend.pid" }

foreach ($path in @($logFile, $pidFile)) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

function Get-ChildProcessIds {
    param([int]$ParentId)

    try {
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" |
            ForEach-Object {
                [int]$_.ProcessId
                Get-ChildProcessIds -ParentId ([int]$_.ProcessId)
            }
    } catch {
        @()
    }
}

function Stop-ExistingBackend {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return
    }

    $rawPid = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $rawPid -or $rawPid -notmatch "^\d+$") {
        return
    }

    $oldPid = [int]$rawPid
    if ($oldPid -eq $PID) {
        return
    }

    $ids = @($oldPid) + @(Get-ChildProcessIds -ParentId $oldPid)
    $ids |
        Sort-Object -Descending |
        ForEach-Object {
            Stop-Process -Id $_ -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 500

    $ids |
        Sort-Object -Descending |
        ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
}

function Start-Backend {
    if (-not (Test-Path -LiteralPath $backendDir)) {
        throw "backend directory not found: $backendDir"
    }

    $commandLine = 'cd /d "{0}" && {1} >> "{2}" 2>&1' -f `
        $backendDir.Replace('"', '\"'), $startCmd, $logFile.Replace('"', '\"')

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "cmd.exe"
    $startInfo.Arguments = "/d /c $commandLine"
    $startInfo.WorkingDirectory = $backendDir
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    $process = [System.Diagnostics.Process]::Start($startInfo)
    Set-Content -LiteralPath $pidFile -Value $process.Id
    return $process
}

Stop-ExistingBackend
$process = Start-Backend

Write-Output "started ionbeam-web backend ($startCmd) in $backendDir; pid $($process.Id), log $logFile"
