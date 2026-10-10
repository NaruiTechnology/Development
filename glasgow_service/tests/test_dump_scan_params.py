"""DumpData files carry the scan parameters in their header.

The CSV dump starts with ``# name: value`` comment lines and the PNG dump
stores the same values as PNG text chunks. The on-demand download endpoints
(``last_csv_bytes`` / ``last_figure_png``) are unchanged.
"""
import asyncio
import io
from pathlib import Path

import numpy as np
from PIL import Image

from glasgow_service.models import RasterRequest, ROIRequest, VectorRequest
from glasgow_service.service import DeviceService

CONFIG_PATH = str(
    Path(__file__).resolve().parents[2] / "GlasgowDataIO" / "Json" / "streamData.json")

RANDOM_SOURCE = {"enabled": True, "mode": "image", "source": "random",
                 "seed": 5, "imageResolution": 64, "chunkIntervalMs": 1}


def make_service():
    svc = DeviceService(CONFIG_PATH)
    svc._config.IsProduction = False
    svc._config.DumpData = False          # the test reads the bytes directly
    svc._simulation_defaults.clear()
    svc._simulation_defaults.update(RANDOM_SOURCE)
    return svc


def collect(svc, kind, req):
    async def run():
        method = svc.raster_scan if kind == "raster" else svc.vector_scan
        return [wire async for wire in method(req)]
    return asyncio.run(run())


def header_lines(data: bytes):
    return [line[2:] for line in data.decode("utf-8").splitlines() if line.startswith("# ")]


def test_raster_dump_csv_starts_with_scan_parameters():
    svc = make_service()
    req = RasterRequest(resolution=64, dwell=16, latency_bytes=4096, cookie=123)
    collect(svc, "raster", req)

    params = dict(svc.last_scan_params())
    assert params["kind"] == "raster"
    assert params["resolution"] == "64x64"
    assert params["dwell"].startswith("16 (+1 = 17 x ")
    assert params["latency_bytes"].startswith("4096") or "requested 4096" in params["latency_bytes"]
    assert params["output_mode"] == "SixteenBit"
    assert params["cookie"] == "123"

    dump = svc.last_dump_csv_bytes()
    lines = header_lines(dump)
    assert lines[0] == "kind: raster"
    assert "resolution: 64x64" in lines
    # The body after the header is exactly the plain download CSV.
    assert dump.endswith(svc.last_csv_bytes())
    # Comment lines are skipped by numpy's default loader.
    grid = np.loadtxt(io.BytesIO(dump))
    assert grid.shape == (64, 64)


def test_vector_dump_records_gray_level_filter_and_mode():
    svc = make_service()
    req = VectorRequest(
        pattern="default", vector_resolution=64, dwell=4, latency_bytes=8196,
        scan_path="horizontal_triangle",
        gray_level_range=(40, 200), gray_level_skipped=False,
        roi=ROIRequest(x_start=100, x_end=8000, y_start=200, y_end=9000),
    )
    collect(svc, "vector", req)

    params = dict(svc.last_scan_params())
    assert params["kind"] == "vector"
    assert params["pattern"] == "default"
    assert params["resolution"] == "64x64"
    assert params["scan_path"] == "horizontal_triangle"
    assert params["gray_level_range"] == "40..200"
    assert params["gray_level_mode"] == "spot"
    assert params["roi_dac"] == "x 100..8000, y 200..9000"


def test_dump_png_stores_scan_parameters_as_text_chunks():
    svc = make_service()
    collect(svc, "raster", RasterRequest(resolution=64, dwell=2, latency_bytes=4096))

    image = Image.open(io.BytesIO(svc.last_dump_png_bytes()))
    assert image.text["scan.kind"] == "raster"
    assert image.text["scan.resolution"] == "64x64"
    assert "resolution=64x64" in image.text["Description"]
