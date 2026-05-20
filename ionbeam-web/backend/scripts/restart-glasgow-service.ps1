$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$workdir = if ($env:GLASGOW_WORKDIR) { $env:GLASGOW_WORKDIR } else { Join-Path $repoRoot "glasgow_service" }
$app = if ($env:GLASGOW_APP) { $env:GLASGOW_APP } else { "glasgow_service.api:app" }
$hostName = if ($env:GLASGOW_HOST) { $env:GLASGOW_HOST } else { "127.0.0.1" }
$port = if ($env:GLASGOW_PORT) { $env:GLASGOW_PORT } else { "8765" }
$logFile = if ($env:GLASGOW_RESTART_LOG) { $env:GLASGOW_RESTART_LOG } else { Join-Path $repoRoot "glasgow_service\uvicorn.log" }
$errLogFile = "$logFile.err"
$pythonBin = if ($env:GLASGOW_PYTHON) { $env:GLASGOW_PYTHON } else { Join-Path $repoRoot ".venv\Scripts\python.exe" }

if (-not (Test-Path -LiteralPath $pythonBin)) {
    $pythonBin = "python"
}

$pattern = "uvicorn.*$([regex]::Escape($app)).*--port\s+$([regex]::Escape($port))"
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match $pattern } |
    ForEach-Object {
        try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        } catch {
        }
    }

Start-Process `
    -FilePath $pythonBin `
    -ArgumentList @("-m", "uvicorn", $app, "--host", $hostName, "--port", $port) `
    -WorkingDirectory $workdir `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errLogFile `
    -WindowStyle Hidden

Write-Output "started $app on $hostName`:$port with $pythonBin (log $logFile, errors $errLogFile)"
