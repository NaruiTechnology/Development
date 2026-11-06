"""DumpData must not run inside the scan's device-lock critical section.

The CSV/PNG render takes seconds for a live frame. Written inline it delayed
the next scan (Stop -> Zoom/Parallel restart); it now runs on a worker from a
frozen snapshot of the last scan.
"""
import threading
import time

from glasgow_service import service as service_module
from tests.test_dump_scan_params import make_service


def _prime(svc):
    svc._set_last_scan(None, {"kind": "vector", "chunks": [[1, 2, 3]], "latency_bytes": 1})


def test_dump_does_not_block_the_caller(monkeypatch, tmp_path):
    monkeypatch.setattr(service_module.Path, "home", classmethod(lambda cls: tmp_path))
    svc = make_service()
    svc._config.DumpData = True
    release, seen = threading.Event(), {}

    def slow_csv(self):
        seen["thread"] = threading.current_thread().name
        release.wait(5)
        return b"csv"

    monkeypatch.setattr(service_module.DeviceService, "last_dump_csv_bytes", slow_csv)
    monkeypatch.setattr(service_module.DeviceService, "last_dump_png_bytes", lambda self: b"png")

    t0 = time.monotonic()
    _prime(svc)                       # returns while the dump is still blocked
    assert time.monotonic() - t0 < 1.0
    release.set()
    service_module._DUMP_EXECUTOR.submit(lambda: None).result(5)   # drain the worker
    assert seen["thread"].startswith("dumpdata")
    assert (tmp_path / "Output").exists()
    assert len(list((tmp_path / "Output").iterdir())) == 2


def test_dump_uses_a_frozen_snapshot(monkeypatch, tmp_path):
    monkeypatch.setattr(service_module.Path, "home", classmethod(lambda cls: tmp_path))
    svc = make_service()
    svc._config.DumpData = True
    gate, kinds = threading.Event(), []

    def csv_bytes(self):
        gate.wait(5)
        kinds.append(self._last["kind"])
        return b"x"

    monkeypatch.setattr(service_module.DeviceService, "last_dump_csv_bytes", csv_bytes)
    monkeypatch.setattr(service_module.DeviceService, "last_dump_png_bytes", lambda self: b"p")
    _prime(svc)                                                   # vector
    svc._last = {"kind": "raster", "chunks": [[1]], "resolution": 1}   # a newer scan ends
    gate.set()
    service_module._DUMP_EXECUTOR.submit(lambda: None).result(5)
    assert kinds == ["vector"]
