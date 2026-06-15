import array
import asyncio
import unittest
from unittest.mock import patch

from glasgow_service.models import DeviceState, ServiceStatus
from glasgow_service.service import DeviceService, DeviceNotReady


class GlasgowDeviceError(Exception):
    pass


def test_raster_validation_allows_zero_valued_full_chunks():
    svc = object.__new__(DeviceService)
    pixels_per_chunk = 8192
    expected_chunks = 128
    chunks = [array.array("H", [0] * pixels_per_chunk) for _ in range(expected_chunks)]

    validation = svc._validate_raster(chunks, pixels_per_chunk, expected_chunks)

    assert validation.passed
    assert [check.name for check in validation.checks] == [
        "chunk_count",
        "full_chunk_sizes",
        "tail_chunk_size",
    ]


def test_vector_validation_allows_zero_valued_chunks():
    svc = object.__new__(DeviceService)
    chunks = [array.array("H", [0] * 4098) for _ in range(512)]

    validation = svc._validate_vector(chunks)

    assert validation.passed
    assert [check.name for check in validation.checks] == [
        "non_zero_chunks",
        "all_chunks_non_empty",
    ]


class EnsureConnErrorTest(unittest.TestCase):
    def test_missing_device_is_reported_as_device_not_ready(self):
        svc = object.__new__(DeviceService)
        svc._config = object()
        svc._conn = None
        svc._status = ServiceStatus(state=DeviceState.DISCONNECTED)

        class BrokenConnection:
            def __init__(self, _config):
                pass

            async def _connect(self):
                raise GlasgowDeviceError("device not found")

        with patch("glasgow_service.service.GlasgowConnection", BrokenConnection):
            with self.assertRaises(DeviceNotReady) as ctx:
                asyncio.run(svc._ensure_conn())

        self.assertIn("device not found", str(ctx.exception))
        self.assertEqual(svc._status.state, DeviceState.ERROR)
        self.assertIn("device not found", svc._status.last_error)
