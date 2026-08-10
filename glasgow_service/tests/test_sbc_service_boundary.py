import json
import subprocess
import sys
from pathlib import Path

from glasgow_service.vacuum import load_vacuum_config


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


def test_sbc_config_has_no_glasgow_device_or_action_requirements():
    payload = json.loads(CONFIG_PATH.read_text())
    assert payload["Transport"] == "raspberry-pi"
    assert "Glasgow" not in payload
    assert "Actions" not in payload

    config = load_vacuum_config(CONFIG_PATH)
    assert config.transport == "raspberry-pi"
    assert config.glasgow == {}
    assert config.actions == []


def test_importing_sbc_service_does_not_import_glasgow_vacuum_adapter():
    code = """
import sys
import glasgow_service.sbc_vacuum_app
forbidden = [name for name in sys.modules
             if name == 'glasgow_service.comparator_subtarget'
             or name.startswith('glasgow.hardware')]
raise SystemExit(1 if forbidden else 0)
"""
    result = subprocess.run([sys.executable, "-c", code], check=False)
    assert result.returncode == 0
