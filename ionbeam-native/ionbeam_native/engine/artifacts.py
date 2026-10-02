"""Out-of-process rendering of scan artifacts (CSV + matplotlib PNG).

The web service renders these synchronously on the event loop that services
USB (DumpData) and again on demand for downloads / FTP. In the desktop app
they run in a separate process, so a 0.5-1.6 s matplotlib render can never
stall acquisition, not even through the GIL. The worker reuses
``DeviceService.last_csv_bytes`` / ``last_figure_png`` so the files are
byte-for-byte what the web stack produces.
"""
from __future__ import annotations

import array
import concurrent.futures
import logging
import multiprocessing
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("ionbeam_native.artifacts")

_SERVICE = None
_SERVICE_CONFIG: Optional[str] = None


def _worker_init() -> None:
    from ..paths import ensure_import_paths
    ensure_import_paths()
    import matplotlib
    matplotlib.use("Agg")


def _service(config_path: str):
    global _SERVICE, _SERVICE_CONFIG
    if _SERVICE is None or _SERVICE_CONFIG != config_path:
        from glasgow_service.service import DeviceService
        _SERVICE = DeviceService(config_path)
        _SERVICE_CONFIG = config_path
    return _SERVICE


def _restore(snapshot: dict) -> dict:
    last = dict(snapshot)
    chunks = []
    for data, code in zip(snapshot.get("chunks", []), snapshot.get("chunk_typecodes", [])):
        arr = array.array(code or "H")
        arr.frombytes(data)
        chunks.append(arr)
    last["chunks"] = chunks
    last.pop("chunk_typecodes", None)
    return last


def render_artifacts(config_path: str, snapshot: dict, *, csv: bool = True, png: bool = True,
                     render_mode: str = "decimated", view: str = "figure") -> dict:
    svc = _service(config_path)
    svc._last = _restore(snapshot)
    out = {"csv": None, "png": None, "csv_filename": svc.last_csv_filename(),
           "png_filename": svc.last_figure_filename()}
    if csv:
        out["csv"] = svc.last_csv_bytes()
    if png:
        out["png"] = svc.last_figure_png(render_mode=render_mode, view=view)
    return out


def dump_artifacts(config_path: str, snapshot: dict) -> list:
    """Same files and names as DeviceService._maybe_dump_last_outputs (~/Output)."""
    svc = _service(config_path)
    svc._last = _restore(snapshot)
    timestamp = time.strftime("%y%m%d_%H%M%S")
    output_dir = Path.home() / "Output"
    output_dir.mkdir(parents=True, exist_ok=True)
    written = []
    csv_path = output_dir / svc._dump_filename("csv", timestamp)
    csv_path.write_bytes(svc.last_dump_csv_bytes())
    written.append(str(csv_path))
    png_path = output_dir / svc._dump_filename("png", timestamp)
    png_path.write_bytes(svc.last_dump_png_bytes())
    written.append(str(png_path))
    return written


class ArtifactWorker:
    """Single worker process; jobs run in submission order."""

    def __init__(self, config_path: str):
        self.config_path = str(config_path)
        self._pool: Optional[concurrent.futures.ProcessPoolExecutor] = None

    def _executor(self) -> concurrent.futures.ProcessPoolExecutor:
        if self._pool is None:
            self._pool = concurrent.futures.ProcessPoolExecutor(
                max_workers=1, mp_context=multiprocessing.get_context("spawn"), initializer=_worker_init)
        return self._pool

    def render(self, snapshot: dict, **kwargs) -> concurrent.futures.Future:
        return self._executor().submit(render_artifacts, self.config_path, snapshot, **kwargs)

    def dump(self, snapshot: dict) -> concurrent.futures.Future:
        future = self._executor().submit(dump_artifacts, self.config_path, snapshot)
        future.add_done_callback(_log_dump)
        return future

    def shutdown(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=False, cancel_futures=True)
            self._pool = None


def _log_dump(future: concurrent.futures.Future) -> None:
    try:
        for path in future.result():
            log.info("wrote dump: %s", path)
    except Exception as exc:  # parity with the service: a dump failure only warns
        log.warning("failed to write CSV/PNG dump: %s", exc)
