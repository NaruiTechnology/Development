"""Multiple ROI areas share one command and preserve their sample order."""

from pathlib import Path

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from glasgow_service.models import ROIRequest, RasterRequest, SimulationBitmap, VectorRequest, VectorScanPath
from glasgow_service.service import (
    DeviceService, _bitmap_raster_chunks, _bitmap_vector_chunks, _parallel_roi_iter,
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
