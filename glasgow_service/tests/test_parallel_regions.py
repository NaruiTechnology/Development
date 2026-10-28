"""Multiple ROI areas share one command and preserve their sample order."""

from pathlib import Path
import asyncio

import pytest

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from glasgow_service.models import ROIRequest, RasterRequest, SimulationBitmap, VectorRequest, VectorScanPath
from glasgow_service.service import (
    DeviceService, _bitmap_raster_chunks, _bitmap_vector_chunks, _parallel_roi_iter,
    _bitmap_sample_point, _roi_vector_iter, _simulated_vector_chunks, _SimulatedCommand,
)


CONFIG = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"
REGIONS = [
    ROIRequest(x_start=0, x_end=127, y_start=0, y_end=127),
    ROIRequest(x_start=8192, x_end=8319, y_start=8192, y_end=8319),
]


def test_parallel_points_visit_both_areas_in_one_sequence():
    points = list(_parallel_roi_iter(2, REGIONS, 3, VectorScanPath.horizontal_sawtooth))
    assert len(points) == 8
    assert all(x <= 127 and y <= 127 for x, y, _ in points[::2])
    assert all(x >= 8192 and y >= 8192 for x, y, _ in points[1::2])
    first_roi = _parallel_roi_iter(2, REGIONS[:1], 3, VectorScanPath.horizontal_sawtooth)
    second_roi = _parallel_roi_iter(2, REGIONS[1:], 3, VectorScanPath.horizontal_sawtooth)
    assert [point for point in points[::2]] == list(first_roi)
    assert [point for point in points[1::2]] == list(second_roi)


def test_both_scan_kinds_build_one_vector_command_for_parallel_areas():
    service = DeviceService(str(CONFIG))
    raster = service._build_raster_cmd(RasterRequest(
        resolution=2, dwell=2, parallel_rois=REGIONS,
    ))
    vector = service._build_vector_cmd(VectorRequest(
        vector_resolution=2, dwell=2, parallel_rois=REGIONS,
    ))
    assert isinstance(raster, VectorScanCommand)
    assert isinstance(vector, VectorScanCommand)
    assert raster.pass_pixels == vector.pass_pixels == 8


def test_bitmap_parallel_raster_stream_has_both_region_frames():
    req = RasterRequest(
        resolution=2, dwell=2, latency_bytes=8, parallel_rois=REGIONS,
        parallel_simulation_bitmaps=[
            SimulationBitmap(width=2, height=2, pixels=[10] * 4),
            SimulationBitmap(width=2, height=2, pixels=[20] * 4),
        ],
    )
    chunks = _bitmap_raster_chunks(req)
    assert chunks is not None
    samples = [sample for chunk in chunks for sample in chunk]
    assert len(samples) == 8
    assert samples == [samples[0], samples[1]] * 4
    assert samples[0] != samples[1]


def test_bitmap_parallel_vector_samples_follow_interleaved_dac_order():
    req = VectorRequest(
        vector_resolution=2, dwell=1, latency_bytes=2, parallel_rois=REGIONS,
        parallel_simulation_bitmaps=[
            SimulationBitmap(width=2, height=2, pixels=[10] * 4),
            SimulationBitmap(width=2, height=2, pixels=[20] * 4),
        ],
    )
    chunks = _bitmap_vector_chunks(req)
    assert chunks is not None
    samples = [sample for chunk in chunks for sample in chunk]
    assert len(samples) == 8
    assert samples == [samples[0], samples[1]] * 4
    assert samples[0] != samples[1]


@pytest.mark.parametrize("path", list(VectorScanPath))
@pytest.mark.parametrize("dwell", [1, 16])
def test_vectorized_bitmap_matches_scalar_sampling_for_every_path(path, dwell):
    bitmap = SimulationBitmap(width=3, height=2, pixels=[0, 10, 255, 72, 99, 120])
    roi = ROIRequest(x_start=500, x_end=1499, y_start=2000, y_end=2799)
    req = VectorRequest(vector_resolution=8, dwell=dwell, latency_bytes=33,
                        scan_path=path, roi=roi, simulation_bitmap=bitmap)
    expected = [_bitmap_sample_point(bitmap, roi, x, y) << 2
                for x, y, _ in _roi_vector_iter(8, roi, dwell, path)]
    chunks = _bitmap_vector_chunks(req)
    assert [v for chunk in chunks for v in chunk] == expected
    assert all(len(chunk) <= min(65536, (33 + dwell - 1) // dwell) for chunk in chunks)


@pytest.mark.parametrize("path", list(VectorScanPath))
def test_vectorized_simulation_preserves_three_roi_order(path):
    regions = [*REGIONS, ROIRequest(x_start=4000, x_end=4400, y_start=5000, y_end=5500)]
    req = VectorRequest(vector_resolution=8, dwell=16, latency_bytes=113,
                        scan_path=path, parallel_rois=regions)

    async def run():
        return [chunk async for chunk in _simulated_vector_chunks(
            req, {"mode": "loopback"}, abort=asyncio.Event(), interval=0)]

    chunks = asyncio.run(run())
    expected = [x << 2 for x, _, _ in _parallel_roi_iter(8, regions, 16, path)]
    assert [v for chunk in chunks for v in chunk] == expected


def test_parallel_simulation_batches_updates_and_still_stops():
    service = DeviceService(str(CONFIG))
    regions = [*REGIONS, ROIRequest(x_start=4000, x_end=4400, y_start=5000, y_end=5500)]
    req = VectorRequest(vector_resolution=256, dwell=16, latency_bytes=8196,
                        parallel_rois=regions, simulation={"mode": "loopback", "chunkIntervalMs": 0})

    async def run(stop=False):
        command = _SimulatedCommand()
        chunks = []
        async for chunk in service._simulated_chunks("vector", req, command, pace=True):
            chunks.append(chunk)
            if stop and len(chunks) == 2:
                command.abort.set()
        return chunks

    chunks = asyncio.run(run())
    assert len(chunks) == 12  # 196,608 samples / 16,384, rather than 383 tiny waits.
    assert sum(map(len, chunks)) == 256 * 256 * 3
    assert len(asyncio.run(run(stop=True))) == 2
