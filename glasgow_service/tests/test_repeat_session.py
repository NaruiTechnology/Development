"""Repeat N as ONE session: external control is taken once, held for all N
frames, and the session ends by itself after frame N.

Before this, Repeat ran N separate scans. Each reconnected (resetting the
FPGA, which drops the relays) and handed the instrument back between frames.
"""
import asyncio
from pathlib import Path

import pytest

from GlasgowDataIO.IobeamControl.commands import DACCodeRange
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    ExternalCtrlCommand,
    RasterRegionCommand,
    SynchronizeCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode
from GlasgowDataIO.IobeamControl.macros.raster import RasterScanCommand
from GlasgowDataIO.IobeamControl.macros.vector import (
    AdaptiveGrayFeedbackConfig,
    VectorScanCommand,
)
from glasgow_service.models import RasterRequest, VectorRequest
from glasgow_service.service import DeviceService


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"

RES = 128
DWELL = 2
LATENCY = 4096 * DWELL
TAKE = bytes(ExternalCtrlCommand(enable=True))
RELEASE = bytes(ExternalCtrlCommand(enable=False))


class FakeStream:
    """Answers every read with zeros and records what the host writes."""

    def __init__(self):
        self.written = bytearray()

    async def write(self, data):
        self.written.extend(bytes(data))

    async def flush(self):
        pass

    async def read(self, length):
        await asyncio.sleep(0)
        return memoryview(bytes(length))


async def collect(cmd, stream):
    samples = 0
    async for chunk in cmd.transfer(stream, latency=LATENCY):
        samples += len(chunk)
    return samples


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 20))


# ---------------------------------------------------------------- raster ----

def raster(frames):
    rng = DACCodeRange.from_resolution(RES)
    return RasterScanCommand(x_range=rng, y_range=rng, dwell_time=DWELL, cookie=7,
                             output_mode=OutputMode.SixteenBit, continuous=True,
                             max_frames=frames)


@pytest.mark.parametrize("frames", [1, 3])
def test_raster_session_ends_after_n_frames_with_one_takeover(frames):
    stream = FakeStream()
    samples = run(collect(raster(frames), stream))
    assert samples == frames * RES * RES
    sync = bytes(SynchronizeCommand(cookie=7, raster=True, output=OutputMode.SixteenBit))
    assert stream.written.count(sync) == 1
    assert stream.written.count(TAKE) == 1
    assert RELEASE not in stream.written            # the connection releases after
    rng = DACCodeRange.from_resolution(RES)
    # The first region goes with the sync; frames 2..N re-arm in-band.
    assert stream.written.count(bytes(RasterRegionCommand(x_range=rng, y_range=rng))) == frames


def test_raster_frames_must_be_positive():
    with pytest.raises(ValueError):
        raster(0)


def test_raster_chunk_walks_agree_on_the_session_end():
    # Sender and receiver each walk _iter_chunks; both must stop at frame N.
    cmd = raster(4)
    a = [n for _, n in cmd._iter_chunks(LATENCY)]
    b = [n for _, n in cmd._iter_chunks(LATENCY)]
    assert a == b and sum(a) == 4 * RES * RES


# ---------------------------------------------------------------- vector ----

POINTS = [(x * 64, y * 64, 4) for y in range(16) for x in range(16)]


def test_vector_session_ends_after_n_passes_with_one_takeover():
    cmd = VectorScanCommand(cookie=9, iter_points=list(POINTS), continuous=True,
                            max_passes=3)
    cmd.pass_pixels = len(POINTS)
    stream = FakeStream()
    samples = run(collect(cmd, stream))
    assert samples == 3 * len(POINTS)
    assert stream.written.count(TAKE) == 1
    assert RELEASE not in stream.written


def test_adaptive_feedback_runs_n_passes_on_one_command_stream():
    cfg = AdaptiveGrayFeedbackConfig(gray_min=0, gray_max=100, blank_when_inside=True)
    points = POINTS[:20]
    cmd = VectorScanCommand(cookie=11, iter_points=iter(points), adaptive_gray_feedback=cfg,
                            max_passes=3)
    stream = FakeStream()
    samples = run(collect(cmd, stream))
    assert samples == 3 * len(points)               # one sample per point per pass
    assert stream.written.count(TAKE) == 1


def test_adaptive_without_passes_still_runs_once():
    cfg = AdaptiveGrayFeedbackConfig(gray_min=0, gray_max=100, blank_when_inside=True)
    cmd = VectorScanCommand(cookie=11, iter_points=iter(POINTS[:20]), adaptive_gray_feedback=cfg)
    assert run(collect(cmd, FakeStream())) == 20


def test_stop_still_ends_a_finite_session_early():
    async def scenario():
        cmd = raster(50)
        samples = 0
        async for chunk in cmd.transfer(FakeStream(), latency=LATENCY):
            samples += len(chunk)
            if samples >= 2 * RES * RES:
                cmd.abort.set()
        return samples

    samples = run(scenario())
    assert 2 * RES * RES <= samples < 50 * RES * RES


# --------------------------------------------------------------- service ----

def service():
    return DeviceService(str(CONFIG_PATH))


def test_service_passes_frames_to_the_raster_command():
    cmd = service()._build_raster_cmd(
        RasterRequest(resolution=RES, dwell=DWELL, continuous=True, frames=5), continuous=True)
    assert cmd._max_frames == 5


def test_service_passes_frames_to_vector_commands():
    svc = service()
    streamed = svc._build_vector_cmd(
        VectorRequest(vector_resolution=64, continuous=True, frames=4), continuous=True)
    assert getattr(streamed, "_max_passes", getattr(streamed, "_max_frames", None)) == 4


def test_frames_are_ignored_without_continuous():
    cmd = service()._build_raster_cmd(
        RasterRequest(resolution=RES, dwell=DWELL, frames=5), continuous=False)
    assert cmd._max_frames is None


def test_simulated_session_stops_after_n_frames():
    async def scenario():
        svc = service()
        svc._hardware_free = lambda _req: True
        req = RasterRequest(resolution=RES, dwell=DWELL, latency_bytes=LATENCY,
                            continuous=True, frames=3,
                            simulation={"enabled": True, "chunkIntervalMs": 0})
        samples = 0
        async for wire in svc.raster_scan(req):
            samples += len(wire) // 2
        return samples

    assert run(scenario()) == 3 * RES * RES


def test_frames_bounds():
    with pytest.raises(ValueError):
        VectorRequest(continuous=True, frames=0)


# ------------------------------------------------- whole path, end to end ----

def test_n_frames_take_control_once_and_hand_back_once_at_the_end():
    from GlasgowDataIO.IobeamControl.transfer.abc import Connection

    class Stream(FakeStream):
        async def readuntil(self, separator=b"\n", **_kw):
            return memoryview(separator)

    class Conn(Connection):
        def __init__(self):
            super().__init__(None)
            self._stream = Stream()
            self._synchronized = True
            self.wire = None

        async def _connect(self):
            raise AssertionError

        async def _post_transfer_cleanup(self):
            self.wire = bytes(self._stream.written)
            self._stream = None

    async def scenario():
        conn = Conn()
        samples = 0
        async for chunk in conn.transfer_multiple(raster(3), latency=LATENCY):
            samples += len(chunk)
        return conn.wire, samples

    wire, samples = run(scenario())
    assert samples == 3 * RES * RES
    assert wire.count(TAKE) == 1 and wire.count(RELEASE) == 1
    assert wire.index(TAKE) < wire.index(RELEASE)
    # Every frame's pixels lie between the takeover and the hand-back.
    rng = DACCodeRange.from_resolution(RES)
    last_region = wire.rindex(bytes(RasterRegionCommand(x_range=rng, y_range=rng)))
    assert wire.index(TAKE) < last_region < wire.index(RELEASE)
