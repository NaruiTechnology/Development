"""Software live acquisition retains encoded geometry until its FIFO drains."""
import asyncio
from pathlib import Path

import pytest

from glasgow_service.models import ROIRequest, RasterRequest, VectorRequest
from glasgow_service.service import DeviceService, _SimulatedCommand

CONFIG = Path(__file__).parents[2] / "GlasgowDataIO/Json/streamData.json"
BOUNDS = {"x_start": 4096, "x_end": 8191, "y_start": 4096, "y_end": 8191}


def setup(kind, pipeline, *, resolution=128, frames=None, scan_path="vertical_raster", interval=0):
    service = DeviceService(str(CONFIG))
    service._raster_params_defaults = service._raster_params_defaults.override(max_pipeline=pipeline)
    service._vector_params_defaults = service._vector_params_defaults.override(max_pipeline=pipeline)
    fields = dict(dwell=1, latency_bytes=16384, continuous=True, frames=frames,
                  simulation={"enabled": True, "mode": "loopback", "chunkIntervalMs": interval})
    req = (RasterRequest(resolution=resolution, **fields) if kind == "raster" else
           VectorRequest(vector_resolution=resolution, scan_path=scan_path, **fields))
    command = _SimulatedCommand()
    command.continuous = True
    owner = object()
    service._active_command = command
    service._active_scan = {"kind": kind, "owner": owner}
    service._active_live_request = req
    return service, req, command, owner


def change(service, kind, owner, bounds=BOUNDS):
    service.update_live_scan_geometry(kind, {"roi": bounds, "parallel_rois": None}, owner=owner)


@pytest.mark.parametrize("kind,scan_path", [("raster", "horizontal_sawtooth"),
                                             ("vector", "vertical_raster"),
                                             ("vector", "horizontal_sawtooth")])
@pytest.mark.parametrize("pipeline", [1, 4, 8, 32])
def test_zoom_waits_for_encoded_chunks_and_queue_stays_bounded(kind, scan_path, pipeline, caplog):
    async def scenario():
        service, req, command, owner = setup(kind, pipeline, scan_path=scan_path)
        stream = service._simulated_chunks(kind, req, command, pace=True)
        try:
            assert (await anext(stream))[0] == 0
            stats = command._link_stats
            assert stats.chunks_sent == pipeline + 1  # hardware's initial receiver credit
            assert stats.chunks_sent - stats.chunks_recv == pipeline
            change(service, kind, owner)
            for _ in range(pipeline):
                assert (await anext(stream))[0] == 0, "queued samples must retain old coordinates"
                assert stats.chunks_sent - stats.chunks_recv == pipeline
            assert (await anext(stream))[0] == 4096 << 2
            assert command._geometry_revision == 1
        finally:
            await stream.aclose()
    with caplog.at_level("INFO"):
        asyncio.run(asyncio.wait_for(scenario(), 10))
    assert "geometry queued revision=1" in caplog.text
    assert "geometry output revision=1" in caplog.text
    assert "geometry queue snapshot" in caplog.text


@pytest.mark.parametrize("kind", ["raster", "vector"])
def test_partially_encoded_frame_finishes_before_new_geometry(kind):
    async def scenario():
        service, req, command, owner = setup(kind, 1, resolution=256, scan_path="horizontal_sawtooth")
        stream = service._simulated_chunks(kind, req, command, pace=True)
        try:
            assert (await anext(stream))[0] == 0
            change(service, kind, owner)
            for _ in range(3):  # remaining three chunks of the old frame
                assert (await anext(stream))[0] == 0
            assert (await anext(stream))[0] == 4096 << 2
        finally:
            await stream.aclose()
    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_latest_geometry_wins_before_encoding_but_keeps_existing_queue():
    async def scenario():
        service, req, command, owner = setup("raster", 4)
        stream = service._simulated_chunks("raster", req, command, pace=True)
        try:
            await anext(stream)
            change(service, "raster", owner)
            change(service, "raster", owner, {**BOUNDS, "x_start": 6144})
            for _ in range(4):
                assert (await anext(stream))[0] == 0
            assert (await anext(stream))[0] == 6144 << 2
        finally:
            await stream.aclose()
    asyncio.run(asyncio.wait_for(scenario(), 10))


@pytest.mark.parametrize("kind", ["raster", "vector"])
def test_repeat_finishes_without_delivering_read_ahead_extra_frames(kind):
    async def scenario():
        service, req, command, _ = setup(kind, 32, frames=3)
        chunks = [chunk async for chunk in service._simulated_chunks(kind, req, command, pace=True)]
        assert sum(map(len, chunks)) == 3 * 128 * 128
        assert command._link_stats.chunks_sent == command._link_stats.chunks_recv == 3
    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_stop_discards_pending_chunks_and_wakes_playback_delay():
    async def scenario():
        service, req, command, _ = setup("raster", 4, interval=60000)
        stream = service._simulated_chunks("raster", req, command, pace=True)
        reading = asyncio.create_task(anext(stream))
        try:
            while not hasattr(command, "_link_stats") or command._link_stats.chunks_sent < 5:
                await asyncio.sleep(0)
            command.abort.set()
            with pytest.raises(StopAsyncIteration):
                await asyncio.wait_for(reading, 1)
            assert command._link_stats.chunks_recv == 0
        finally:
            reading.cancel()
            await stream.aclose()
    asyncio.run(asyncio.wait_for(scenario(), 10))


@pytest.mark.parametrize("kind,parallel,path", [("raster", False, "horizontal_sawtooth"),
    ("raster", True, "horizontal_sawtooth"), ("vector", False, "horizontal_sawtooth"),
    ("vector", False, "vertical_raster"), ("vector", True, "horizontal_sawtooth")])
def test_queue_setting_matches_hardware_command_route(kind, parallel, path):
    service, req, _, _ = setup(kind, 4, scan_path=path)
    service._raster_params_defaults = service._raster_params_defaults.override(max_pipeline=3)
    service._vector_params_defaults = service._vector_params_defaults.override(max_pipeline=7)
    if parallel:
        req = req.model_copy(update={"parallel_rois": [ROIRequest(**BOUNDS), ROIRequest(**BOUNDS)]})
    hardware = (service._build_raster_cmd(req, continuous=True) if kind == "raster" else
                service._build_vector_cmd(req, continuous=True))
    assert service._simulated_pipeline(kind, req)[0] == hardware._max_pipeline


@pytest.mark.parametrize("pipeline", [4, 8, 32])
@pytest.mark.parametrize("kind", ["raster", "vector"])
@pytest.mark.parametrize("rapid", [False, True])
def test_zoom_reproduction_uses_real_control_handler_and_logs(pipeline, kind, rapid, caplog):
    from glasgow_service.zoom_queue_diagnostic import reproduce
    with caplog.at_level("INFO"):
        result = asyncio.run(reproduce(pipeline=pipeline, kind=kind, rapid=rapid, chunk_ms=0))
    assert result["accepted_zooms"] == ([2, 4] if rapid else [2, 4, 1])
    assert all(item["stale_chunks"] == pipeline for item in result["observations"])
    assert result["intermediate_zoom_2_absent"] is rapid
    assert "live geometry request id=1 diagnostics=" in caplog.text
    assert "live geometry accepted id=1" in caplog.text
    assert f"outstanding={pipeline}" in caplog.text
    assert "geometry output revision=2" in caplog.text
    if rapid:
        assert "geometry output revision=1 " not in caplog.text


@pytest.mark.parametrize("kind", ["raster", "vector"])
def test_single_frame_stream_also_uses_configured_queue(kind):
    async def scenario():
        service, req, command, _ = setup(kind, 1, resolution=256)
        req = req.model_copy(update={"continuous": False})
        chunks = [chunk async for chunk in service._simulated_chunks(kind, req, command, pace=True)]
        assert command._max_pipeline == 1
        assert len(chunks) == 4
        assert sum(map(len, chunks)) == 256 * 256
    asyncio.run(asyncio.wait_for(scenario(), 10))


def test_encoded_intermediate_zoom_is_preserved_in_fifo_order():
    async def scenario():
        service, req, command, owner = setup("raster", 4)
        stream = service._simulated_chunks("raster", req, command, pace=True)
        try:
            await anext(stream)
            change(service, "raster", owner)
            assert (await anext(stream))[0] == 0  # encodes Zoom 2 behind the old FIFO
            change(service, "raster", owner, {**BOUNDS, "x_start": 6144})
            for _ in range(3):
                assert (await anext(stream))[0] == 0
            assert (await anext(stream))[0] == 4096 << 2
            assert (await anext(stream))[0] == 6144 << 2
        finally:
            await stream.aclose()
    asyncio.run(asyncio.wait_for(scenario(), 10))
