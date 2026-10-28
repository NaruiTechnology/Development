"""Bounded, content-addressed storage for scan simulation bitmaps.

Uploads are split into small HTTP requests so no WebSocket message needs to
carry a bitmap. Completed assets survive a service restart and are immutable.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from functools import lru_cache
from pathlib import Path

from .models import SimulationBitmap

MAX_ASSET_BYTES = 64 * 1024 * 1024
MAX_CHUNK_BYTES = 1024 * 1024
_LOCK = threading.RLock()


def _directory() -> Path:
    default_root = (
        Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        if os.name == "nt"
        else Path.home() / ".local" / "share"
    )
    root = Path(os.environ.get(
        "GLASGOW_SCAN_ASSET_DIR",
        str(default_root / "glasgow-service" / "scan-assets"),
    ))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _paths(asset_id: str) -> tuple[Path, Path, Path]:
    if len(asset_id) != 64 or any(c not in "0123456789abcdef" for c in asset_id):
        raise ValueError("invalid scan asset ID")
    root = _directory()
    return root / f"{asset_id}.json", root / f"{asset_id}.part", root / f"{asset_id}.size"


def prepare(asset_id: str, total_bytes: int) -> dict:
    if not 0 < total_bytes <= MAX_ASSET_BYTES:
        raise ValueError(f"scan asset must be 1..{MAX_ASSET_BYTES} bytes")
    complete, partial, size_file = _paths(asset_id)
    with _LOCK:
        if complete.exists():
            return {"asset_id": asset_id, "cached": True, "offset": total_bytes}
        if size_file.exists():
            if int(size_file.read_text()) != total_bytes:
                raise ValueError("asset ID is already uploading with another size")
        else:
            size_file.write_text(str(total_bytes))
            partial.touch(exist_ok=True)
        offset = partial.stat().st_size
        if offset > total_bytes:
            raise ValueError("partial asset exceeds declared size")
        return {"asset_id": asset_id, "cached": False, "offset": offset}


def append(asset_id: str, offset: int, chunk: bytes) -> dict:
    complete, partial, size_file = _paths(asset_id)
    if not chunk or len(chunk) > MAX_CHUNK_BYTES:
        raise ValueError(f"chunk must be 1..{MAX_CHUNK_BYTES} bytes")
    with _LOCK:
        if complete.exists():
            return {"asset_id": asset_id, "offset": complete.stat().st_size}
        if not size_file.exists() or not partial.exists():
            raise ValueError("prepare scan asset before sending chunks")
        total = int(size_file.read_text())
        current = partial.stat().st_size
        if offset < current and offset + len(chunk) <= current:
            with partial.open("rb") as stream:
                stream.seek(offset)
                if stream.read(len(chunk)) == chunk:
                    return {"asset_id": asset_id, "offset": current}
        if offset != current or offset + len(chunk) > total:
            raise ValueError(f"expected chunk offset {current}")
        with partial.open("ab") as stream:
            stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        return {"asset_id": asset_id, "offset": offset + len(chunk)}


def complete_upload(asset_id: str) -> dict:
    complete, partial, size_file = _paths(asset_id)
    with _LOCK:
        if complete.exists():
            return {"asset_id": asset_id, "cached": True}
        if not size_file.exists() or not partial.exists():
            raise ValueError("scan asset upload is missing")
        expected = int(size_file.read_text())
        if partial.stat().st_size != expected:
            raise ValueError("scan asset upload is incomplete")
        raw = partial.read_bytes()
        if hashlib.sha256(raw).hexdigest() != asset_id:
            raise ValueError("scan asset checksum mismatch")
        SimulationBitmap.model_validate(json.loads(raw))
        os.replace(partial, complete)
        size_file.unlink(missing_ok=True)
        _load.cache_clear()
        return {"asset_id": asset_id, "cached": False}


@lru_cache(maxsize=4)
def _load(asset_id: str) -> SimulationBitmap:
    complete, _, _ = _paths(asset_id)
    if not complete.exists():
        raise ValueError(f"scan asset {asset_id} is missing; upload it again")
    return SimulationBitmap.model_validate_json(complete.read_bytes())


def load(asset_id: str) -> SimulationBitmap:
    return _load(asset_id)
