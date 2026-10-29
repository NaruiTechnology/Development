"""Continuous (Infinite / live) raster and vector: one command stream, frames back to back.

The fake stream answers every read with ramp samples and records every
byte written, so the tests can check what the host would put on the wire:
one synchronize, a RasterRegion re-arm in-band at each new frame, and the
pipeline drain only after Stop.
"""
import asyncio
from pathlib import Path
import pytest

from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    RasterRegionCommand,
    SynchronizeCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from GlasgowDataIO.IobeamControl.macros.raster import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from glasgow_service.models import ROIRequest, RasterRequest, SimulationBitmap, VectorRequest
from glasgow_service.service import DeviceService, _FrameRing, _SimulatedCommand, _bitmap_vector_chunks, _target_gray_step_bitmap, _target_gray_chunk


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"

RES = 256
DWELL = 2
LATENCY = 16384 * DWELL     # 16384 px per chunk -> 4 chunks per 256x256 frame


class FakeStream:
    def __init__(self):
        self.written = bytearray()
        self.reads = 0

    async def write(self, data):
        self.written.extend(bytes(data))

    async def flush(self):
        pass

    async def read(self, length):
        self.reads += 1
        await asyncio.sleep(0)
        return memoryview(bytes(length))


def _cmd(continuous: bool) -> RasterScanCommand:
    rng = DACCodeRange.from_resolution(RES)
    return RasterScanCommand(
        x_range=rng, y_range=rng, dwell_time=DWELL, cookie=123,
        output_mode=OutputMode.SixteenBit, continuous=continuous)


def _region_bytes() -> bytes:
    rng = DACCodeRange.from_resolution(RES)
    return bytes(RasterRegionCommand(x_range=rng, y_range=rng))


def test_single_frame_chunks_are_unchanged():
    cmd = _cmd(False)
    chunks = list(cmd._iter_chunks(LATENCY))
    assert [n for _, n in chunks] == [16384] * 4
    assert all(_region_bytes() not in bytes(c) for c, _ in chunks)
    assert cmd.frame_chunk_count(LATENCY) == 4


def test_continuous_rearms_region_in_band_at_every_frame_start():
    cmd = _cmd(True)
    it = cmd._iter_chunks(LATENCY)
    chunks = [next(it) for _ in range(4 * 3)]       # three frames
    assert sum(n for _, n in chunks) == 3 * RES * RES
    region = _region_bytes()
    for i, (commands, _) in enumerate(chunks):
        starts_frame = i % 4 == 0 and i > 0
        assert bytes(commands).startswith(region) is starts_frame


def test_live_raster_zoom_rearms_new_region_without_new_sync():
    cmd = _cmd(True)
    it = cmd._iter_chunks(LATENCY)
    for _ in range(4):
        next(it)
    small = DACCodeRange(start=4096, count=RES, step=8 * 256)
    cmd.update_geometry(small, small)
    commands, _ = next(it)
    assert bytes(commands).startswith(bytes(RasterRegionCommand(x_range=small, y_range=small)))


def test_live_vector_zoom_uses_new_points_on_next_pass():
    original = lambda: iter([(100, 100, 2), (200, 200, 2)])
    cmd = VectorScanCommand(cookie=9, iter_points=original(), continuous=True,
                            points_factory=original)
    cmd.pass_pixels = 2
    passes = cmd._iter_passes()
    assert list(next(passes)) == [(100, 100, 2), (200, 200, 2)]
    updated = lambda: iter([(300, 300, 2), (400, 400, 2)])
    cmd.update_geometry(updated, 2)
    assert list(next(passes)) == [(300, 300, 2), (400, 400, 2)]


def test_loaded_image_is_shared_by_background_and_zoomed_roi():
    bitmap = {
        "width": 16, "height": 16,
        "pixels": [x * 16 for _y in range(16) for x in range(16)],
        "source_roi": {"x_start": 0, "x_end": 16383, "y_start": 0, "y_end": 16383},
    }
    full = VectorRequest(vector_resolution=RES, simulation_bitmap=bitmap)
    roi = full.model_copy(update={"roi": ROIRequest(x_start=2000, x_end=12000, y_start=2000, y_end=12000)})
    zoomed = full.model_copy(update={"roi": ROIRequest(x_start=7000, x_end=9000, y_start=7000, y_end=9000)})
    first = lambda req: _bitmap_vector_chunks(req)[0][0]
    background = first(full)
    assert background != first(roi)
    assert first(roi) != first(zoomed)
    assert first(full) == background


def test_target_gray_pass_changes_only_brighter_roi_pixels():
    background = SimulationBitmap(width=4, height=1, pixels=[120, 102, 80, 200])
    roi_bitmap = background.model_copy(deep=True)
    roi = ROIRequest(x_start=0, x_end=8191, y_start=0, y_end=16383)
    _target_gray_step_bitmap(roi_bitmap, roi, 100)
    assert roi_bitmap.pixels == [118, 100, 80, 200]
    assert background.pixels == [120, 102, 80, 200]
    _target_gray_step_bitmap(roi_bitmap, roi, 100)
    assert roi_bitmap.pixels == [116, 100, 80, 200]


def test_simulated_target_gray_updates_the_roi_on_the_next_pass():
    full = ROIRequest(x_start=0, x_end=16383, y_start=0, y_end=16383)
    roi = ROIRequest(x_start=0, x_end=8191, y_start=0, y_end=16383)
    background = SimulationBitmap(width=2, height=2, pixels=[120] * 4, source_roi=full)
    selected = background.model_copy(deep=True)
    req = VectorRequest(
        pattern="default", vector_resolution=128, dwell=2, latency_bytes=8196,
        continuous=True, frames=2, target_gray_level=100,
        parallel_rois=[full, roi], parallel_simulation_bitmaps=[background, selected],
    )
    first = list(_bitmap_vector_chunks(req)[0])
    _target_gray_step_bitmap(selected, roi, 100)
    second = list(_bitmap_vector_chunks(req)[0])
    assert first[0] == second[0], "full-field background must stay unchanged"
    assert second[1] < first[1], "the second ROI pass uses a stepped gray value"


def test_parallel_live_simulation_keeps_paced_request_as_update_baseline():
    service = DeviceService(str(CONFIG_PATH))
    full = ROIRequest(x_start=0, x_end=16383, y_start=0, y_end=16383)
    roi = ROIRequest(x_start=2000, x_end=12000, y_start=2000, y_end=12000)
    req = VectorRequest(
        vector_resolution=1024, dwell=8, latency_bytes=8196,
        continuous=True, parallel_rois=[full, roi],
    )
    effective = service._prepare_simulated_stream_request(req, pace=True)
    assert effective.latency_bytes == 8 * 16384
    assert service._active_live_request is effective
    assert req.latency_bytes == 8196


def test_simulated_live_geometry_update_keeps_active_command():
    service = DeviceService(str(CONFIG_PATH))
    owner = object()
    command = _SimulatedCommand()
    command.continuous = True
    service._active_scan = {"kind": "raster", "owner": owner}
    service._active_command = command
    service._active_live_request = RasterRequest(resolution=RES, continuous=True)
    roi = {"x_start": 4096, "x_end": 8192, "y_start": 4096, "y_end": 8192}
    service.update_live_scan_geometry("raster", {"roi": roi, "parallel_rois": None}, owner=owner)
    assert service._active_command is command
    assert service._active_live_request.roi.x_start == 4096
    assert not command.abort.is_set()


def test_hardware_live_geometry_update_preserves_raster_command():
    service = DeviceService(str(CONFIG_PATH))
    owner = object()
    req = RasterRequest(resolution=RES, dwell=DWELL, continuous=True)
    command = service._build_raster_cmd(req, continuous=True)
    service._active_scan = {"kind": "raster", "owner": owner}
    service._active_command = command
    service._active_live_request = req
    roi = {"x_start": 4096, "x_end": 8192, "y_start": 4096, "y_end": 8192}
    service.update_live_scan_geometry("raster", {"roi": roi, "parallel_rois": None}, owner=owner)
    assert service._active_command is command
    assert command._x_range.start == 4096
    assert command._y_range.start == 4096
    assert not command.abort.is_set()


def test_custom_vector_zoom_preserves_flags_and_command_session():
    service = DeviceService(str(CONFIG_PATH))
    owner = object()
    req = VectorRequest(pattern="custom", points=[(100, 200, 3, True, 1), (300, 400, 5, False, 2)], continuous=True)
    command = service._build_vector_cmd(req, continuous=True)
    service._active_scan = {"kind": "vector", "owner": owner}
    service._active_command = command
    service._active_live_request = req
    roi = {"x_start": 1000, "x_end": 8000, "y_start": 1000, "y_end": 8000}
    points = [(1100, 1200, 3, True, 1), (1300, 1400, 5, False, 2)]
    service.update_live_scan_geometry("vector", {"roi": roi, "parallel_rois": None, "points": points}, owner=owner)
    assert service._active_command is command
    assert list(command._points_factory()) == points
    assert not command.abort.is_set()
    with pytest.raises(ValueError, match="blanking"):
        service.update_live_scan_geometry("vector", {
            "roi": roi, "parallel_rois": None,
            "points": [(1100, 1200, 3, False, 1), (1300, 1400, 5, False, 2)],
        }, owner=owner)
    assert list(command._points_factory()) == points


def test_continuous_transfer_streams_frames_until_abort():
    async def scenario():
        cmd = _cmd(True)
        stream = FakeStream()
        pixels = 0
        async for chunk in cmd.transfer(stream, latency=LATENCY):
            pixels += len(chunk)
            if pixels >= 5 * RES * RES:             # five full frames
                cmd.abort.set()
        return cmd, stream, pixels

    cmd, stream, pixels = asyncio.run(asyncio.wait_for(scenario(), 10))
    assert pixels >= 5 * RES * RES
    sync = bytes(SynchronizeCommand(cookie=123, raster=True, output=OutputMode.SixteenBit))
    # One synchronize for the whole live session, not one per frame.
    assert stream.written.count(sync) == 1
    # The first region goes with the sync; later frames re-arm in-band.
    assert stream.written.count(_region_bytes()) >= 5


def test_service_frame_ring_keeps_only_the_last_complete_frame():
    ring = _FrameRing(RES * RES)
    frames = [[None] * 4 for _ in range(3)]
    for frame in frames:
        for chunk in frame:
            ring.append([0] * 16384)
    ring.append([1] * 16384)                            # partial 4th frame
    assert ring.frames_completed == 3
    assert len(ring.frame()) == 4
    assert all(c == [0] * 16384 for c in ring.frame())


def test_simulated_continuous_raster_runs_past_one_frame_and_stops():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        req = RasterRequest(resolution=RES, dwell=DWELL, latency_bytes=LATENCY,
                            continuous=True, simulation={"enabled": True,
                                                         "chunkIntervalMs": 0})
        service._hardware_free = lambda _req: True
        samples = 0
        async for wire in service.raster_scan(req):
            samples += len(wire) // 2
            if samples >= 3 * RES * RES:
                service.abort_active_scan()
        return service, samples

    service, samples = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert samples >= 3 * RES * RES
    last = service._last
    assert last is not None and last["kind"] == "raster"
    assert sum(len(c) for c in last["chunks"]) == RES * RES


def test_blocking_run_ignores_continuous():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        service._hardware_free = lambda _req: True
        req = RasterRequest(resolution=RES, dwell=DWELL, latency_bytes=LATENCY,
                            continuous=True, do_validate=False,
                            simulation={"enabled": True})
        return await service.run_raster(req)

    result = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert result.kind == "raster"


# ---------------------------------------------------------------- vector ----

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from glasgow_service.models import VectorRequest

PASS_POINTS = [(x * 64, y * 64, 1) for x in range(32) for y in range(32)]   # 1024


def test_vector_continuous_replays_passes_on_chunk_boundaries():
    cmd = VectorScanCommand(cookie=123, iter_points=iter(PASS_POINTS),
                            continuous=True)
    it = cmd._iter_chunks(300)
    counts = []
    while sum(counts) < 3 * len(PASS_POINTS):
        counts.append(next(it)[1])
    # every pass ends exactly on a chunk boundary
    assert sum(counts) == 3 * len(PASS_POINTS)
    running, ends = 0, []
    for n in counts:
        running += n
        ends.append(running)
    for k in (1, 2, 3):
        assert k * len(PASS_POINTS) in ends


def test_vector_continuous_transfer_streams_passes_until_abort():
    async def scenario():
        cmd = VectorScanCommand(cookie=123, iter_points=iter(PASS_POINTS),
                                continuous=True, drain_floor_pixels=16)
        stream = FakeStream()
        samples = 0
        async for chunk in cmd.transfer(stream, latency=300):
            samples += len(chunk)
            if samples >= 4 * len(PASS_POINTS):
                cmd.abort.set()          # Stop: must end cleanly (no crash)
        return stream, samples

    stream, samples = asyncio.run(asyncio.wait_for(scenario(), 10))
    assert samples >= 4 * len(PASS_POINTS)
    sync = bytes(SynchronizeCommand(cookie=123, raster=False, output=OutputMode.SixteenBit))
    assert stream.written.count(sync) == 1


def test_service_builds_continuous_vector_commands():
    service = DeviceService(str(CONFIG_PATH))
    base = dict(pattern="default", vector_resolution=256, dwell=2, latency_bytes=8196)
    vertical = service._build_vector_cmd(
        VectorRequest(scan_path="vertical_raster", **base), continuous=True)
    assert isinstance(vertical, VectorScanCommand) and vertical.continuous
    assert vertical.pass_pixels == 256 * 256
    sawtooth = service._build_vector_cmd(
        VectorRequest(scan_path="horizontal_sawtooth", **base), continuous=True)
    assert isinstance(sawtooth, RasterScanCommand) and sawtooth.continuous
    single = service._build_vector_cmd(
        VectorRequest(scan_path="vertical_raster", **base))
    assert not single.continuous


def test_frame_blank_config_applies_to_all_scan_command_paths():
    from glasgow_service.models import RasterRequest

    service = DeviceService(str(CONFIG_PATH))
    for enabled in (False, True):
        service._raster_params_defaults = service._raster_params_defaults.override(frame_blank=enabled)
        assert service._effective_raster_params(RasterRequest()).frame_blank is enabled
        for path in ("vertical_raster", "horizontal_sawtooth"):
            command = service._build_vector_cmd(VectorRequest(
                pattern="default", scan_path=path, vector_resolution=256))
            assert command.frame_blank is enabled
    assert service._effective_raster_params(RasterRequest(frame_blank=False)).frame_blank is False


def test_simulated_continuous_vector_runs_past_one_pass_and_stops():
    async def scenario():
        service = DeviceService(str(CONFIG_PATH))
        service._hardware_free = lambda _req: True
        req = VectorRequest(pattern="default", scan_path="vertical_raster",
                            vector_resolution=RES, dwell=DWELL, latency_bytes=LATENCY,
                            continuous=True,
                            simulation={"enabled": True, "chunkIntervalMs": 0})
        samples = 0
        async for wire in service.vector_scan(req):
            samples += len(wire) // 2
            if samples >= 3 * RES * RES:
                service.abort_active_scan()
        return service, samples

    service, samples = asyncio.run(asyncio.wait_for(scenario(), 30))
    assert samples >= 3 * RES * RES
    assert sum(len(c) for c in service._last["chunks"]) == RES * RES


def _live_gray_service(*, parallel=False):
    service = DeviceService(str(CONFIG_PATH))
    owner = object()
    command = _SimulatedCommand()
    command.continuous = True
    full = ROIRequest(x_start=0, x_end=16383, y_start=0, y_end=16383)
    bitmap = SimulationBitmap(width=2, height=2, pixels=[120] * 4, source_roi=full)
    req = VectorRequest(vector_resolution=128, dwell=2, latency_bytes=65536,
                        continuous=True, simulation_bitmap=bitmap,
                        simulation={"enabled": True, "chunkIntervalMs": 0})
    if parallel:
        req = req.model_copy(update={
            "simulation_bitmap": None, "parallel_rois": [full, ROIRequest(x_start=0, x_end=8191, y_start=0, y_end=16383)],
            "parallel_simulation_bitmaps": [bitmap, bitmap.model_copy(deep=True)]})
    service._active_scan = {"kind": "vector", "owner": owner}
    service._active_command = command
    service._active_live_request = req
    return service, owner, command, req


def test_live_target_change_and_clear_take_effect_on_same_command():
    async def scenario():
        service, owner, command, req = _live_gray_service()
        chunks = service._simulated_chunks("vector", req, command, pace=True)
        try:
            assert (await anext(chunks))[0] == 120 * 256
            service.update_live_scan_geometry("vector", {"gray_rule": {
                "target_gray_level": 100, "gray_level_range": [0, 100], "gray_level_skipped": False}}, owner=owner)
            assert (await anext(chunks))[0] == 120 * 256
            assert (await anext(chunks))[0] == 118 * 256
            service.update_live_scan_geometry("vector", {"gray_rule": {
                "target_gray_level": 119, "gray_level_range": [0, 119], "gray_level_skipped": False}}, owner=owner)
            assert (await anext(chunks))[0] == 118 * 256
            assert (await anext(chunks))[0] == 118 * 256
            service.update_live_scan_geometry("vector", {"gray_rule": {
                "target_gray_level": None, "gray_level_range": None, "gray_level_skipped": None}}, owner=owner)
            cleared = (await anext(chunks))[0]
            assert (await anext(chunks))[0] == cleared
            assert service._active_command is command
            assert not command.abort.is_set()
        finally:
            await chunks.aclose()
    asyncio.run(scenario())


def test_live_gray_rule_preserves_full_field_background_and_pixel_values():
    service, owner, command, req = _live_gray_service(parallel=True)
    service.update_live_gray_rule("vector", {
        "target_gray_level": 50, "gray_level_range": [0, 150], "gray_level_skipped": False}, owner=owner)
    updated = service._active_live_request
    assert updated.parallel_simulation_bitmaps[0] is req.parallel_simulation_bitmaps[0]
    pixel = updated.parallel_simulation_bitmaps[1].pixels[0]
    assert pixel.value == 120 and pixel.blank is False
    assert service._active_command is command and not command.abort.is_set()
    assert req.parallel_simulation_bitmaps[1].pixels[0] == 120


def test_invalid_or_foreign_live_gray_rule_cannot_change_session():
    service, owner, command, req = _live_gray_service()
    rule = {"target_gray_level": 100, "gray_level_range": [0, 100], "gray_level_skipped": False}
    with pytest.raises(ValueError, match="matching continuous"):
        service.update_live_gray_rule("vector", rule, owner=object())
    with pytest.raises(ValueError):
        service.update_live_gray_rule("vector", {**rule, "target_gray_level": 999}, owner=owner)
    with pytest.raises(ValueError):
        service.update_live_gray_rule("vector", {**rule, "points": []}, owner=owner)
    assert service._active_live_request is req
    assert service._active_command is command and not command.abort.is_set()


def test_target_chunk_fades_only_roi_pixels_and_clamps_at_selected_gray():
    import array
    full = ROIRequest(x_start=0, x_end=16383, y_start=0, y_end=16383)
    roi = ROIRequest(x_start=2000, x_end=8000, y_start=2000, y_end=8000)
    req = VectorRequest(continuous=True, parallel_rois=[full, roi], target_gray_level=33)
    original = array.array("H", [200 * 256, 200 * 256, 20 * 256, 20 * 256])
    previous = original[1]
    for steps in [1, 4, 16, 64, 128]:
        faded = _target_gray_chunk(original, req, 0, steps)
        assert faded[0] == original[0], "background must not fade"
        assert faded[2:] == original[2:], "pixels already below target must not change"
        assert 33 * 256 <= faded[1] <= previous
        previous = faded[1]
    assert previous == 33 * 256
    assert original[1] == 200 * 256, "cached acquisition chunk stays immutable"
    # A transport chunk can begin with an ROI sample, rather than background.
    assert _target_gray_chunk(original, req, 1, 128)[0] == 33 * 256


def test_roi_converges_during_a_live_pass_not_only_after_frame_end():
    async def scenario():
        service, owner, command, req = _live_gray_service()
        req = req.model_copy(update={
            "target_gray_level": 116, "latency_bytes": 8192, "frames": 1,
            "simulation": {"enabled": True, "chunkIntervalMs": 20}})
        received = []
        async for chunk in service._simulated_chunks("vector", req, command, pace=True):
            received.append(chunk[0])
        assert len(received) == 4
        assert received[0] > received[1] >= received[2] >= received[3]
        assert received[-1] == 116 * 256
        assert not command.abort.is_set()
    asyncio.run(scenario())


def test_uploaded_bitmap_rois_do_not_mutate_background_or_cached_source(monkeypatch):
    from glasgow_service import scan_assets
    async def scenario():
        service, owner, command, req = _live_gray_service(parallel=True)
        cached = req.parallel_simulation_bitmaps[0]
        monkeypatch.setattr(scan_assets, "load", lambda _asset_id: cached)
        req = req.model_copy(update={
            "simulation_bitmap": None, "parallel_simulation_bitmaps": None,
            "parallel_simulation_bitmap_ids": ["a" * 64, "a" * 64],
            "target_gray_level": 33, "frames": 2})
        frames = []
        async for chunk in service._simulated_chunks("vector", req, command, pace=True):
            frames.append(list(chunk))
        assert frames[0][0] == frames[1][0] == 120 * 256
        assert frames[1][1] < frames[0][1], "selected ROI must get darker"
        assert cached.pixels == [120] * 4, "uploaded source must stay immutable"
        bitmaps = service._active_live_request.parallel_simulation_bitmaps
        assert bitmaps[0] is not bitmaps[1]
        assert not command.abort.is_set()
    asyncio.run(scenario())


def test_live_range_spot_skip_empty_selection_and_clear_preserve_command():
    service, owner, command, req = _live_gray_service()
    req.simulation_bitmap.pixels = [20, 80, 150, 220]
    def corners():
        chunks = _bitmap_vector_chunks(service._active_live_request)
        values = [sample for chunk in chunks for sample in chunk]
        return [values[0] // 256, values[127] // 256, values[127 * 128] // 256, values[-1] // 256]
    def apply(selection, skipped):
        service.update_live_gray_rule("vector", {"target_gray_level": None,
            "gray_level_range": selection, "gray_level_skipped": skipped}, owner=owner)
    apply([50, 160], False)
    assert corners() == [0, 80, 150, 0]
    apply([50, 160], True)
    assert corners() == [20, 0, 0, 220]
    apply([230, 250], False)
    assert corners() == [0, 0, 0, 0], "Spot with no matching pixels blanks every pixel"
    apply(None, None)
    assert corners() == [20, 80, 150, 220]
    assert service._active_command is command and not command.abort.is_set()


def test_live_range_filter_never_blanks_composite_background():
    service, owner, command, req = _live_gray_service(parallel=True)
    service.update_live_gray_rule("vector", {"target_gray_level": None,
        "gray_level_range": [230, 250], "gray_level_skipped": False}, owner=owner)
    values = [sample for chunk in _bitmap_vector_chunks(service._active_live_request) for sample in chunk]
    assert all(value == 120 * 256 for value in values[::2])
    assert all(value == 0 for value in values[1::2])
    assert not command.abort.is_set()
