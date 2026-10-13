import importlib.util
import zipfile
import json
from pathlib import Path
from unittest.mock import Mock

import pytest


def builder():
    path = Path(__file__).resolve().parents[4] / 'buildCompiledDist.py'
    spec = importlib.util.spec_from_file_location('handoff_builder', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_real_remote_manifest_passes_build_validation():
    module = builder()
    module.validate_remote_admin_database_workflow(Path(__file__).resolve().parents[5])


@pytest.mark.parametrize('actions, error', [
    ([{'setupIonbeamWeb': {}}], 'must include'),
    ([{'setupIobeamAdminDb': {'skip': True}}, {'setupIonbeamWeb': {}}], 'skip must be false'),
    ([{'setupIonbeamWeb': {}}, {'setupIobeamAdminDb': {'skip': False}}], 'must run before'),
    ([{'provisionLocalAdminDb': {'skip': False}},
      {'setupIobeamAdminDb': {'skip': False}}, {'setupIonbeamWeb': {}}], 'must not run'),
])
def test_invalid_remote_workflow_is_rejected(tmp_path, actions, error):
    root = tmp_path / 'Development/DeployWorkSpace/Development/DistributionDeploy'
    (root / 'Json').mkdir(parents=True)
    (root / 'workstates').mkdir()
    (root / 'workstates/setupIobeamAdminDb_state.py').touch()
    (root / 'Json/DistributionDeploy.json').write_text(json.dumps({'Actions': actions}))
    with pytest.raises(ValueError, match=error):
        builder().validate_remote_admin_database_workflow(tmp_path)


def test_remote_handoff_only_enters_outer_archive(tmp_path):
    module = builder()
    archive = tmp_path / 'installer.zip'
    with zipfile.ZipFile(archive, 'w') as handle:
        handle.writestr('DeployWorkSpace/Development/DistributionDeploy/dist_app.zip', b'app-data')
    payload = 'IOBEAM_ADMIN_CONFIG_DB_PASSWORD=existing-remote-password\n'
    module.append_remote_database_handoff(archive, payload)
    with zipfile.ZipFile(archive) as handle:
        assert handle.read('DeployWorkSpace/remote-database.env').decode() == payload
        assert handle.read('DeployWorkSpace/Development/DistributionDeploy/dist_app.zip') == b'app-data'
        assert (handle.getinfo('DeployWorkSpace/remote-database.env').external_attr >> 16) & 0o777 == 0o600


def test_local_install_has_no_credential_handoff(tmp_path):
    module = builder()
    archive = tmp_path / 'installer.zip'
    with zipfile.ZipFile(archive, 'w'):
        pass
    module.append_remote_database_handoff(archive, None)
    with zipfile.ZipFile(archive) as handle:
        assert handle.namelist() == []


def test_missing_remote_password_fails_before_packaging(tmp_path, monkeypatch):
    module = builder()
    manifest = tmp_path / 'Development/DeployWorkSpace/Development/DistributionDeploy/Json/DistributionDeploy.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({'Deployment': {'DatabaseHost': 'remote-db',
        'DatabaseUser': 'deployworkspace', 'DatabasePassword': ''}}))
    store = Mock()
    store.expand.side_effect = lambda value, **kwargs: value
    monkeypatch.setattr(module, 'load_secretstore', lambda _: store)
    with pytest.raises(RuntimeError, match='IOBEAM_ADMIN_CONFIG_DB_PASSWORD'):
        module.remote_database_handoff(tmp_path)
