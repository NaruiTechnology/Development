$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$projectRoot = if (Test-Path -LiteralPath (Join-Path $repoRoot "Development\glasgow_service")) {
    Join-Path $repoRoot "Development"
} else {
    $repoRoot
}
$workdir = if ($env:GLASGOW_WORKDIR) { $env:GLASGOW_WORKDIR } else { Join-Path $projectRoot "glasgow_service" }
$app = if ($env:GLASGOW_APP) { $env:GLASGOW_APP } else { "glasgow_service.api:app" }
$hostName = if ($env:GLASGOW_HOST) { $env:GLASGOW_HOST } else { "127.0.0.1" }
$port = if ($env:GLASGOW_PORT) { $env:GLASGOW_PORT } else { "8765" }
$glasgowConfig = if ($env:GLASGOW_CONFIG) { $env:GLASGOW_CONFIG } else { Join-Path $projectRoot "GlasgowDataIO\Json\streamData.json" }
$logFile = if ($env:GLASGOW_RESTART_LOG) { $env:GLASGOW_RESTART_LOG } else { Join-Path $workdir "uvicorn.log" }
$errLogFile = "$logFile.err"
$pythonBin = if ($env:GLASGOW_PYTHON) { $env:GLASGOW_PYTHON } else { Join-Path $repoRoot ".venv\Scripts\python.exe" }
$venvRoot = if ($env:VIRTUAL_ENV) { $env:VIRTUAL_ENV } else { Join-Path $repoRoot ".venv" }
$portNumber = [int]$port

if (-not (Test-Path -LiteralPath $pythonBin)) {
    $pythonBin = "python"
}

$logDir = Split-Path -Parent $logFile
if ($logDir -and -not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$scriptsDir = Join-Path $venvRoot "Scripts"

function Get-PortProcessIds {
    try {
        @(Get-NetTCPConnection -LocalPort $portNumber -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique |
            Where-Object { $_ -and $_ -ne $PID })
    } catch {
        @()
    }
}

function Get-GlasgowProcessIds {
    $escapedApp = [regex]::Escape($app)
    $escapedPort = [regex]::Escape($port)
    $pattern = "uvicorn.*$escapedApp.*--port(?:\s+|=)$escapedPort"
    $ids = New-Object System.Collections.Generic.HashSet[int]

    foreach ($processId in Get-PortProcessIds) {
        [void]$ids.Add([int]$processId)
    }

    # Uvicorn launched from a console script can leave a parent wrapper
    # process alive. If we only kill the listening child, that parent can
    # spawn another child with the stale command line and reclaim the port.
    foreach ($processId in @($ids)) {
        $currentId = [int]$processId
        while ($currentId -and $currentId -ne $PID) {
            try {
                $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId" -ErrorAction Stop
            } catch {
                break
            }

            if ($proc.CommandLine -and (
                    $proc.CommandLine -match $escapedApp -or
                    $proc.CommandLine -match "uvicorn" -or
                    $proc.CommandLine -match "glasgow_service")) {
                [void]$ids.Add([int]$proc.ProcessId)
                $currentId = [int]$proc.ParentProcessId
            } else {
                break
            }
        }
    }

    try {
        Get-CimInstance Win32_Process |
            Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } |
            ForEach-Object { [void]$ids.Add([int]$_.ProcessId) }
    } catch {
        return ($ids | ForEach-Object { [int]$_ })
    }

    foreach ($processId in @($ids)) {
        try {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
            if ($proc.CommandLine -match $escapedApp -or $proc.CommandLine -match "glasgow_service") {
                [void]$ids.Add([int]$processId)
            }
        } catch {
        }
    }

    $ids | ForEach-Object { [int]$_ }
}

function Wait-UntilStopped {
    param(
        [int[]]$ProcessIds,
        [int]$Tries
    )

    if (-not $ProcessIds -or $ProcessIds.Count -eq 0) {
        return $true
    }

    for ($i = 0; $i -lt $Tries; $i++) {
        $alive = @($ProcessIds | Where-Object {
            $_ -ne $PID -and (Get-Process -Id $_ -ErrorAction SilentlyContinue)
        })
        if ($alive.Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }

    return $false
}

function Wait-PortFree {
    for ($i = 0; $i -lt 20; $i++) {
        if (@(Get-PortProcessIds).Count -eq 0) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    return $false
}

function Wait-Ready {
    for ($i = 0; $i -lt 40; $i++) {
        try {
            Invoke-WebRequest -Uri "http://$hostName`:$port/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
            return $true
        } catch {
        }
        Start-Sleep -Milliseconds 250
    }

    return $false
}

function Start-UvicornProcess {
    $pathPrefix = if (Test-Path -LiteralPath $scriptsDir) { "$scriptsDir;" } else { "" }
    $pythonPath = "$projectRoot;$workdir"
    $commandLine = 'set "VIRTUAL_ENV={0}" && set "PATH={1}%PATH%" && set "GLASGOW_CONFIG={2}" && set "PYTHONPATH={3};%PYTHONPATH%" && "{4}" -m uvicorn "{5}" --host "{6}" --port "{7}" --ws websockets >> "{8}" 2>> "{9}"' -f `
        $venvRoot, $pathPrefix, $glasgowConfig, $pythonPath, $pythonBin, $app, $hostName, $port, $logFile, $errLogFile

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "cmd.exe"
    $startInfo.Arguments = "/d /c $commandLine"
    $startInfo.WorkingDirectory = $workdir
    $startInfo.UseShellExecute = $true
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    return [System.Diagnostics.Process]::Start($startInfo)
}

$oldPids = @(Get-GlasgowProcessIds)
if ($oldPids.Count -gt 0) {
    $oldPids | ForEach-Object {
        Stop-Process -Id $_ -ErrorAction SilentlyContinue
    }

    if (-not (Wait-UntilStopped -ProcessIds $oldPids -Tries 30)) {
        $oldPids | ForEach-Object {
            Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        }
        [void](Wait-UntilStopped -ProcessIds $oldPids -Tries 20)
    }
}

if (-not (Wait-PortFree)) {
    $pids = (Get-PortProcessIds) -join ", "
    throw "port $hostName`:$port is still in use by pid(s): $pids"
}

$process = Start-UvicornProcess

if (-not (Wait-Ready)) {
    if ($process.HasExited) {
        $tail = if (Test-Path -LiteralPath $errLogFile) {
            Get-Content -LiteralPath $errLogFile -Tail 40 -ErrorAction SilentlyContinue
        } else {
            @()
        }
        throw "failed to start $app; process exited early (errors $errLogFile)`n$($tail -join [Environment]::NewLine)"
    }

    throw "started process $($process.Id), but $hostName`:$port/status did not become ready"
}

Write-Output "started $app on $hostName`:$port with $pythonBin --ws websockets (host pid $($process.Id), listener pid(s): $((Get-PortProcessIds) -join ', '), log $logFile, errors $errLogFile)"
