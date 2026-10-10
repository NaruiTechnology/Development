"""Continuous (Infinite / live) raster and vector: one command stream, frames back to back.

The fake stream answers every read with ramp samples and records every
byte written, so the tests can check what the host would put on the wire:
one synchronize, a RasterRegion re-arm in-band at each new frame, and the
pipeline drain only after Stop.
"""
import asyncio
from pathlib import Path

from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    RasterRegionCommand,
    SynchronizeCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from GlasgowDataIO.IobeamControl.macros.raster import RasterScanCommand
from glasgow_service.models import RasterRequest
from glasgow_service.service import DeviceService, _FrameRing


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
