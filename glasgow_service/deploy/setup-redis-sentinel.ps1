[CmdletBinding()]
param(
    [string]$Image = "redis:7-alpine",
    [string]$NetworkName = "iobeam-local"
)

$ErrorActionPreference = "Stop"
$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $docker) {
    throw "docker.exe was not found. Install and start Docker Desktop, then retry."
}

& $docker.Source info | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is installed, but its engine is not ready."
}

& $docker.Source network inspect $NetworkName *> $null
if ($LASTEXITCODE -ne 0) {
    & $docker.Source network create $NetworkName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not create Docker network $NetworkName." }
}

$runtimeRoot = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "Iobeam\Redis"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$sentinelConfig = Join-Path $runtimeRoot "sentinel.conf"
@"
port 26379
dir /tmp
sentinel monitor mymaster iobeam-redis 6379 1
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 10000
sentinel parallel-syncs mymaster 1
"@ | Set-Content -LiteralPath $sentinelConfig -Encoding utf8

function Test-Container {
    param([string]$Name)
    & $docker.Source inspect $Name *> $null
    return $LASTEXITCODE -eq 0
}

if (Test-Container "iobeam-redis") {
    & $docker.Source start iobeam-redis | Out-Null
} else {
    $redisArgs = @(
        "run", "-d", "--name", "iobeam-redis", "--network", $NetworkName,
        "-p", "6379:6379", $Image, "redis-server", "--appendonly", "yes"
    )
    & $docker.Source @redisArgs | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "Could not start the iobeam-redis container." }

$mountPath = $sentinelConfig.Replace("\", "/")
if (Test-Container "iobeam-sentinel") {
    & $docker.Source start iobeam-sentinel | Out-Null
} else {
    $sentinelArgs = @(
        "run", "-d", "--name", "iobeam-sentinel", "--network", $NetworkName,
        "-p", "26379:26379", "-v", "$($mountPath):/etc/redis/sentinel.conf:ro",
        $Image, "redis-server", "/etc/redis/sentinel.conf", "--sentinel"
    )
    & $docker.Source @sentinelArgs | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "Could not start the iobeam-sentinel container." }

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    & $docker.Source exec iobeam-redis redis-cli ping *> $null
    $redisReady = $LASTEXITCODE -eq 0
    & $docker.Source exec iobeam-sentinel redis-cli -p 26379 ping *> $null
    $sentinelReady = $LASTEXITCODE -eq 0
    if ($redisReady -and $sentinelReady) {
        Write-Host "Redis is ready on 127.0.0.1:6379; Sentinel is ready on 127.0.0.1:26379."
        exit 0
    }
    Start-Sleep -Milliseconds 500
}
throw "Redis/Sentinel containers did not become ready in time."
