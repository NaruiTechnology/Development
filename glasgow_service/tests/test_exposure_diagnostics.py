import array
import asyncio
import json
import zlib
from pathlib import Path

import pytest

from glasgow_service.exposure_diagnostics import ExposureDiagnostics, ExposureWireDiagnostics, exposure_diagnostics
from glasgow_service.models import VectorRequest
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.transfer.mock import MockStream


class Log:
    def __init__(self):
        self.records = []

    def info(self, format, *args):
        if format == "[exposure-diag] %s":
            self.records.append(("info", json.loads(args[0])))

    def warning(self, format, *args):
        if format == "[exposure-diag] %s":
            self.records.append(("warning", json.loads(args[0])))

    def debug(self, *args):
        pass


def request(**kwargs):
    return VectorRequest(pattern="lattice", lattice={
        "shape": {"kind": "rect", "x0": 0, "x1": 4, "y0": 0, "y1": 2},
        "pitch_x": 1, "dwell": 7, "passes": 1,
    }, **kwargs)


def test_alignment_summary_and_wire_checksums():
    log = Log()
    diag = ExposureDiagnostics(log, request(), "hardware", "websocket")
    diag.command_sent(3, b"commands", ((1, 1, 7, False, 1), (3, 1, 7, False, 1)))
    diag.synchronize(bytes.fromhex("ffff007b"), bytes.fromhex("ffff007b"))
    values = array.array("H", [0, 400, 65532])
    wire = bytes.fromhex("00000190fffc")
    diag.observe(values, wire)
    diag.forwarded += len(values)
    diag.drain(32)
    diag.finish("ok")
    summary = log.records[-1][1]
    assert summary["count_matches"] is True
    assert summary["synchronization_matches"] is True
    assert summary["received"] == summary["forwarded_to_consumer"] == 3
    assert summary["padding_samples"] == 32
    assert summary["wire_crc32"] == f"{zlib.crc32(wire):08x}"
    adc = next(record for _, record in log.records if record["event"] == "adc")
    assert adc["first"] == [0, 400, 65532]
    assert adc["low_two_bits_nonzero"] == 0
    wire_log = ExposureWireDiagnostics(log)
    wire_log.sent(wire, .002)
    wire_log.finish(True)
    assert log.records[-1][1]["wire_crc32"] == summary["wire_crc32"]


def test_sync_and_sample_count_mismatches_warn_without_altering_stream():
    log = Log()
    diag = ExposureDiagnostics(log, request(), "hardware", "websocket")
    diag.command_sent(10, b"commands")
    diag.synchronize(b"bad!", bytes.fromhex("ffff007b"))
    diag.observe([400], bytes.fromhex("0190"))
    diag.finish("ok")
    assert log.records[-1][0] == "warning"
    assert log.records[-1][1]["count_matches"] is False
    assert any(level == "warning" and entry["event"] == "synchronize" for level, entry in log.records)
    diag.finish("aborted")
    assert log.records[-1][0] == "info", "partial Stop is not reported as successful-count failure"


def test_diagnostics_are_bounded_and_can_be_disabled(monkeypatch):
    log = Log()
    diag = ExposureDiagnostics(log, request(), "hardware", "websocket")
    for _ in range(500):
        diag.last_report = 0
        diag.observe([4] * 10000, b"wire")
    adc = [entry for _, entry in log.records if entry["event"] == "adc"]
    assert len(adc) == 128
    assert max(entry["stats_sampled"] for entry in adc) <= 2048
    monkeypatch.setenv("IONBEAM_EXPOSURE_DIAGNOSTICS", "off")
    assert exposure_diagnostics(log, request(), "hardware", "websocket") is None


def test_real_vector_encoder_and_receiver_report_actual_spots_excluding_padding():
    class Stream(MockStream):
        async def read(self, length):
            if length == 4:
                return memoryview(bytes.fromhex("ffff007b"))
            return await super().read(length)

    async def run():
        log = Log()
        diag = ExposureDiagnostics(log, request(), "hardware", "websocket")
        points = [(1, 1, 7, False, 1), (2, 1, 7, False, 1), (3, 1, 7, False, 1)]
        cmd = VectorScanCommand(cookie=123, iter_points=iter(points), frame_blank=False,
                                require_sender_completion=True, drain_floor_pixels=32)
        cmd.exposure_diagnostics = diag
        actual = []
        async for chunk in cmd.transfer(Stream(), latency=14):
            actual.extend(chunk)
            diag.observe(chunk, bytes(len(chunk) * 2))
        diag.finish("ok", cmd)
        summary = log.records[-1][1]
        assert len(actual) == summary["commanded"] == summary["received"] == 3
        assert summary["synchronization_matches"] is True
        assert summary["first_point"] == list(points[0])
        assert summary["last_point"] == list(points[-1])
        assert summary["padding_samples"] == 32
    asyncio.run(run())


def test_context_validated_and_preserved():
    context = {"run_id": "test-run", "step_id": "circle:1", "pass_index": 3, "segment_index": 2}
    log = Log()
    ExposureDiagnostics(log, request(diagnostic_context=context), "simulation", "websocket")
    assert log.records[0][1]["request"]["diagnostic_context"] == context
    with pytest.raises(ValueError):
        request(diagnostic_context={**context, "run_id": "x" * 81})


def test_simulated_service_emits_the_same_adc_and_end_records(monkeypatch):
    from glasgow_service import service
    log = Log()
    monkeypatch.setattr(service, "logger", log)
    config = Path(__file__).resolve().parents[2] / "GlasgowDataIO/Json/streamData.json"
    svc = service.DeviceService(str(config))
    req = request(simulation={"enabled": True, "mode": "loopback"})
    async def run():
        chunks = [chunk async for chunk in svc._simulated_scan("vector", req)]
        assert sum(len(chunk) for chunk in chunks) == 16
    asyncio.run(run())
    end = next(entry for _, entry in log.records if entry["event"] == "end")
    assert end["outcome"] == "ok"
    assert end["received"] == 8
    assert any(entry["event"] == "simulation_source" and entry["mode"] == "loopback" for _, entry in log.records)


def test_websocket_and_service_logs_share_identity_and_checksum(monkeypatch):
    from fastapi.testclient import TestClient
    from glasgow_service import api, service
    log = Log()
    monkeypatch.setattr(api, "logger", log)
    monkeypatch.setattr(service, "logger", log)
    config = Path(__file__).resolve().parents[2] / "GlasgowDataIO/Json/streamData.json"
    svc = service.DeviceService(str(config))
    monkeypatch.setattr(api, "svc", svc)
    monkeypatch.setattr(svc, "_hardware_free", lambda req: True)
    req = request(simulation={"enabled": True, "mode": "loopback"}, diagnostic_context={
        "run_id": "browser-run", "step_id": "box:1", "pass_index": 3, "segment_index": 1})
    with TestClient(api.app).websocket_connect("/scan/vector/stream") as ws:
        ws.send_json(req.model_dump(mode="json"))
        received = b""
        while True:
            message = ws.receive()
            if message.get("bytes") is not None:
                received += message["bytes"]
            elif message.get("text"):
                assert json.loads(message["text"])["event"] == "done"
                break
    end = next(entry for _, entry in log.records if entry["event"] == "end")
    wire = next(entry for _, entry in log.records if entry["event"] == "wire_end")
    assert end["scan_id"] == wire["scan_id"]
    assert end["wire_crc32"] == wire["wire_crc32"] == f"{zlib.crc32(received):08x}"
    assert wire["bytes_sent"] == end["wire_bytes"] == len(received) == 16
    assert wire["completed"] is True


def test_diagnostics_preserve_the_command_bytes_and_chunk_boundaries():
    points = [(x, y, 7, False, 1) for y in range(4) for x in range(8)]
    plain = VectorScanCommand(cookie=123, iter_points=iter(points), frame_blank=False)
    traced = VectorScanCommand(cookie=123, iter_points=iter(points), frame_blank=False)
    traced.exposure_diagnostics = ExposureDiagnostics(Log(), request(), "hardware", "websocket")
    assert [(bytes(data), count) for data, count in plain._iter_chunks(56)] == [
        (bytes(data), count) for data, count in traced._iter_chunks(56)]
