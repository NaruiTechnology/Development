import json
import os
import subprocess
import sys
from pathlib import Path

from glasgow_service.vacuum import load_vacuum_config


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def test_sbc_config_has_no_glasgow_device_or_action_requirements():
    payload = json.loads(CONFIG_PATH.read_text())
    assert "Transport" not in payload
    assert "Glasgow" not in payload
    assert "Actions" not in payload

    config = load_vacuum_config(CONFIG_PATH)
    assert config.sbc.id == "raspberry-pi-vacuum"


def test_importing_sbc_service_does_not_import_glasgow_vacuum_adapter():
    code = """
import sys
import glasgow_service.sbc_vacuum_app
forbidden = [name for name in sys.modules
             if name == 'glasgow_service.comparator_subtarget'
             or name.startswith('glasgow.hardware')]
raise SystemExit(1 if forbidden else 0)
"""
    package_root = str(Path(__file__).parents[1])
    env = os.environ.copy()
    env["PYTHONPATH"] = package_root + os.pathsep + env.get("PYTHONPATH", "")
    result = subprocess.run(
        [sys.executable, "-c", code],
        check=False,
        env=env,
    )
    assert result.returncode == 0
