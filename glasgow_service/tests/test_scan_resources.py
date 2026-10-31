"""Simulation assets stay shared for reads and private for mutable feedback."""
import array
import asyncio
from pathlib import Path

import pytest

from glasgow_service import scan_assets, service as module
from glasgow_service.models import ROIRequest, RasterRequest, SimulationBitmap, VectorRequest
from glasgow_service.service import DeviceService, _SimulatedCommand

CONFIG = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


@pytest.mark.parametrize("kind,target", [("raster", None), ("vector", None), ("vector", 30)])
def test_assets_share_immutable_pixels_but_isolate_target_feedback(monkeypatch, kind, target):
    bitmap = SimulationBitmap(width=2, height=2, pixels=[80] * 4)
    monkeypatch.setattr(scan_assets, "load", lambda _id: bitmap)
    captured = []

    def build(req, transforms):
        captured.extend(req.parallel_simulation_bitmaps)
        return [array.array("H", [1, 2])]

    monkeypatch.setattr(module, f"_bitmap_{kind}_chunks", build)
    region = ROIRequest(x_start=0, x_end=127, y_start=0, y_end=127)
    common = dict(dwell=1, parallel_rois=[region, region], parallel_simulation_bitmap_ids=["a", "a"])
    req = (RasterRequest(resolution=2, **common) if kind == "raster" else
           VectorRequest(vector_resolution=2, target_gray_level=target, **common))
    device = DeviceService(str(CONFIG))

    async def run():
        return [chunk async for chunk in device._simulated_chunks(kind, req, _SimulatedCommand(), pace=False)]

    assert asyncio.run(run())
    if target is None:
        assert captured == [bitmap, bitmap]
        assert all(item is bitmap for item in captured)
    else:
        assert all(item is not bitmap for item in captured)
        assert captured[0] is not captured[1]
        captured[0].pixels[0] = 0
        assert bitmap.pixels[0] == captured[1].pixels[0] == 80


def test_parallel_raster_converts_a_shared_bitmap_only_once(monkeypatch):
    bitmap = SimulationBitmap(width=2, height=2, pixels=[10, 20, 30, 40])
    region = ROIRequest(x_start=0, x_end=127, y_start=0, y_end=127)
    req = RasterRequest(resolution=2, dwell=1, parallel_rois=[region, region],
                        parallel_simulation_bitmaps=[bitmap, bitmap])
    calls = 0
    original = module._bitmap_sample_grid

    def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(module, "_bitmap_sample_grid", counted)
    samples = [value for chunk in module._bitmap_raster_chunks(req) for value in chunk]
    assert calls == 1
    assert samples[::2] == samples[1::2]


@pytest.mark.parametrize("kind", ["raster", "vector"])
def test_sequential_and_parallel_simulation_have_equal_pacing_per_sample(kind):
    service = DeviceService(str(CONFIG))
    region = ROIRequest(x_start=0, x_end=8191, y_start=0, y_end=8191)
    request = RasterRequest if kind == "raster" else VectorRequest
    size = {"resolution": 1024} if kind == "raster" else {"vector_resolution": 1024}
    sequential = request(**size, dwell=8, latency_bytes=4096, roi=region)
    parallel = request(**size, dwell=8, latency_bytes=4096, parallel_rois=[region, region])
    single = service._prepare_simulated_stream_request(sequential, pace=True)
    combined = service._prepare_simulated_stream_request(parallel, pace=True)
    # Two sequential ROI passes take the same transport delays as one
    # interleaved pass of two ROIs: 128 packets, instead of 4096 packets.
    chunk_samples = single.latency_bytes // single.dwell
    assert chunk_samples == combined.latency_bytes // combined.dwell == 16384
    assert (1024 * 1024 // chunk_samples) * 2 == 128
    assert sequential.latency_bytes == parallel.latency_bytes == 4096
    assert service._prepare_simulated_stream_request(sequential, pace=False) is sequential
