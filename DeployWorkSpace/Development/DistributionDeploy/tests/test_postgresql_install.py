import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

from workstates.setupIobeamAdminDb_state import setupIobeamAdminDb_state
from workthreads.DistributionDeployThread import DistributionDeployThread
from buildingblocks.automation_config import AutomationConfig


def make_state(tmp_path, deployment):
    state = setupIobeamAdminDb_state(SimpleNamespace(deployRoot=str(tmp_path),
        GetStateConfig=lambda _: {'actionData': {}, 'timeout': 60}))
    state.deploymentConfig = Mock(return_value=deployment)
    state._verifyRuntimeRoleCanConnect = AsyncMock(return_value=True)
    state._writeDbConfig = Mock(return_value=True)
    return state


@pytest.mark.parametrize('host', ['', 'localhost', '127.0.0.1', '::1'])
def test_local_database_is_rejected_without_any_setup(tmp_path, host):
    state = make_state(tmp_path, {'DatabaseHost': host})
    asyncio.run(state.DoWork())
    assert not state._success
    state._verifyRuntimeRoleCanConnect.assert_not_called()
    state._writeDbConfig.assert_not_called()


def test_existing_remote_database_is_verified_before_config_is_written(tmp_path):
    state = make_state(tmp_path, {'DatabaseHost': 'remote-db', 'DatabaseName': 'ionbeam_admin_db',
        'DatabaseUser': 'deployworkspace', 'DatabasePassword': 'existing-password'})
    asyncio.run(state.DoWork())
    assert state._success
    state._verifyRuntimeRoleCanConnect.assert_awaited_once()
    state._writeDbConfig.assert_called_once()


def test_failed_remote_connection_does_not_replace_runtime_config(tmp_path):
    state = make_state(tmp_path, {'DatabaseHost': 'remote-db', 'DatabaseName': 'ionbeam_admin_db',
        'DatabaseUser': 'deployworkspace', 'DatabasePassword': 'existing-password'})
    state._verifyRuntimeRoleCanConnect.return_value = False
    asyncio.run(state.DoWork())
    assert not state._success
    state._writeDbConfig.assert_not_called()


def test_manifest_has_no_local_database_install_or_schema_actions():
    config = json.loads((Path(__file__).parents[1] / 'Json/DistributionDeploy.json').read_text())
    assert all('installPostgreSQL' not in action for action in config['Actions'])
    setup = next(action['setupIobeamAdminDb'] for action in config['Actions'] if 'setupIobeamAdminDb' in action)
    assert set(setup['actionData']) == {'adminDbConfigFile'}
    assert config['Deployment']['DatabaseName'] == 'ionbeam_admin_db'


def test_real_workflow_reads_manifest_and_imported_remote_credentials(tmp_path):
    manifest = {'Deployment': {'DeployRoot': str(tmp_path),
        'DatabaseHost': '${IOBEAM_ADMIN_CONFIG_DB_HOST}',
        'DatabaseName': 'ionbeam_admin_db',
        'DatabaseUser': '${IOBEAM_ADMIN_CONFIG_DB_USER}',
        'DatabasePassword': '${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}'},
        'Actions': [{'setupIobeamAdminDb': {'actionData': {}, 'timeout': 60}}]}
    config = AutomationConfig(json.dumps(manifest))
    with patch('workthreads.DistributionDeployThread.AutomationLog'):
        thread = DistributionDeployThread(config)
    assert not hasattr(thread, 'Config')
    state = thread.IntialWork()
    assert isinstance(state, setupIobeamAdminDb_state)
    state._verifyRuntimeRoleCanConnect = AsyncMock(return_value=True)
    state._writeDbConfig = Mock(return_value=True)
    with patch.dict('os.environ', {'IOBEAM_ADMIN_CONFIG_DB_HOST': '124.221.175.89',
        'IOBEAM_ADMIN_CONFIG_DB_USER': 'deployworkspace',
        'IOBEAM_ADMIN_CONFIG_DB_PASSWORD': 'imported-existing-password'}):
        asyncio.run(state.DoWork())
    assert state._success
    assert state._verifyRuntimeRoleCanConnect.call_args.args[:4] == (
        'ionbeam_admin_db', '124.221.175.89', 'deployworkspace', 'imported-existing-password')
