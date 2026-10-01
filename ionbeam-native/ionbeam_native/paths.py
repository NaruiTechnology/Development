"""Locate the Development tree and make its packages importable.

The desktop app is a standalone folder (``Development/ionbeam-native``) but it
runs the same acquisition code as the web stack, imported in-process:

    GlasgowDataIO, AutomationPy     <- Development/
    glasgow_service                 <- Development/glasgow_service/

``IONBEAM_DEVELOPMENT_ROOT`` overrides the location (e.g. an installed
distribution under ~/IobeamPlatform/Development).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]


def development_root() -> Path:
    override = os.environ.get("IONBEAM_DEVELOPMENT_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return APP_ROOT.parent


def ensure_import_paths() -> Path:
    root = development_root()
    for candidate in (root, root / "glasgow_service"):
        text = str(candidate)
        if candidate.is_dir() and text not in sys.path:
            sys.path.insert(0, text)
    return root


def stream_config_path() -> Path:
    """streamData.json: GLASGOW_CONFIG, then the service's own discovery rules."""
    ensure_import_paths()
    env = os.environ.get("GLASGOW_CONFIG", "").strip()
    if env and Path(env).expanduser().is_file():
        return Path(env).expanduser().resolve()
    try:
        from glasgow_service.config import find_config_path
        found = find_config_path(required=False)
        if found is not None:
            return Path(found)
    except Exception:
        pass
    return development_root() / "GlasgowDataIO" / "Json" / "streamData.json"


def user_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    path = Path(base) / "ionbeam-native"
    path.mkdir(parents=True, exist_ok=True)
    return path


def resource(*parts: str) -> Path:
    return APP_ROOT / "ionbeam_native" / "resources" / Path(*parts)
