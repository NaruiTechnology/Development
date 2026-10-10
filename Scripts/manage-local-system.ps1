
[CmdletBinding()]
param(
    [ValidateSet("install", "start", "start-sample-stage", "restart", "restart-controllers", "stop", "status", "logs")]
    [string]$Operation = "restart"
)

$ErrorActionPreference = "Stop"
$operationsRoot = if ($env:IOBEAM_OPERATIONS_ROOT) {
    [IO.Path]::GetFullPath($env:IOBEAM_OPERATIONS_ROOT)
} else {
    [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}
$developmentRoot = Join-Path $operationsRoot "Development"
$serviceRoot = Join-Path $developmentRoot "glasgow_service"
if (-not (Test-Path -LiteralPath $serviceRoot)) { $serviceRoot = Join-Path $operationsRoot "glasgow_service" }
$dataRoot = Join-Path $developmentRoot "GlasgowDataIO"
if (-not (Test-Path -LiteralPath $dataRoot)) { $dataRoot = Join-Path $operationsRoot "GlasgowDataIO" }
$backendRoot = Join-Path $developmentRoot "ionbeam-web\backend"
$frontendRoot = Join-Path $developmentRoot "ionbeam-web\frontend"
if (-not (Test-Path -LiteralPath (Join-Path $backendRoot "package.json"))) { $backendRoot = Join-Path $operationsRoot "ionbeam-web\backend" }
if (-not (Test-Path -LiteralPath (Join-Path $frontendRoot "package.json"))) { $frontendRoot = Join-Path $operationsRoot "ionbeam-web\frontend" }
$venvRoot = if ($env:IOBEAM_VENV) { [IO.Path]::GetFullPath($env:IOBEAM_VENV) } else { Join-Path $operationsRoot ".venv" }
$python = Join-Path $venvRoot "Scripts\python.exe"
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$runtimeRoot = Join-Path $operationsRoot "Runtime"
$logRoot = Join-Path $operationsRoot "Logs"
New-Item -ItemType Directory -Path $runtimeRoot, $logRoot -Force | Out-Null

function Assert-Prerequisites {
    if (-not (Test-Path -LiteralPath $python)) { throw "Virtual-environment Python was not found at $python." }
    & $python -c "import fastapi, pydantic, uvicorn, redis, httpx"
    if ($LASTEXITCODE -ne 0) { throw "Missing service dependencies. Run: `"$python`" -m pip install -r `"$serviceRoot\requirements.txt`"" }
    if (-not $npmCommand) { throw "npm.cmd was not found. Install Node.js LTS or add it to PATH." }
    foreach ($path in @($serviceRoot, $backendRoot, $frontendRoot)) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Required application directory was not found: $path" }
    }
}

function Get-PidPath {
    param([string]$Name)
    Join-Path $runtimeRoot "$Name.pid"
}

function Get-ManagedProcess {
    param([string]$Name)
    $pidPath = Get-PidPath $Name
    if (-not (Test-Path -LiteralPath $pidPath)) { return $null }
    $storedPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($storedPid -notmatch "^\d+$") {
        Remove-Item -LiteralPath $pidPath -Force
        return $null
    }
    $process = Get-Process -Id ([int]$storedPid) -ErrorAction SilentlyContinue
    if (-not $process) { Remove-Item -LiteralPath $pidPath -Force }
    return $process
}

function Start-Managed {
    param([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
    $existing = Get-ManagedProcess $Name
    if ($existing) {
        Write-Host "$Name already running (PID $($existing.Id))."
        return
    }
    $startArgs = @{
        FilePath = $FilePath
        ArgumentList = $Arguments
        WorkingDirectory = $WorkingDirectory
        RedirectStandardOutput = (Join-Path $logRoot "$Name.out.log")
        RedirectStandardError = (Join-Path $logRoot "$Name.err.log")
        WindowStyle = "Hidden"
        PassThru = $true
    }
    $process = Start-Process @startArgs
    Set-Content -LiteralPath (Get-PidPath $Name) -Value $process.Id -Encoding ascii
    Write-Host "Started $Name (PID $($process.Id))."
}

function Stop-Managed {
    param([string]$Name)
    $process = Get-ManagedProcess $Name
    if (-not $process) {
        Write-Host "$Name is not running."
        return
    }
    & taskkill.exe /PID $process.Id /T /F *> $null
    if ($LASTEXITCODE -ne 0) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath (Get-PidPath $Name) -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped $Name."
}

function Wait-Http {
    param([string]$Name, [string]$Url)
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 | Out-Null
            Write-Host "$Name is ready at $Url."
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "$Name did not become ready at $Url."
}

function Show-Status {
    foreach ($name in @("glasgow", "sample-stage", "vacuum-executor", "sbc-vacuum", "ionbeam-backend", "ionbeam-frontend")) {
        $process = Get-ManagedProcess $name
        if ($process) { Write-Host ("{0,-20} running PID {1}" -f $name, $process.Id) }
        else { Write-Host ("{0,-20} stopped" -f $name) }
    }
}

function Start-SampleStage {
    if (-not (Test-Path -LiteralPath $python)) { throw "Virtual-environment Python was not found at $python." }
    if (-not (Test-Path -LiteralPath $serviceRoot)) { throw "Sample-stage service directory was not found: $serviceRoot" }
    $env:PYTHONPATH = "$developmentRoot;$serviceRoot"
    $env:SAMPLE_STAGE_CONFIG = Join-Path $dataRoot "Json\sampleStageSystem.json"
    $env:SAMPLE_STAGE_STATE = Join-Path $runtimeRoot "sample-stage-position.json"
    Start-Managed "sample-stage" $python @("-m", "uvicorn", "glasgow_service.sample_stage_app:app", "--host", "127.0.0.1", "--port", "8790") $serviceRoot
    Wait-Http "sample stage" "http://127.0.0.1:8790/status"
}

function Start-Controllers {
    Assert-Prerequisites
    $env:PYTHONPATH = "$developmentRoot;$serviceRoot"
    # Use the application parser; keep credential values out of terminal output.
    $secretJson = & $python -c "import json, secretstore; print(json.dumps(secretstore.read_file()))"
    if ($LASTEXITCODE -ne 0) { throw 'Could not load the runtime secrets file.' }
    $secrets = $secretJson | ConvertFrom-Json
    foreach ($property in $secrets.PSObject.Properties) {
        if (-not [Environment]::GetEnvironmentVariable($property.Name, 'Process')) {
            [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
        }
    }
    $env:GLASGOW_CONFIG = Join-Path $dataRoot "Json\streamData.json"
    $env:SBC_VACUUM_CONFIG = Join-Path $dataRoot "Json\vacuumSystem.json"
    if (-not $env:VACUUM_REDIS_SENTINELS) { $env:VACUUM_REDIS_SENTINELS = "127.0.0.1:26379" }
    $env:SBC_VACUUM_PORT = "8766"
    if (-not $env:VACUUM_EXECUTOR_ID) { $env:VACUUM_EXECUTOR_ID = "local-executor" }
    if (-not $env:VACUUM_REDIS_MASTER) { $env:VACUUM_REDIS_MASTER = "mymaster" }
    if (-not $env:VACUUM_REDIS_WAIT_REPLICAS) { $env:VACUUM_REDIS_WAIT_REPLICAS = "0" }

    Start-Managed "sbc-vacuum" $python @("-m", "glasgow_service.sbc_vacuum_app") $serviceRoot
    Wait-Http "SBC vacuum" "http://127.0.0.1:8766/health/ready"
    Start-Managed "glasgow" $python @("-m", "uvicorn", "glasgow_service.api:app", "--host", "127.0.0.1", "--port", "8765") $serviceRoot
    Wait-Http "Glasgow" "http://127.0.0.1:8765/status"
    Start-Managed "vacuum-executor" $python @("-m", "glasgow_service.vacuum_executor_app") $serviceRoot
    Wait-Http "vacuum executor" "http://127.0.0.1:8780/health/live"
}

function Start-Stack {
    Start-Controllers
    Start-SampleStage
    # Use built production artifacts for a detached Windows process. `tsx watch`
    # expects an interactive console and can terminate with write-EOF when
    # launched by Start-Process without stdin.
    if (-not $nodeCommand) { throw "node.exe was not found." }
    Start-Managed "ionbeam-backend" $nodeCommand.Source @("dist/server.js") $backendRoot
    Wait-Http "web backend" "http://127.0.0.1:4000/api/status"
    $viteScript = Join-Path $frontendRoot "node_modules\vite\bin\vite.js"
    Start-Managed "ionbeam-frontend" $nodeCommand.Source @($viteScript, "preview", "--host", "127.0.0.1", "--port", "5173") $frontendRoot
    Wait-Http "web frontend" "http://127.0.0.1:5173/"
}

function Stop-Stack {
    foreach ($name in @("ionbeam-frontend", "ionbeam-backend", "vacuum-executor", "sample-stage", "glasgow", "sbc-vacuum")) {
        Stop-Managed $name
    }
}

switch ($Operation) {
    "install" { Assert-Prerequisites; Write-Host "Windows local stack prerequisites are available." }
    "start" { Start-Stack; Show-Status }
    "start-sample-stage" { Start-SampleStage; Show-Status }
    "restart" { Stop-Stack; Start-Stack; Show-Status }
    "restart-controllers" {
        foreach ($name in @("vacuum-executor", "glasgow", "sbc-vacuum")) { Stop-Managed $name }
        Start-Controllers
        Show-Status
    }
    "stop" { Stop-Stack }
    "status" { Show-Status }
    "logs" {
        Get-ChildItem -LiteralPath $logRoot -Filter "*.log" -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object {
                Write-Host ""
                Write-Host "===== $($_.Name) ====="
                Get-Content -LiteralPath $_.FullName -Tail 40
            }
    }
}
