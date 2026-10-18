"""Exercise Windows operation dispatch with service actions replaced by recorders."""
import os
from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell manager")
MANAGER = Path(__file__).parents[2] / "Scripts/manage-local-system.ps1"


def dispatch(operation, yes=False):
    # Parse the real dispatcher without executing the manager's startup code or
    # touching running services, hardware, secrets, PID files or log directories.
    script = r'''
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:TEST_MANAGER, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Manager has syntax errors' }
$switch = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.SwitchStatementAst] -and
    $node.Condition.Extent.Text -eq '$Operation'
}, $false)
function Stop-Stack { 'host:stop' }
function Stop-Managed { param($Name) "stop:$Name" }
function Start-Stack { 'host:start' }
function Start-Controllers { param([switch]$VacuumOnly) "controllers:vacuumOnly=$VacuumOnly" }
function Show-Status {}
$Operation = $env:TEST_OPERATION
$Yes = $env:TEST_YES -eq 'true'
& ([scriptblock]::Create($switch.Extent.Text))
'''
    return subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env={**os.environ, "TEST_MANAGER": str(MANAGER),
             "TEST_OPERATION": operation, "TEST_YES": str(yes).lower()},
        capture_output=True, text=True,
    )


def test_host_stop_leaves_vacuum_running():
    result = dispatch("stop")
    assert result.returncode == 0, result.stderr
    assert "host:stop" in result.stdout
    assert "stop:sbc-vacuum" not in result.stdout


@pytest.mark.parametrize("operation", ["stop-vacuum", "restart-vacuum"])
def test_vacuum_actions_require_confirmation(operation):
    result = dispatch(operation)
    assert result.returncode != 0
    assert "stop:sbc-vacuum" not in result.stdout


def test_confirmed_vacuum_restart_leaves_host_services_alone():
    result = dispatch("restart-vacuum", yes=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["stop:sbc-vacuum", "controllers:vacuumOnly=True"]
