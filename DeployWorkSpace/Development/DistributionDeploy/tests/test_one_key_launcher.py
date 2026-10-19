"""Run the batch launcher against an inert deployment entrypoint."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows batch launcher")
LAUNCHER = Path(__file__).parents[3] / "OneKeyDeploy.bat"


@pytest.mark.parametrize("exit_code", [0, 23])
def test_launcher_finds_executable_python_and_preserves_exit_code(tmp_path, exit_code):
    workspace = tmp_path / "workspace with spaces"
    app_dir = workspace / "Development/DistributionDeploy"
    (app_dir / "Json").mkdir(parents=True)
    shutil.copy2(LAUNCHER, workspace / "OneKeyDeploy.bat")
    (app_dir / "Json/DistributionDeploy.json").write_text("{}")
    (app_dir / "distributionDeployApp.py").write_text(
        f"import sys\nprint('INERT_DEPLOY_ENTRYPOINT')\nsys.exit({exit_code})\n"
    )
    # A stale local interpreter must not prevent trying the PATH candidates.
    scripts = workspace / ".venv/Scripts"
    scripts.mkdir(parents=True)
    (scripts / "python.exe").write_bytes(b"invalid executable")
    result = subprocess.run(
        ["cmd.exe", "/d", "/c", "OneKeyDeploy.bat"], cwd=workspace,
        input="\n", capture_output=True, text=True,
    )
    assert result.returncode == exit_code, result.stdout + result.stderr
    assert "INERT_DEPLOY_ENTRYPOINT" in result.stdout
    if exit_code:
        assert f"failed with exit code {exit_code}" in result.stdout
    else:
        assert "completed successfully" in result.stdout
