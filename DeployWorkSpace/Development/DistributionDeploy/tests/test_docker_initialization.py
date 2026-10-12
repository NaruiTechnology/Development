import asyncio
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
import pytest

from workstates.installRedisSentinel_state import installRedisSentinel_state
from workstates.prepareDockerWsl_state import prepareDockerWsl_state


@pytest.mark.parametrize('filename', ['prepare-docker-wsl.ps1', 'diagnose-docker.ps1'])
def test_prerequisite_script_has_valid_powershell_syntax(filename):
    if os.name != 'nt':
        return
    script = Path(__file__).resolve().parents[4] / 'glasgow_service/deploy' / filename
    command = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('" + str(script) + "', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }"
    result = subprocess.run(['powershell.exe', '-NoProfile', '-Command', command], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def make_state(tmp_path):
    return installRedisSentinel_state(SimpleNamespace(deployRoot=str(tmp_path),
        _isProduction=False, GetStateConfig=lambda _: {'timeout': 60, 'actionData': {}}))


def test_explicit_wsl_preparation_precedes_dependency_install():
    import json
    path = Path(__file__).resolve().parents[1] / 'Json/DistributionDeploy.json'
    names = [next(iter(item)) for item in json.loads(path.read_text())['Actions']]
    assert names.index('verifyDistribution') < names.index('prepareDockerWsl')
    assert names.index('prepareDockerWsl') < names.index('setupVirtualEnv')
    assert names.index('prepareDockerWsl') < names.index('installRedisSentinel')


def test_explicit_wsl_preparation_handles_missing_docker(tmp_path):
    parent = SimpleNamespace(deployRoot=str(tmp_path), _isProduction=False,
        GetStateConfig=lambda _: {'timeout': 600})
    state = prepareDockerWsl_state(parent)
    state._findDocker = Mock(return_value=None)
    state._prepareBackend = AsyncMock()
    asyncio.run(state.DoWork())
    assert state._success
    state._prepareBackend.assert_awaited_once_with(600)
    assert parent._dockerWslPrepared


@pytest.mark.parametrize('ready, missing_component', [(True, False), (False, False), (True, True)])
def test_wsl_upgrade_is_waited_for_without_starting_another_update(tmp_path, ready, missing_component):
    if os.name != 'nt':
        return
    source = Path(__file__).resolve().parents[4] / 'glasgow_service/deploy/prepare-docker-wsl.ps1'
    script = source.read_text().replace("$wsl = Join-Path $env:SystemRoot 'System32\\wsl.exe'", "$wsl = 'Invoke-FakeWsl'")
    fixture = tmp_path / 'wsl-upgrade-test.ps1'
    fixture.write_text('''
$script:calls = 0
function Get-WindowsOptionalFeature { return @{ State = 'Enabled' } }
function Start-Sleep { }
function Invoke-FakeWsl {
    if ($args[0] -eq '--version') {
        $script:calls++
        if ($script:calls -lt 3) {
            $global:LASTEXITCODE = 1
            Write-Output 'WSL is finishing an upgrade...'
        } else {
            $global:LASTEXITCODE = 0
            Write-Output ('WSL version: 2.6.1.0'.ToCharArray() -join [char]0)
        }
    } elseif ($args[0] -eq '--set-default-version') {
        $global:LASTEXITCODE = 0
    } elseif ($args[0] -eq '--status') {
        $global:LASTEXITCODE = 0
        Write-Output 'Default Version: 2'
    } else { throw 'Unexpected WSL mutation' }
}
''' + script.replace('[CmdletBinding()]\nparam()', ''))
    if not ready:
        fixture.write_text(fixture.read_text().replace('-lt 3)', '-lt 999)'))
    if missing_component:
        fixture.write_text(fixture.read_text().replace("$global:LASTEXITCODE = 0\n        Write-Output 'Default Version: 2'", "$global:LASTEXITCODE = 1\n        Write-Output 'Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED'"))
    result = subprocess.run(['powershell.exe', '-NoProfile', '-File', str(fixture)], capture_output=True, text=True)
    if missing_component:
        assert result.returncode == 3010, result.stdout + result.stderr
        assert 'restart Windows' in result.stdout
        assert 'Docker WSL 2 prerequisites are ready.' not in result.stdout
        return
    if not ready:
        assert result.returncode != 0
        assert 'WSL upgrade did not become ready' in result.stderr
        assert 'WSL is finishing an upgrade' in result.stderr
        return
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'Waiting for WSL' in result.stdout
    assert 'Using WSL runtime 2.6.1.0' in result.stdout


def test_fresh_install_prepares_wsl_and_accepts_license(tmp_path):
    state = make_state(tmp_path)
    state._findDocker = Mock(side_effect=[None, 'docker.exe'])
    state._prepareBackend = AsyncMock()
    state._runExec = AsyncMock(side_effect=[(True, '', ''), (True, '', ''), (True, 'linux', '')])
    with patch('workstates.installRedisSentinel_state.shutil.which', return_value='winget.exe'):
        asyncio.run(state.DoWork())
    assert state._success
    state._prepareBackend.assert_awaited_once()
    install = state._runExec.call_args_list[0].args[0]
    assert '--custom' in install
    assert '--accept-license --backend=wsl-2' in install


def test_ready_engine_does_not_change_windows_prerequisites(tmp_path):
    state = make_state(tmp_path)
    state._findDocker = Mock(return_value='docker.exe')
    state._prepareBackend = AsyncMock()
    state._runExec = AsyncMock(side_effect=[(True, '', ''), (True, 'linux', '')])
    asyncio.run(state.DoWork())
    assert state._success
    state._prepareBackend.assert_not_called()


def test_reboot_required_stops_before_docker_install(tmp_path):
    state = make_state(tmp_path)
    script = tmp_path / 'Development/glasgow_service/deploy/prepare-docker-wsl.ps1'
    script.parent.mkdir(parents=True)
    script.touch()
    state.Logger = Mock()
    state._findDocker = Mock(return_value=None)
    async def needs_reboot(*args):
        state._returncode = 3010
        return False, 'Restart Windows', ''
    state._runExec = AsyncMock(side_effect=needs_reboot)
    asyncio.run(state.DoWork())
    assert not state._success
    assert state._runExec.await_count == 1
    assert 'Restart Windows' in str(state.Logger.error.call_args)
