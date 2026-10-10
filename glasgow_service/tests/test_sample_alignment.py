"""All hardware-free simulators send samples the way the gateware does.

The gateware sends every scan sample OBI-aligned: the 14-bit ADC code left-aligned in 16
bits (code << 2, full scale 0xFFFC). If one simulator kept the raw 14-bit form, the same
input would display four times darker through it (a white bitmap at gray 64/255) and
would not match the configured simulators.
"""
import asyncio
from pathlib import Path

import numpy as np

from glasgow_service.models import RasterRequest, SimulationBitmap, VectorRequest, VectorPattern
from glasgow_service.service import (
    DeviceService, _bitmap_raster_chunks, _bitmap_vector_chunks, _obi_aligned_int, _obi_aligned_np,
)

CONFIG_PATH = str(
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json")
WHITE = SimulationBitmap(width=2, height=2, pixels=[255, 255, 255, 255])


def all_samples(chunks):
    return np.concatenate([np.asarray(c, dtype=np.uint16) for c in chunks])


def configured_samples(kind, mode, **extra):
    async def run():
        svc = DeviceService(CONFIG_PATH)
        svc._config.IsProduction = False
        svc._simulation_defaults.clear()
        svc._simulation_defaults.update({"enabled": True, "mode": mode, "chunkIntervalMs": 0, **extra})
        if kind == "raster":
            stream = svc.raster_scan(RasterRequest(resolution=128, dwell=2, latency_bytes=4096))
        else:
            stream = svc.vector_scan(VectorRequest(vector_resolution=128, dwell=1, latency_bytes=4096))
        return [np.frombuffer(b, dtype=">u2") for b in [b async for b in stream]]
    return np.concatenate(asyncio.run(run()))


def test_helpers_are_the_gateware_shift():
    assert _obi_aligned_int(0x3FFF) == 0xFFFC
    assert list(_obi_aligned_np([0, 1, 0x3FFF])) == [0, 4, 0xFFFC]


def test_bitmap_raster_simulator_is_obi_aligned():
    req = RasterRequest(resolution=128, dwell=2, latency_bytes=4096, simulation_bitmap=WHITE)
    samples = all_samples(_bitmap_raster_chunks(req))
    assert set(samples.tolist()) == {255 * 256}
    assert not (samples & 3).any()


def test_bitmap_vector_simulator_is_obi_aligned():
    req = VectorRequest(pattern=VectorPattern.custom, vector_resolution=2048, dwell=1, latency_bytes=64,
                        points=[{"x": 0, "y": 0, "dwell": 1, "blank": False}], simulation_bitmap=WHITE)
    assert set(all_samples(_bitmap_vector_chunks(req)).tolist()) == {255 * 256}


def test_configured_simulators_are_obi_aligned():
    for kind in ("raster", "vector"):
        samples = configured_samples(kind, "loopback")          # echoes the X DAC code
        assert not (samples & 3).any(), f"{kind}: low two bits must be zero"
        assert samples.max() > 0x3FFF, f"{kind}: values must exceed the raw 14-bit range"
        assert samples.max() <= 0xFFFC


def test_bitmap_and_configured_simulators_share_one_scale():
    """A white input is (nearly) full scale everywhere, never a quarter of it."""
    bitmap_max = all_samples(_bitmap_raster_chunks(
        RasterRequest(resolution=128, dwell=2, latency_bytes=4096, simulation_bitmap=WHITE))).max()
    loopback_max = configured_samples("raster", "loopback").max()
    assert bitmap_max > 0xF000 and loopback_max > 0xF000
