import asyncio
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from workstates.installPostgreSQL_state import installPostgreSQL_state


@pytest.mark.skipif(os.name != 'nt', reason='Windows installer state')
def test_non_admin_fails_before_install(tmp_path):
    state = installPostgreSQL_state(SimpleNamespace(
        deployRoot=str(tmp_path), GetStateConfig=lambda _: {'actionData': {}}))
    state.Logger = Mock()
    state._findPsql = Mock(return_value=None)
    state._isAdministrator = Mock(return_value=False)
    state.runArguments = AsyncMock()
    with patch('workstates.installPostgreSQL_state.shutil.which', return_value='winget.exe'):
        asyncio.run(state.DoWork())
    assert not state._success
    state.runArguments.assert_not_called()
    assert 'Administrator' in str(state.Logger.error.call_args)


@pytest.mark.skipif(os.name != 'nt', reason='Windows installer state')
@pytest.mark.parametrize('timeout', [False, True])
def test_install_failure_preserves_stdout_and_exit_code(tmp_path, timeout):
    state = installPostgreSQL_state(SimpleNamespace(
        deployRoot=str(tmp_path), GetStateConfig=lambda _: {'actionData': {}}))
    state.Logger = Mock()
    state._findPsql = Mock(return_value=None)
    state._isAdministrator = Mock(return_value=True)
    async def fail(*args):
        state._stdout = b'package download failed'
        state._stderr = b''
        state._returncode = 123
        if timeout:
            raise asyncio.TimeoutError()
        return False
    state.runArguments = AsyncMock(side_effect=fail)
    with patch('workstates.installPostgreSQL_state.shutil.which', return_value='winget.exe'):
        asyncio.run(state.DoWork())
    assert not state._success
    log, = (tmp_path / 'Logs').glob('*.output.log')
    assert 'package download failed' in log.read_text()
    assert 'exit_code=123' in log.read_text()
    assert 'package download failed' in str(state.Logger.error.call_args)


def test_client_only_install_is_not_accepted(tmp_path):
    psql = tmp_path / 'bin' / 'psql.exe'
    psql.parent.mkdir()
    psql.touch()
    with pytest.raises(RuntimeError, match='server binary'):
        installPostgreSQL_state._verifyServerBinary(str(psql))
