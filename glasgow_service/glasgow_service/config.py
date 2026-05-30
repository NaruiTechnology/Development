"""Resolve the path to the Glasgow service configuration JSON.

The path used to be a hard-coded literal repeated in ``api.py`` and the
wet-run tests. This module replaces that literal with a small cascade so
the same code works on a developer laptop, in CI, and on the production
box without source edits.

Resolution order (first match wins):

1. ``GLASGOW_CONFIG`` environment variable (set directly, by the Windows
   restart wrapper, or by a service manager).
2. ``GLASGOW_CONFIG`` read from a custom env file pointed to by the
   ``GLASGOW_ENV_FILE`` environment variable.
3. ``GLASGOW_CONFIG`` read from ``deploy/glasgow-svc.env``. On Linux this
   sits next to the bundled systemd unit; on Windows the PowerShell restart
   wrapper usually sets the environment directly.
4. On non-Windows hosts, ``GLASGOW_CONFIG`` parsed out of
   ``deploy/glasgow-svc.service`` itself.
5. A ``streamData.json`` discovered next to the package or in CWD.

On Windows, stale deployment paths ending in
``GlasgowDataIO/Json/streamData.json`` are translated to the same file
under this checkout when possible.

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

# deploy/ lives next to this package's project directory, while the main
# Development repo is one level above that on a checkout.
_SERVICE_ROOT = Path(__file__).resolve().parent.parent
_PROJECT_ROOT = _SERVICE_ROOT.parent
_DEPLOY_DIR = _SERVICE_ROOT / "deploy"
_DEFAULT_ENV_FILE = _DEPLOY_DIR / "glasgow-svc.env"
_DEFAULT_UNIT_FILE = _DEPLOY_DIR / "glasgow-svc.service"

_LOCAL_CANDIDATES: tuple[Path, ...] = (
    Path.cwd() / "streamData.json",
    _SERVICE_ROOT / "streamData.json",
    _DEPLOY_DIR / "streamData.json",
    _PROJECT_ROOT / "GlasgowDataIO" / "Json" / "streamData.json",
)

_STREAMDATA_TAIL = ("GlasgowDataIO", "Json", "streamData.json")

_UNIT_ENV_RE = re.compile(
    r"^\s*Environment\s*=\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$"
)


# ---- low-level parsers ----------------------------------------------------

def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a simple ``KEY=value`` env file.

    Compatible with systemd-style ``EnvironmentFile`` syntax used by the
    Linux service, while also being usable from Windows tooling.
    """
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
    """Extract ``Environment=KEY=VAL`` lines from a Linux systemd unit file."""
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
    candidates = [
        ("environment", os.environ.get(ENV_VAR)),
        (f"env file {_resolve_env_file_path()}",
         _parse_env_file(_resolve_env_file_path()).get(ENV_VAR)),
    ]
    if os.name != "nt":
        candidates.append(
            (f"systemd unit {_DEFAULT_UNIT_FILE}",
             _parse_systemd_unit(_DEFAULT_UNIT_FILE).get(ENV_VAR))
        )
    return candidates


def _matches_streamdata_tail(path: Path) -> bool:
    parts = tuple(path.parts)
    return len(parts) >= len(_STREAMDATA_TAIL) and parts[-3:] == _STREAMDATA_TAIL


def _windows_equivalent_paths(path: Path) -> tuple[Path, ...]:
    """Return repo-local equivalents for known deployment paths on Windows."""
    if os.name != "nt" or not _matches_streamdata_tail(path):
        return ()
    return (_PROJECT_ROOT / "GlasgowDataIO" / "Json" / "streamData.json",)


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
        for equivalent in _windows_equivalent_paths(candidate):
            if equivalent.is_file():
                log.debug(
                    "Glasgow config resolved from Windows equivalent of %s -> %s",
                    source,
                    equivalent,
                )
                return equivalent.resolve()
        if required:
            equivalents = tuple(_windows_equivalent_paths(candidate))
            equivalent_hint = ""
            if equivalents:
                equivalent_hint = (
                    " Windows equivalent candidates were also checked: "
                    + ", ".join(str(p) for p in equivalents)
                    + "."
                )
            raise FileNotFoundError(
                f"{ENV_VAR} from {source} points to {candidate}, "
                f"which does not exist.{equivalent_hint}"
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
    systemd_attempt = ""
    if os.name != "nt":
        systemd_attempt = (
            f"  - systemd unit {_DEFAULT_UNIT_FILE} "
            f"({'present' if _DEFAULT_UNIT_FILE.is_file() else 'missing'})\n"
        )
    raise FileNotFoundError(
        f"Could not locate streamData.json.\n"
        f"Resolution attempts:\n"
        f"  - {ENV_VAR} environment variable (unset)\n"
        f"  - env file {_resolve_env_file_path()} "
        f"({'present' if _resolve_env_file_path().is_file() else 'missing'})\n"
        f"{systemd_attempt}"
        f"  - local fallbacks:\n  {searched}\n"
        f"Set {ENV_VAR} to the full path of streamData.json, fill in "
        f"{_DEFAULT_ENV_FILE}, or place streamData.json in one of the "
        f"local fallback locations above."
    )
