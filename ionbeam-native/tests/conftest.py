import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from ionbeam_native.paths import ensure_import_paths, stream_config_path  # noqa: E402

ensure_import_paths()


@pytest.fixture
def stream_config(tmp_path, monkeypatch):
    """Production-mode stream config (hardware path) with dumps off."""
    monkeypatch.chdir(tmp_path)  # service loggers write *.log into cwd
    monkeypatch.setenv("IONBEAM_DEVICE_LOCK", str(tmp_path / "device.lock"))
    cfg = json.load(open(stream_config_path()))
    cfg["IsProduction"] = True
    cfg["DumpData"] = False
    path = tmp_path / "stream.json"
    path.write_text(json.dumps(cfg))
    return str(path)
