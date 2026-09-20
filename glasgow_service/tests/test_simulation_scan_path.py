"""A simulated scan needs no device, but it must still behave like a scan.

With ``IsProduction=false`` and the simulation enabled:

* the service must never open a Glasgow connection (there may be none);
* chunks must be delivered one at a time as the frame is "acquired", because the
  frontend paints its live canvas from that chunk stream;
* Stop must end the scan, and the pixels must be what the gateware's
  FakeAdcSimulator would have returned for the same DAC codes.

Two earlier behaviours are pinned against here:

* building the whole frame in Python and yielding it in one burst, which made
  the live image appear without a scan ever running, and
* falling through to the physical Glasgow, which made the scan fail to start
  wherever no device is attached.
"""
import array
import asyncio
import math
from pathlib import Path

import numpy as np
import pytest

from GlasgowDataIO.IobeamControl.applet.imageSource import random_image
from GlasgowDataIO.IobeamControl.commands.structs import DACCodeRange
from glasgow_service.models import (
    ROIRequest, RasterRequest, SimulationBitmap, VectorRequest,
)
from glasgow_service.service import (
    DeviceService, _dac_codes, _dac_range_for_bounds, _sample_chunk_to_wire_bytes,
)

CONFIG_PATH = str(
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json")

RANDOM_SOURCE = {"enabled": True, "mode": "image", "source": "random",
                 "seed": 5, "imageResolution": 64, "chunkIntervalMs": 1}


class FakeConnection:
    """Stands in for GlasgowConnection where a test wants the device path."""

    connected = True

    def __init__(self):
        self.calls = []

    async def transfer_multiple(self, command, latency=None):
        self.calls.append(type(command).__name__)
        await asyncio.sleep(0)
        yield array.array("H", [7] * 16)


def make_service(*, simulation=None, production=False, connection=None):
    svc = DeviceService(CONFIG_PATH)
    svc._config.IsProduction = production
    svc._simulation_defaults.clear()
    svc._simulation_defaults.update(simulation or RANDOM_SOURCE)

    async def ensure_conn():
        if connection is None:
            raise AssertionError(
                "the service tried to open a Glasgow connection during a "
                "hardware-free simulated scan")
        return connection

    svc._ensure_conn = ensure_conn
    return svc


def collect(svc, kind, req):
    async def run():
        method = svc.raster_scan if kind == "raster" else svc.vector_scan
        return [wire async for wire in method(req)]
    return asyncio.run(run())


def samples(frames):
    return np.concatenate([np.frombuffer(f, dtype=">u2") for f in frames])


def expected_image_samples(xs, ys, seed=5, side=64):
    image = np.asarray(random_image(side, seed=seed), dtype=np.uint16).reshape(side, side)
    shift = 14 - (side.bit_length() - 1)
    raw = np.array([image[y >> shift, x >> shift] for y in ys for x in xs], dtype=np.uint16)
    return (raw.astype(np.uint32) << 2).astype(np.uint16)


def codes_of(rng):
    return [(rng.start * 256 + i * rng.step) >> 8 for i in range(rng.count)]


def test_simulated_raster_scan_never_opens_the_device():
    svc = make_service()
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096)

    frames = collect(svc, "raster", req)

    per_chunk = math.ceil(req.latency_bytes / req.dwell)
    assert len(frames) == math.ceil(128 * 128 / per_chunk)
    assert sum(len(f) for f in frames) == 128 * 128 * 2


def test_simulated_chunks_are_delivered_one_at_a_time():
    """The generator must give the event loop back between chunks.

    A consumer that never awaits between chunks would see every chunk without
    the ticker advancing if the whole frame were produced in one burst.
    """
    svc = make_service()
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096)

    async def run():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0)
                ticks += 1

        task = asyncio.ensure_future(ticker())
        seen = []
        async for _wire in svc.raster_scan(req):
            seen.append(ticks)
        task.cancel()
        return seen

    seen = asyncio.run(run())
    assert len(seen) > 1
    assert all(b > a for a, b in zip(seen, seen[1:])), \
        f"chunks arrived in an uninterrupted burst: {seen}"


def test_simulated_raster_is_the_fake_adc_image_row_major():
    svc = make_service()
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096)

    got = samples(collect(svc, "raster", req))

    rng = DACCodeRange.from_resolution(128)
    codes = codes_of(rng)
    expected = expected_image_samples(codes, codes)      # X is the fast axis
    assert np.array_equal(got, expected)
    assert not np.array_equal(
        got.reshape(128, 128), got.reshape(128, 128).T), "frame must not be symmetric"


def test_simulated_raster_scans_the_roi_not_the_full_frame():
    svc = make_service()
    roi = ROIRequest(x_start=4096, x_end=12287, y_start=2048, y_end=10239)
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096, roi=roi)

    got = samples(collect(svc, "raster", req))

    xs = codes_of(_dac_range_for_bounds(4096, 12287, 128))
    ys = codes_of(_dac_range_for_bounds(2048, 10239, 128))
    assert np.array_equal(got, expected_image_samples(xs, ys))
    full = samples(collect(svc, "raster", RasterRequest(
        resolution=128, dwell=2, latency_bytes=4096)))
    assert not np.array_equal(got, full)


@pytest.mark.parametrize("resolution,bounds", [
    (128, None), (256, None), (512, None), (128, (100, 3000)), (300, (0, 16383))])
def test_dac_codes_are_the_ones_the_fpga_counter_visits(resolution, bounds):
    lo, hi = bounds if bounds else (0, 16383)
    rng = (DACCodeRange.from_resolution(resolution) if bounds is None
           else _dac_range_for_bounds(lo, hi, resolution))
    assert list(_dac_codes(lo, hi - lo + 1, resolution)) == codes_of(rng)


def test_stop_ends_a_simulated_scan_and_keeps_the_partial_frame():
    svc = make_service()
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=512)   # many chunks

    async def run():
        seen = 0
        async for _wire in svc.raster_scan(req):
            seen += 1
            if seen == 2:
                assert svc.abort_active_scan() is True
        return seen

    seen = asyncio.run(run())
    total = math.ceil(128 * 128 / math.ceil(req.latency_bytes / req.dwell))
    assert 2 <= seen < total
    assert len(svc._last["chunks"]) == seen


def test_simulated_scan_records_the_last_scan_for_the_download_endpoints():
    svc = make_service()
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096)

    collect(svc, "raster", req)

    assert svc._last["kind"] == "raster"
    assert svc._last["resolution"] == 128
    assert sum(len(c) for c in svc._last["chunks"]) == 128 * 128


def test_simulated_vector_scan_is_hardware_free_and_streams():
    svc = make_service()
    req = VectorRequest(vector_resolution=128, dwell=1, latency_bytes=4096)

    async def run():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0)
                ticks += 1

        task = asyncio.ensure_future(ticker())
        seen, frames = [], []
        async for wire in svc.vector_scan(req):
            frames.append(wire)
            seen.append(ticks)
        task.cancel()
        return seen, frames

    seen, frames = asyncio.run(run())
    assert sum(len(f) for f in frames) == 128 * 128 * 2
    assert len(frames) > 1 and all(b > a for a, b in zip(seen, seen[1:]))


def test_blocking_run_raster_and_run_vector_are_hardware_free():
    svc = make_service()

    raster = asyncio.run(svc.run_raster(RasterRequest(
        resolution=128, dwell=2, latency_bytes=4096, do_validate=False)))
    vector = asyncio.run(svc.run_vector(VectorRequest(
        vector_resolution=128, dwell=1, latency_bytes=4096, do_validate=False)))

    assert raster.has_data and raster.bytes == 128 * 128 * 2
    assert vector.has_data and vector.bytes == 128 * 128 * 2


@pytest.mark.parametrize("mode", ["zeros", "loopback"])
def test_zeros_and_loopback_modes(mode):
    svc = make_service(simulation={"enabled": True, "mode": mode, "chunkIntervalMs": 1})
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096)

    got = samples(collect(svc, "raster", req)).reshape(128, 128)

    if mode == "zeros":
        assert not got.any()
    else:                                            # echoes the X DAC code
        expected = np.asarray(codes_of(DACCodeRange.from_resolution(128)), dtype=np.uint32) << 2
        assert np.array_equal(got[0], expected.astype(np.uint16))
        assert np.array_equal(got[0], got[5])


def test_browser_bitmap_scan_is_hardware_free_and_streams():
    svc = make_service()
    bitmap = SimulationBitmap(width=2, height=2, pixels=[0, 85, 170, 255])
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096,
                        simulation_bitmap=bitmap)

    frames = collect(svc, "raster", req)

    assert sum(len(f) for f in frames) == 128 * 128 * 2
    assert len(frames) > 1


def test_production_scan_uses_the_device_even_if_simulation_is_configured():
    conn = FakeConnection()
    svc = make_service(production=True, connection=conn)
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=64)

    collect(svc, "raster", req)

    assert conn.calls == ["RasterScanCommand"]


def test_non_production_with_simulation_switched_off_uses_the_device():
    """IsProduction=false with simulation.enabled=false means a real PCB is attached."""
    conn = FakeConnection()
    svc = make_service(simulation={"enabled": False}, connection=conn)
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=64)

    collect(svc, "raster", req)

    assert conn.calls == ["RasterScanCommand"]
