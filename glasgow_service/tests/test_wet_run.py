import asyncio
import os
import unittest
from pathlib import Path

from glasgow_service.config import find_config_path
from glasgow_service.service import DeviceService
from glasgow_service.models  import (
    RasterRequest, VectorRequest, VectorPattern,
)

CONFIG_PATH = os.environ.get("GLASGOW_CONFIG")
if CONFIG_PATH is None:
    resolved = find_config_path(required=False)
    CONFIG_PATH = str(resolved) if resolved else str(
        Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"
    )


def _service_available() -> bool:
    return Path(CONFIG_PATH).is_file()


@unittest.skipUnless(_service_available(), f"no config at {CONFIG_PATH}")
class WetRunRasterTest(unittest.TestCase):
    """Replaces the raster test_scan_wet_run: runs one raster scan with
    values from streamData.json (or overrides below), writes the CSV,
    and asserts the full validation report passes."""

    # Override individual request fields here; anything omitted falls back
    # to the streamData.json defaults via RasterRequest field defaults.
    REQUEST_OVERRIDES: dict = {
        "save_csv": True,
        "do_validate": True,
    }

    def setUp(self):
        self.svc = DeviceService(CONFIG_PATH)
        asyncio.run(self.svc.start())

    def tearDown(self):
        asyncio.run(self.svc.stop())

    def _build_request(self) -> RasterRequest:
        defaults = self.svc.defaults()["raster"]
        payload = {
            "resolution":    defaults.get("resolution", 512),
            "dwell":         defaults.get("dwell", 2),
            "latency_bytes": defaults.get("pixels", 8192) * 2,
            "frame_blank":   defaults.get("frameBlank", False),
        }
        payload.update(self.REQUEST_OVERRIDES)
        return RasterRequest(**payload)

    def test_scan_wet_run(self):
        req = self._build_request()
        print(f"[test] raster req={req.model_dump()}", flush=True)

        result = asyncio.run(self.svc.run_raster(req))

        print(f"[test] result chunks={result.chunks} "
              f"expected={result.expected_chunks} "
              f"pixels_per_chunk={result.pixels_per_chunk} "
              f"send_time={result.send_time_s:.3f}s "
              f"csv={result.csv_path}", flush=True)

        self.assertIsNotNone(result.validation)
        for check in result.validation.checks:
            print(f"  [{'PASS' if check.passed else 'FAIL'}] "
                  f"{check.name}: {check.detail}", flush=True)

        self.assertTrue(
            result.validation.passed,
            f"validation failed: "
            f"{[c.name for c in result.validation.checks if not c.passed]}",
        )


@unittest.skipUnless(_service_available(), f"no config at {CONFIG_PATH}")
class WetRunVectorTest(unittest.TestCase):
    """Replaces the vector test_scan_wet_run: runs one default-pattern
    vector scan, optionally pre-processes, writes the CSV, asserts
    validation passes."""

    REQUEST_OVERRIDES: dict = {
        "pattern":     VectorPattern.default,
        "pre_process": True,
        "save_csv":    True,
        "do_validate": True,
    }

    def setUp(self):
        self.svc = DeviceService(CONFIG_PATH)
        asyncio.run(self.svc.start())

    def tearDown(self):
        asyncio.run(self.svc.stop())

    def _build_request(self) -> VectorRequest:
        defaults = self.svc.defaults()["vector"]
        payload = {"latency_bytes": defaults.get("latency", 8196)}
        payload.update(self.REQUEST_OVERRIDES)
        return VectorRequest(**payload)

    def test_scan_wet_run(self):
        req = self._build_request()
        print(f"[test] vector req={req.model_dump()}", flush=True)

        result = asyncio.run(self.svc.run_vector(req))

        process_s = (f"{result.process_time_s:.3f}s"
                     if result.process_time_s is not None else "n/a")
        print(f"[test] result chunks={result.chunks} bytes={result.bytes} "
              f"process_time={process_s} "
              f"send_time={result.send_time_s:.3f}s "
              f"csv={result.csv_path}", flush=True)

        self.assertIsNotNone(result.validation)
        for check in result.validation.checks:
            print(f"  [{'PASS' if check.passed else 'FAIL'}] "
                  f"{check.name}: {check.detail}", flush=True)

        self.assertTrue(
            result.validation.passed,
            f"validation failed: "
            f"{[c.name for c in result.validation.checks if not c.passed]}",
        )


if __name__ == "__main__":
    unittest.main()
