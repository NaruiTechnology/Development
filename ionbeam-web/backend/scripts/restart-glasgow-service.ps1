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
$toolchain = if ($env:GLASGOW_TOOLCHAIN) { $env:GLASGOW_TOOLCHAIN } else { "builtin" }
$usbTransferTimeout = if ($env:GLASGOW_USB_TRANSFER_TIMEOUT_S) { $env:GLASGOW_USB_TRANSFER_TIMEOUT_S } else { "60" }

function Test-StreamDataTail {
    param([string]$Path)
    $normalized = [IO.Path]::GetFullPath($Path)
    $parts = $normalized -split '[\\/]+' | Where-Object { $_ }
    if ($parts.Count -lt 3) {
        return $false
    }
    $tail = ($parts | Select-Object -Last 3) -join '/'
    return $tail.ToLowerInvariant() -eq "glasgowdataio/json/streamdata.json"
}

function Get-SiblingDevelopmentConfigPath {
    param([string]$StreamDataPath)
    $jsonDir = Split-Path -Parent $StreamDataPath
    $glasgowDataIoDir = Split-Path -Parent $jsonDir
    $deployRoot = Split-Path -Parent $glasgowDataIoDir
    return Join-Path $deployRoot "Development\GlasgowDataIO\Json\streamData.json"
}

function Resolve-GlasgowConfigPath {
    param([string]$RawPath)
    if (-not $RawPath) {
        return Join-Path $projectRoot "GlasgowDataIO\Json\streamData.json"
    }

    $resolved = [IO.Path]::GetFullPath($RawPath)
    if (Test-StreamDataTail $resolved) {
        $sibling = Get-SiblingDevelopmentConfigPath $resolved
        if (Test-Path -LiteralPath $sibling) {
            return $sibling
        }
    }

    return $resolved
}

$glasgowConfig = Resolve-GlasgowConfigPath $env:GLASGOW_CONFIG
if (-not (Test-Path -LiteralPath $glasgowConfig -PathType Leaf)) {
    $defaultConfig = Join-Path $projectRoot "GlasgowDataIO\Json\streamData.json"
    throw "Glasgow configuration does not exist: $glasgowConfig. Set GLASGOW_CONFIG to an existing file (local default: $defaultConfig) before restarting. The existing service has not been stopped."
}
$logFile = if ($env:GLASGOW_RESTART_LOG) { $env:GLASGOW_RESTART_LOG } else { Join-Path $workdir "uvicorn.log" }
$errLogFile = "$logFile.err"
$venvRoot = $env:VIRTUAL_ENV
if (-not $venvRoot) {
    $venvCandidates = @(
        (Join-Path $repoRoot ".venv"),
        (Join-Path (Split-Path -Parent $repoRoot) ".venv")
    )
    $venvRoot = $venvCandidates | Where-Object {
        Test-Path -LiteralPath (Join-Path $_ "Scripts\python.exe")
    } | Select-Object -First 1
    if (-not $venvRoot) { $venvRoot = $venvCandidates[0] }
}
$pythonBin = if ($env:GLASGOW_PYTHON) { $env:GLASGOW_PYTHON } else { Join-Path $venvRoot "Scripts\python.exe" }
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
    $commandLine = 'set "VIRTUAL_ENV={0}" && set "PATH={1}%PATH%" && set "GLASGOW_CONFIG={2}" && set "GLASGOW_TOOLCHAIN={3}" && set "GLASGOW_USB_TRANSFER_TIMEOUT_S={4}" && set "PYTHONPATH={5};%PYTHONPATH%" && "{6}" -m uvicorn "{7}" --host "{8}" --port "{9}" --ws websockets >> "{10}" 2>> "{11}"' -f `
        $venvRoot, $pathPrefix, $glasgowConfig, $toolchain, $usbTransferTimeout, $pythonPath, $pythonBin, $app, $hostName, $port, $logFile, $errLogFile

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
        $processId = $_
        try {
            Stop-Process -Id $processId -ErrorAction Stop
        } catch {
            if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
                throw "Could not stop Glasgow process ${processId}: $($_.Exception.Message). If it was started elevated, stop that process from an Administrator PowerShell, then restart Glasgow from your ordinary shell."
            }
        }
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

Write-Output "started $app on $hostName`:$port with $pythonBin --ws websockets, GLASGOW_TOOLCHAIN=$toolchain, GLASGOW_USB_TRANSFER_TIMEOUT_S=$usbTransferTimeout (host pid $($process.Id), listener pid(s): $((Get-PortProcessIds) -join ', '), log $logFile, errors $errLogFile)"
