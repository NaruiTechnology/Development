"""Resolve the path to the Glasgow service configuration JSON.

The path used to be a hard-coded literal repeated in ``api.py`` and the
wet-run tests. This module replaces that literal with a small cascade so
the same code works on a developer laptop, in CI, and on the production
box without source edits.

Resolution order (first match wins):

1. ``GLASGOW_CONFIG`` environment variable (set directly, or by the
   systemd unit's ``Environment=``/``EnvironmentFile=`` directives).
2. ``GLASGOW_CONFIG`` read from a custom env file pointed to by the
   ``GLASGOW_ENV_FILE`` environment variable.
3. ``GLASGOW_CONFIG`` read from ``deploy/glasgow-svc.env`` next to the
   bundled systemd unit (the recommended local-dev location; copy the
   committed ``glasgow-svc.env.example`` and edit).
4. ``GLASGOW_CONFIG`` parsed out of ``deploy/glasgow-svc.service``
   itself (so any value committed there is honoured automatically).
5. A ``streamData.json`` discovered next to the package or in CWD.

Pass ``required=False`` from tests so they skip cleanly on a box with no
config rather than raising at import time.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Optional

__all__ = ["find_config_path", "ENV_VAR", "ENV_FILE_VAR"]

log = logging.getLogger("glasgow_service.config")

ENV_VAR = "GLASGOW_CONFIG"
ENV_FILE_VAR = "GLASGOW_ENV_FILE"

# deploy/ lives next to the package directory in the source tree:
#     <repo>/glasgow_service/config.py   <-- this file
#     <repo>/deploy/glasgow-svc.service
#     <repo>/deploy/glasgow-svc.env       (gitignored, optional)
_REPO_ROOT = Path(__file__).resolve().parent.parent
_DEPLOY_DIR = _REPO_ROOT / "deploy"
_DEFAULT_ENV_FILE = _DEPLOY_DIR / "glasgow-svc.env"
_DEFAULT_UNIT_FILE = _DEPLOY_DIR / "glasgow-svc.service"

_LOCAL_CANDIDATES: tuple[Path, ...] = (
    Path.cwd() / "streamData.json",
    _REPO_ROOT / "streamData.json",
    _DEPLOY_DIR / "streamData.json",
)

_UNIT_ENV_RE = re.compile(
    r"^\s*Environment\s*=\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$"
)


# ---- low-level parsers ----------------------------------------------------

def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a ``KEY=value`` env file the way systemd's ``EnvironmentFile``
    would. Supports ``#`` comments and surrounding single/double quotes."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            out[key] = val
    return out


def _parse_systemd_unit(path: Path) -> dict[str, str]:
    """Extract ``Environment=KEY=VAL`` lines from a systemd unit file."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for raw in path.read_text().splitlines():
        m = _UNIT_ENV_RE.match(raw)
        if m:
            out[m.group(1)] = m.group(2)
    return out


# ---- candidate sources ----------------------------------------------------

def _resolve_env_file_path() -> Path:
    """The env file we'll consult after the live environment.

    Honours ``GLASGOW_ENV_FILE`` for non-default locations; otherwise
    falls back to the deploy/-tracked file.
    """
    custom = os.environ.get(ENV_FILE_VAR)
    return Path(custom).expanduser() if custom else _DEFAULT_ENV_FILE


def _candidate_values() -> list[tuple[str, Optional[str]]]:
    """Ordered (source-label, raw-value) pairs to try in turn."""
    return [
        ("environment", os.environ.get(ENV_VAR)),
        (f"env file {_resolve_env_file_path()}",
         _parse_env_file(_resolve_env_file_path()).get(ENV_VAR)),
        (f"systemd unit {_DEFAULT_UNIT_FILE}",
         _parse_systemd_unit(_DEFAULT_UNIT_FILE).get(ENV_VAR)),
    ]


# ---- public API -----------------------------------------------------------

def find_config_path(required: bool = True) -> Optional[Path]:
    """Locate ``streamData.json`` for the current environment.

    :param required: when True (default), raise ``FileNotFoundError`` if
        nothing can be located, or if a value resolves to a non-existent
        file. When False, return ``None`` instead — useful from tests
        that should skip rather than error on a box without a device.
    :return: an absolute :class:`Path`, or ``None`` if ``required`` is
        False and no config could be resolved.
    """
    for source, value in _candidate_values():
        if not value:
            continue
        candidate = Path(value).expanduser()
        if candidate.is_file():
            log.debug("Glasgow config resolved from %s -> %s", source, candidate)
            return candidate.resolve()
        if required:
            raise FileNotFoundError(
                f"{ENV_VAR} from {source} points to {candidate}, "
                f"which does not exist."
            )
        # Source said something but the file is missing; don't fall through
        # silently to local discovery -- the user clearly intended this path.
        return None

    for c in _LOCAL_CANDIDATES:
        if c.is_file():
            log.debug("Glasgow config discovered locally at %s", c)
            return c.resolve()

    if not required:
        return None

    searched = "\n  ".join(str(c) for c in _LOCAL_CANDIDATES)
    raise FileNotFoundError(
        f"Could not locate streamData.json.\n"
        f"Resolution attempts:\n"
        f"  - {ENV_VAR} environment variable (unset)\n"
        f"  - env file {_resolve_env_file_path()} "
        f"({'present' if _resolve_env_file_path().is_file() else 'missing'})\n"
        f"  - systemd unit {_DEFAULT_UNIT_FILE} "
        f"({'present' if _DEFAULT_UNIT_FILE.is_file() else 'missing'})\n"
        f"  - local fallbacks:\n  {searched}\n"
        f"Set {ENV_VAR}=/path/to/streamData.json, fill in "
        f"{_DEFAULT_ENV_FILE}, or place streamData.json in one of the "
        f"local fallback locations above."
    )
