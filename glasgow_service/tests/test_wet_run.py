"""Service-layer wet-run tests.

Runs one raster and one vector scan via DeviceService.run_raster /
run_vector, with parameters sourced from streamData.json overridden by
PARAM_OVERRIDES below. Asserts the full validation report passes.

Two things were broken in the previous version and have been fixed here:
  * `save_csv` / `csv_path` no longer exist on RasterRequest / ScanResult
    (CSV is on-demand from /scan/last/csv now). References to them are
    removed.
  * Defaults were pulled from the camelCase JSON keys directly
    (`pixels`, `frameBlank`, `latency`). They now come through
    DeviceService.defaults()["raster_params"] / ["vector_params"], which
    are normalized snake_case from RasterParams / VectorParams — so this
    test is a check that the JSON-to-API translation is intact.
"""
import asyncio
import unittest
from pathlib import Path

from glasgow_service.service import DeviceService
from glasgow_service.models import (
    RasterRequest, VectorRequest, VectorPattern,
)
from glasgow_service.config import find_config_path

CONFIG_PATH = str(find_config_path(required=False) or "")


def _service_available() -> bool:
    return Path(CONFIG_PATH).is_file()


@unittest.skipUnless(_service_available(), f"no config at {CONFIG_PATH}")
class WetRunRasterTest(unittest.TestCase):
    """Runs one raster scan with values from streamData.json overridden by
    PARAM_OVERRIDES, asserts the validation report passes, and confirms
    the in-memory cache for /scan/last/csv was populated."""

    # Anything in here wins over streamData.json. The Pydantic model
    # supplies its own defaults for anything missing from both sides.
    PARAM_OVERRIDES: dict = {
        "do_validate": True,
    }

    def setUp(self):
        self.svc = DeviceService(CONFIG_PATH)
        self.svc._config.IsProduction = False
        self.svc._simulation_defaults["enabled"] = True
        asyncio.run(self.svc.start())

    def tearDown(self):
        asyncio.run(self.svc.stop())

    def _build_request(self) -> RasterRequest:
        # Pull normalized snake_case defaults from the service. The raw
        # camelCase JSON block is also under defaults()["raster"] for any
        # caller that needs it, but this test wants the API shape.
        params = self.svc.defaults().get("raster_params", {}) or {}
        payload = {
            "resolution":    params.get("resolution", 512),
            "dwell":         params.get("dwell", 2),
            "latency_bytes": params.get("latency_bytes", 16384),
            "frame_blank":   params.get("frame_blank", False),
            "output_mode":   params.get("output_mode", "SixteenBit"),
            "cookie":        params.get("cookie", 123),
        }
        payload.update(self.PARAM_OVERRIDES)
        return RasterRequest(**payload)

    def test_scan_wet_run(self):
        req = self._build_request()
        print(f"[test] raster req={req.model_dump()}", flush=True)

        result = asyncio.run(self.svc.run_raster(req))

        # csv_path was removed from ScanResult; CSV is on-demand from
        # /scan/last/csv and the in-memory cache. has_data tells us
        # the cache is populated.
        print(f"[test] result chunks={result.chunks} "
              f"expected={result.expected_chunks} "
              f"pixels_per_chunk={result.pixels_per_chunk} "
              f"send_time={result.send_time_s:.3f}s "
              f"has_data={result.has_data}", flush=True)

        self.assertTrue(result.has_data,
                        "result.has_data is False — in-memory cache not populated, "
                        "so /scan/last/csv would 404")
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
    """Runs one default-pattern vector scan with pre-processing on,
    asserts validation passes."""

    PARAM_OVERRIDES: dict = {
        "pattern":     VectorPattern.default,
        "pre_process": True,
        "do_validate": True,
    }

    def setUp(self):
        self.svc = DeviceService(CONFIG_PATH)
        self.svc._config.IsProduction = False
        self.svc._simulation_defaults["enabled"] = True
        asyncio.run(self.svc.start())

    def tearDown(self):
        asyncio.run(self.svc.stop())

    def _build_request(self) -> VectorRequest:
        params = self.svc.defaults().get("vector_params", {}) or {}
        payload = {
            "latency_bytes":     params.get("latency_bytes", 8196),
            "vector_resolution": params.get("vector_resolution", 2048),
            "output_mode":       params.get("output_mode", "SixteenBit"),
            "cookie":            params.get("cookie", 123),
        }
        payload.update(self.PARAM_OVERRIDES)
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
              f"has_data={result.has_data}", flush=True)

        self.assertTrue(result.has_data,
                        "result.has_data is False — in-memory cache not populated")
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
