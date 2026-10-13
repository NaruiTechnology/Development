"""Beam hold: the blank takeover diagnostic.

The command must park both DACs (step 0), run on the live raster path with
no frame blanking, take the relays only when asked, and stop on its own
after `duration_s` or on Stop, closing the transfer (which hands the
instrument back; see GlasgowDataIO test_external_control_release).
"""
import array
import asyncio
from pathlib import Path

import pytest

from glasgow_service.models import BeamHoldRequest
from glasgow_service.service import DeviceService
from GlasgowDataIO.IobeamControl.commands.structs import BeamType


CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "streamData.json"


class FakeConnection:
    """Yields parked samples until the command is aborted, like the
    continuous raster receive loop does after Stop."""

    def __init__(self):
        self.commands = []
        self.closed = False

    async def transfer_multiple(self, cmd, *, latency):
        self.commands.append((cmd, latency))
        try:
            while not cmd.abort.is_set():
                yield array.array("H", [4000 << 2] * 256)
                await asyncio.sleep(0.001)
        finally:
            self.closed = True


def make_service(conn):
    service = DeviceService(str(CONFIG_PATH))

    async def ensure_conn():
        return conn

    service._ensure_conn = ensure_conn
    return service


def test_command_parks_both_axes_on_the_live_raster_path():
    service = DeviceService(str(CONFIG_PATH))
    cmd = service._build_beam_hold_cmd(BeamHoldRequest(x_code=1000, y_code=15000, dwell=3))
    assert (cmd._x_range.start, cmd._x_range.step) == (1000, 0)
    assert (cmd._y_range.start, cmd._y_range.step) == (15000, 0)
    assert cmd.continuous is True
    assert cmd.frame_blank is False
    assert cmd._dwell == 3
    assert cmd._beam_type == BeamType.Ion
    assert cmd._external_control is True


def test_blanked_hold_uses_no_beam_and_observe_only_takes_nothing():
    service = DeviceService(str(CONFIG_PATH))
    blanked = service._build_beam_hold_cmd(BeamHoldRequest(beam="blanked"))
    assert blanked._beam_type == BeamType.NoBeam
    observe = service._build_beam_hold_cmd(BeamHoldRequest(external_control=False))
    assert observe._external_control is False


def test_metadata_reports_sample_period_from_dwell():
    service = DeviceService(str(CONFIG_PATH))
    service._conversion_hz = 8_000_000.0
    meta = service.beam_hold_metadata(BeamHoldRequest(dwell=7, duration_s=12))
    assert meta["event"] == "metadata"
    assert meta["sample_period_us"] == pytest.approx(1.0)
    assert meta["duration_s"] == 12


def test_stops_after_duration_and_closes_the_transfer():
    conn = FakeConnection()
    service = make_service(conn)

    async def scenario():
        chunks = [c async for c in service.beam_hold_scan(BeamHoldRequest(duration_s=0.05))]
        return chunks

    chunks = asyncio.run(asyncio.wait_for(scenario(), timeout=5))
    assert chunks, "no samples streamed"
    assert conn.closed
    assert not service._lock.locked()


def test_stop_ends_the_hold_before_the_duration():
    conn = FakeConnection()
    service = make_service(conn)

    async def scenario():
        received = 0
        async for _ in service.beam_hold_scan(BeamHoldRequest(duration_s=600)):
            received += 1
            if received == 3:
                assert service.abort_active_scan() is True
        return received

    received = asyncio.run(asyncio.wait_for(scenario(), timeout=5))
    assert received >= 3
    assert conn.closed


def test_request_bounds():
    with pytest.raises(ValueError):
        BeamHoldRequest(x_code=16384)
    with pytest.raises(ValueError):
        BeamHoldRequest(duration_s=601)
    with pytest.raises(ValueError):
        BeamHoldRequest(beam="half")


def test_websocket_sends_metadata_then_samples_then_done(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import glasgow_service.api as api

    conn = FakeConnection()
    service = make_service(conn)
    service._conversion_hz = 8_000_000.0
    monkeypatch.setattr(api, "svc", service)
    app = FastAPI()  # route only: no lifespan, no device
    app.add_api_websocket_route("/scan/beam_hold/stream", api.stream_beam_hold)

    with TestClient(app).websocket_connect("/scan/beam_hold/stream") as ws:
        ws.send_json({"duration_s": 0.05, "dwell": 7})
        first = ws.receive_json()
        assert first["event"] == "metadata"
        assert first["sample_period_us"] == pytest.approx(1.0)
        samples = 0
        while True:
            message = ws.receive()
            if message.get("bytes") is not None:
                samples += len(message["bytes"]) // 2
                continue
            assert '"done"' in message["text"]
            break
    assert samples > 0
    assert conn.closed


# ---- matching a scan: same frames, frame time and Frame blank, no timer ----

from glasgow_service.models import BeamHoldScanPlan


def test_hold_matches_the_scan_frame_time_and_frame_count():
    service = DeviceService(str(CONFIG_PATH))
    service._conversion_hz = 8_000_000.0
    plan = BeamHoldScanPlan(frame_pixels=1024 * 1024, dwell=16, frames=3, frame_blank=True)
    req = BeamHoldRequest(match=plan, dwell=7)
    cmd = service._build_beam_hold_cmd(req)
    x, y = cmd._x_range.count, cmd._y_range.count
    assert (cmd._x_range.step, cmd._y_range.step) == (0, 0)
    scan_frame = 1024 * 1024 * 17 / 8e6
    hold_frame = x * y * (cmd._dwell + 1) / 8e6
    assert abs(hold_frame - scan_frame) / scan_frame < 0.001
    assert cmd._dwell == 7
    assert cmd._max_frames == 3 and cmd.continuous
    assert cmd.frame_blank is True
    meta = service.beam_hold_metadata(req)
    assert meta["frames"] == 3 and meta["frame_blank"] is True
    assert meta["takeover_s"] == pytest.approx(3 * hold_frame + 0.040)
    assert meta["sample_period_us"] == pytest.approx(1.0)


def test_frame_blank_follows_the_scan_or_the_service_default():
    service = DeviceService(str(CONFIG_PATH))
    off = service._build_beam_hold_cmd(BeamHoldRequest(
        match=BeamHoldScanPlan(frame_pixels=4096, dwell=7, frame_blank=False)))
    assert off.frame_blank is False
    default = service._build_beam_hold_cmd(BeamHoldRequest(
        match=BeamHoldScanPlan(frame_pixels=4096, dwell=7)))
    assert default.frame_blank is bool(service._raster_params_defaults.frame_blank)


def test_a_coarse_scan_samples_at_its_own_dwell():
    service = DeviceService(str(CONFIG_PATH))
    cmd = service._build_beam_hold_cmd(BeamHoldRequest(
        match=BeamHoldScanPlan(frame_pixels=256 * 256, dwell=3), dwell=7))
    assert cmd._dwell == 3
    assert cmd._x_range.count * cmd._y_range.count >= 256 * 256


def test_huge_frames_fit_the_dac_counters_without_changing_the_time():
    service = DeviceService(str(CONFIG_PATH))
    plan = BeamHoldScanPlan(frame_pixels=16384 * 16384, dwell=255)
    cmd = service._build_beam_hold_cmd(BeamHoldRequest(match=plan, dwell=0))
    assert cmd._x_range.count <= 16384 and cmd._y_range.count <= 16384
    held = cmd._x_range.count * cmd._y_range.count * (cmd._dwell + 1)
    assert abs(held - 16384 * 16384 * 256) / (16384 * 16384 * 256) < 0.001


def test_a_matched_hold_ends_with_its_last_frame_not_a_timer():
    conn = FakeConnection()
    service = make_service(conn)
    finished = []

    async def scenario():
        req = BeamHoldRequest(match=BeamHoldScanPlan(frame_pixels=64, dwell=0, frames=2))
        gen = service.beam_hold_scan(req)
        received = 0
        async for _ in gen:
            received += 1
            if received == 5:
                # The command (not a timer) ends the session: simulate the
                # last frame completing by stopping the fake stream.
                service._active_command.abort.set()
        finished.append(received)

    asyncio.run(asyncio.wait_for(scenario(), timeout=5))
    assert conn.closed and finished
    cmd = conn.commands[0][0]
    assert cmd._max_frames == 2


@pytest.mark.parametrize("production, sim_default, session, allowed", [
    (True,  True,  None,               True),   # production always uses the hardware
    (True,  True,  {"enabled": True},  True),   # ...even with a session override
    (False, True,  None,               False),  # simulation (default): no takeover
    (False, False, None,               True),   # bench: IsProduction=false, simulation off
    (False, False, {"enabled": True},  False),  # session switched simulation back on
    (False, True,  {"enabled": False}, True),   # session switched simulation off
])
def test_beam_hold_runs_exactly_when_a_scan_would_use_the_hardware(
        production, sim_default, session, allowed):
    from glasgow_service.models import RasterRequest
    service = DeviceService(str(CONFIG_PATH))
    service._config.IsProduction = production
    service._simulation_defaults = {**service._simulation_defaults, "enabled": sim_default}
    hold = BeamHoldRequest(simulation=session)
    scan = RasterRequest(simulation=session)
    # Same decision as a scan with the same settings.
    assert (not service._hardware_free(scan)) is allowed
    if allowed:
        service.check_beam_hold_allowed(hold)
    else:
        with pytest.raises(Exception, match="only when scans use the hardware"):
            service.check_beam_hold_allowed(hold)


def test_a_refused_hold_never_touches_the_device():
    service = DeviceService(str(CONFIG_PATH))
    service._config.IsProduction = False
    service._simulation_defaults = {**service._simulation_defaults, "enabled": True}

    async def ensure_conn():
        raise AssertionError("simulation must not open the Glasgow")

    service._ensure_conn = ensure_conn

    async def scenario():
        async for _ in service.beam_hold_scan(BeamHoldRequest()):
            pass

    with pytest.raises(Exception, match="only when scans use the hardware"):
        asyncio.run(scenario())


def test_defaults_report_the_switch_delay():
    service = DeviceService(str(CONFIG_PATH))
    assert service._switch_delay_ms() == 20.0
    assert service.defaults()["takeover"] == {"ext_switch_delay_ms": 20.0}
