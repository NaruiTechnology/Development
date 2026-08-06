from glasgow_service.models import ROIRequest, SimulationBitmap, VectorPattern, VectorRequest, VectorScanPath
from glasgow_service.service import _bitmap_vector_chunks, _roi_vector_iter


def coords(path: VectorScanPath):
    roi = ROIRequest(x_start=0, x_end=2, y_start=0, y_end=2)
    return [(x, y) for x, y, _dwell in _roi_vector_iter(3, roi, scan_path=path)]


def test_vector_scan_path_orders():
    assert coords(VectorScanPath.vertical_raster) == [
        (0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (2, 0), (2, 1), (2, 2),
    ]
    assert coords(VectorScanPath.vertical_serpentine) == [
        (0, 0), (0, 1), (0, 2), (1, 2), (1, 1), (1, 0), (2, 0), (2, 1), (2, 2),
    ]
    assert coords(VectorScanPath.horizontal_sawtooth) == [
        (0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1), (0, 2), (1, 2), (2, 2),
    ]
    assert coords(VectorScanPath.horizontal_triangle) == [
        (0, 0), (1, 0), (2, 0), (2, 1), (1, 1), (0, 1), (0, 2), (1, 2), (2, 2),
    ]
def test_serpentine_path_is_used_by_vector_simulation():
    req = VectorRequest(
        pattern=VectorPattern.default,
        scan_path=VectorScanPath.horizontal_triangle,
        vector_resolution=3,
        dwell=1,
        latency_bytes=8196,
        roi=ROIRequest(x_start=0, x_end=2, y_start=0, y_end=2),
        simulation_bitmap=SimulationBitmap(width=3, height=3, pixels=list(range(9))),
    )
    chunks = _bitmap_vector_chunks(req)
    assert chunks is not None
    assert sum(len(chunk) for chunk in chunks) == 9
