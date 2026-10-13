import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[4] / 'Scripts/manage-local-system.ps1'


def run_powershell(body):
    path = str(SCRIPT).replace("'", "''")
    command = """
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('%s', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors -join "`n") }
$functions = $ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]}, $false)
foreach ($function in $functions) {
    if ($function.Name -in @('Get-ManagedProcess', 'Stop-Managed', 'Invoke-ManagedTaskKill')) {
        Invoke-Expression $function.Extent.Text
    }
}
%s
""" % (path, body)
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.skipif(os.name != 'nt', reason='Windows process manager')
def test_native_taskkill_stderr_is_captured_without_terminating():
    run_powershell("""
$result = Invoke-ManagedTaskKill 2147483647
if ($result.ExitCode -eq 0 -or -not $result.Detail) { throw 'Expected captured missing-process error' }
""")


@pytest.mark.skipif(os.name != 'nt', reason='Windows process manager')
@pytest.mark.parametrize('kind', ['system', 'reused', 'wrong_command', 'valid', 'unreadable'])
def test_pid_identity_is_checked_before_stop(kind):
    run_powershell("""
$kind='%s'
$script:removed=$false
function Get-PidPath { return 'unused.pid' }
function Test-Path { return $true }
function Get-Content { return '61748' }
function Remove-Item { $script:removed=$true }
function Get-Item { return [pscustomobject]@{ LastWriteTimeUtc=[datetime]'2026-01-02' } }
function Get-Process {
    $name=if ($kind -eq 'system') { 'WmiPrvSE' } else { 'python' }
    $start=if ($kind -eq 'reused') { [datetime]'2026-01-03' } else { [datetime]'2026-01-01' }
    return [pscustomobject]@{ Id=61748; ProcessName=$name; StartTime=$start }
}
function Get-CimInstance {
    $command=if ($kind -eq 'valid') { 'python -m uvicorn glasgow_service.api:app' }
             elseif ($kind -eq 'unreadable') { $null } else { 'python unrelated.py' }
    return [pscustomobject]@{ CommandLine=$command }
}
$failed=$false; $process=$null
try { $process=Get-ManagedProcess 'glasgow' } catch { $failed=$true }
if ($kind -eq 'unreadable') {
    if (-not $failed -or $script:removed) { throw 'Unverifiable identity must retain receipt and fail' }
} elseif ($kind -eq 'valid') {
    if (-not $process -or $script:removed -or $failed) { throw 'Valid service rejected' }
} else {
    if ($process -or -not $script:removed -or $failed) { throw 'Stale PID was trusted' }
}
""" % kind)


@pytest.mark.skipif(os.name != 'nt', reason='Windows process manager')
def test_child_is_stopped_after_parent_exits():
    run_powershell("""
$script:child = [pscustomobject]@{ Id=12346; StartTime=[datetime]'2026-01-01' }
$script:removed=$false
function Get-ManagedProcess { return [pscustomobject]@{ Id=12345; StartTime=[datetime]'2026-01-01' } }
function Get-PidPath { return 'unused.pid' }
function Get-CimInstance { return [pscustomobject]@{ ProcessId=12346; ParentProcessId=12345 } }
function Get-Process { param($Id); if ($Id -eq 12346) { return $script:child } }
function Invoke-ManagedTaskKill { return [pscustomobject]@{ ExitCode=1; Detail='Child could not be terminated' } }
function Stop-Process { param($Id); if ($Id -ne 12346) { throw 'Wrong process' }; $script:child=$null }
function Remove-Item { $script:removed=$true }
Stop-Managed 'test-service'
if ($script:child -or -not $script:removed) { throw 'Child cleanup failed' }
""")


@pytest.mark.skipif(os.name != 'nt', reason='Windows process manager')
@pytest.mark.parametrize('survives', [False, True])
def test_stop_preserves_receipt_only_when_process_survives(survives):
    run_powershell("""
$script:survives = %s
$script:removed = $false
$script:fallback = $false
$script:member = [pscustomobject]@{ Id=12345; StartTime=[datetime]'2026-01-01' }
function Get-ManagedProcess { return $script:member }
function Get-PidPath { return 'unused.pid' }
function Get-CimInstance { return @() }
function Invoke-ManagedTaskKill { return [pscustomobject]@{ ExitCode=1; Detail='Access denied' } }
function Get-Process { return $script:member }
function Stop-Process { $script:fallback=$true; if (-not $script:survives) { $script:member=$null } }
function Remove-Item { $script:removed=$true }
$failed=$false
try { Stop-Managed 'test-service' } catch { $failed=$true }
if (-not $script:fallback) { throw 'Fallback was not attempted' }
if ($failed -ne $script:survives) { throw 'Incorrect stop result' }
if ($script:removed -eq $script:survives) { throw 'Incorrect PID receipt handling' }
""" % ('$true' if survives else '$false'))
