import array
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from glasgow_service.models import DeviceState, ServiceStatus
from glasgow_service.service import (
    DeviceService,
    DeviceNotReady,
    _AdcPresenceMonitor,
    _assert_production_adc_present,
    _production_adc_fault,
)


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


def test_production_presence_check_rejects_sustained_raw_u14_full_scale():
    chunks = [array.array("H", [0x3FFF] * 128) for _ in range(2)]

    with unittest.TestCase().assertRaisesRegex(
            DeviceNotReady, "ADC/subtarget presence check failed"):
        _assert_production_adc_present(
            SimpleNamespace(IsProduction=True), chunks)


def test_production_presence_check_accepts_a_non_saturated_sample():
    chunks = [array.array("H", [0x3FFF] * 256)]
    chunks[0][173] = 0x3FFE

    _assert_production_adc_present(
        SimpleNamespace(IsProduction=True), chunks)


def test_presence_check_accepts_short_full_scale_diagnostic_scan():
    chunks = [array.array("H", [0x3FFF] * 255)]

    assert _production_adc_fault(chunks) is None


def test_presence_check_recognizes_left_aligned_and_eight_bit_full_scale():
    assert _production_adc_fault([array.array("H", [0xFFFC] * 256)])
    assert _production_adc_fault([array.array("B", [0xFF] * 256)])
    assert _production_adc_fault([array.array("B", [0x3F] * 256)])


def test_presence_monitor_warns_on_the_first_conclusive_chunk():
    monitor = _AdcPresenceMonitor(enabled=True, minimum_samples=256)

    assert monitor.observe(array.array("H", [0x3FFF] * 128)) is None
    fault = monitor.observe(array.array("H", [0x3FFF] * 128))

    assert fault is not None
    assert "first 256 returned samples" in fault


def test_presence_monitor_stops_checking_after_presence_is_established():
    monitor = _AdcPresenceMonitor(enabled=True, minimum_samples=256)

    assert monitor.observe(array.array("H", [0x3FFF, 0x1234])) is None
    assert monitor.observe(array.array("H", [0x3FFF] * 256)) is None


def test_presence_monitor_collects_bounded_diagnostics_after_presence():
    monitor = _AdcPresenceMonitor(enabled=True, minimum_samples=256)

    monitor.observe(array.array("H", [0x3FFF, 0x1234, 0x1234]))
    monitor.observe(array.array("H", [0x3DFD] * 100))

    summary = monitor.summary()
    assert summary is not None
    assert "samples=103" in summary
    assert "min=0x1234" in summary
    assert "max=0x3fff" in summary
    assert "unique=3" in summary
    assert "full_scale=1" in summary


def test_simulation_presence_check_allows_sustained_full_scale():
    chunks = [array.array("H", [0x3FFF] * 256)]

    _assert_production_adc_present(
        SimpleNamespace(IsProduction=False), chunks)


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
