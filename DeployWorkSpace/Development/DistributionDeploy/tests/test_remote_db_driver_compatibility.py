import asyncio
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workstates.setupIobeamAdminDb_state import setupIobeamAdminDb_state


@pytest.mark.parametrize('compatible', [False, True])
def test_remote_probe_checks_scramp_before_connecting(monkeypatch, capsys, compatible):
    state = setupIobeamAdminDb_state.__new__(setupIobeamAdminDb_state)
    state.deploymentConfig = lambda: {}
    state.resolveDeployPath = lambda value: value
    state.info = Mock()
    state.error = Mock()
    state._runExec = AsyncMock(return_value=(True, '', ''))
    asyncio.run(state._verifyRuntimeRoleCanConnect(
        'admin', 'remote-db', 'runtime', 'test-password', 30, {}))
    call = state._runExec.call_args
    script = call.args[0][2]
    for key, value in call.kwargs['env'].items():
        monkeypatch.setenv(key, value)

    scramp = ModuleType('scramp')
    if compatible:
        scramp.make_channel_binding = lambda *args: None
    pg8000 = ModuleType('pg8000')
    native = ModuleType('pg8000.native')
    connection = Mock()
    connection.run.return_value = [['runtime:admin']]
    native.Connection = Mock(return_value=connection)
    pg8000.native = native
    monkeypatch.setitem(sys.modules, 'scramp', scramp)
    monkeypatch.setitem(sys.modules, 'pg8000', pg8000)
    monkeypatch.setitem(sys.modules, 'pg8000.native', native)
    if compatible:
        exec(script, {})
        connection.run.assert_called_once_with("SELECT current_user || ':' || current_database()")
        connection.close.assert_called_once()
        assert 'runtime:admin' in capsys.readouterr().out
    else:
        with pytest.raises(SystemExit, match=r'Install scramp==1.4.18'):
            exec(script, {})
        native.Connection.assert_not_called()
