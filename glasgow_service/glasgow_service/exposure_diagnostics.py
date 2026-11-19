"""Bounded exposure alignment evidence, never a second traversal of the spot stream.

Ordinals describe host ordering, not independently measured beam positions. INFO records
share GlasgowService's normal rotating log. No individual-sample or image dumps.
"""
from __future__ import annotations

from contextvars import ContextVar
import hashlib
from functools import lru_cache
from pathlib import Path
import json
import os
import time
import uuid
import zlib

import numpy as np


exposure_scan_id = ContextVar("exposure_scan_id", default=None)

def _bounded(value):
    if isinstance(value, dict):
        return {key: _bounded(item) for key, item in value.items()}
    if isinstance(value, list):
        if len(value) > 8:
            digest = hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()
            return {"count": len(value), "first": value[:3], "last": value[-3:], "sha256": digest}
        return [_bounded(item) for item in value]
    return value


@lru_cache(maxsize=1)
def _implementation_hashes():
    root = Path(__file__).resolve().parents[2]
    files = [Path(__file__), Path(__file__).with_name("service.py"),
             root / "GlasgowDataIO/IobeamControl/macros/vector.py"]
    return {file.name: hashlib.sha256(file.read_bytes()).hexdigest()[:16] for file in files if file.is_file()}


class ExposureDiagnostics:
    def __init__(self, logger, request, source, transport):
        self.logger = logger
        self.id = exposure_scan_id.get() or uuid.uuid4().hex[:12]
        self.source = source
        self.started = self.last_report = time.monotonic()
        self.last_adc = self.started
        self.max_adc_gap_ms = 0.0
        self.sent = self.received = self.chunks_sent = self.chunks_received = 0
        self.wire_bytes = self.forwarded = 0
        self.sync_ok = None
        self.padding = 0
        self.padding_host_flushed = False
        self.command_crc = self.wire_crc = 0
        self.records = 0
        self.first_points = self.last_points = None
        fields = {"diagnostic_context", "cookie", "pattern", "lattice", "output_mode", "adc_valid", "dwell", "latency_bytes", "scan_path", "roi", "continuous"}
        details = _bounded(request.model_dump(mode="json", include=fields))
        if getattr(request, "lattice", None) is not None:
            from .exposure_lattice_adapter import shape_from_request
            from .exposure_lattice import build_lattice
            spec = request.lattice
            grid = build_lattice(shape_from_request(spec.shape), spec.pitch_x, spec.pitch_y, spec.axis)
            details["grid"] = {"nx": grid.nx, "ny": grid.ny, "fast_axis": grid.axis,
                               "pitch_x": grid.pitch_x, "pitch_y": grid.pitch_y}
        self.emit("start", diagnostic_version=1, source=source, transport=transport,
                  request=details, implementation=_implementation_hashes(), correspondence="host_order_inferred_not_position_tagged")

    def emit(self, event, warning=False, **fields):
        message = json.dumps(dict(event=event, scan_id=self.id, elapsed_ms=round((time.monotonic()-self.started)*1000, 3), **fields), separators=(",", ":"), default=str)
        (self.logger.warning if warning else self.logger.info)("[exposure-diag] %s", message)

    def command_sent(self, count, commands, endpoints=None):
        start = self.sent
        self.sent += count
        self.chunks_sent += 1
        self.command_crc = zlib.crc32(commands, self.command_crc)
        if endpoints:
            if self.first_points is None:
                self.first_points = endpoints[0]
            self.last_points = endpoints[1]
        if self.chunks_sent <= 3:
            self.emit("command", chunk=self.chunks_sent, ordinal_start=start, ordinal_end_exclusive=self.sent,
                      samples=count, command_bytes=len(commands), endpoints=endpoints,
                      command_crc32=f"{self.command_crc:08x}")

    def synchronize(self, actual, expected):
        self.sync_ok = bytes(actual) == bytes(expected)
        self.emit("synchronize", warning=not self.sync_ok, actual=bytes(actual).hex(),
                  expected=bytes(expected).hex(), matches=self.sync_ok)

    def drain(self, count):
        self.padding += count
        self.emit("padding", stage="planned", samples=count, coordinate=[0, 0], dwell_ticks=1,
                  delivered_to_client=False)

    def drain_flushed(self):
        self.padding_host_flushed = True
        self.emit("padding", stage="host_flush_returned", samples=self.padding,
                  delivered_to_client=False)

    def observe(self, values, wire):
        values = np.asarray(values).reshape(-1)
        start = self.received
        self.received += values.size
        self.chunks_received += 1
        self.wire_bytes += len(wire)
        self.wire_crc = zlib.crc32(wire, self.wire_crc)
        now = time.monotonic()
        gap_ms = (now-self.last_adc)*1000
        self.last_adc = now
        self.max_adc_gap_ms = max(self.max_adc_gap_ms, gap_ms)
        if self.records >= 128 or not (self.chunks_received <= 3 or now-self.last_report >= 5):
            return
        self.records += 1
        self.last_report = now
        # Bound statistical work to 2048 samples; endpoints remain exact.
        sample = values[::max(1, (values.size+2047)//2048)].astype(np.float64)
        self.emit("adc", chunk=self.chunks_received, ordinal_start=start, ordinal_end_exclusive=self.received,
                  samples=int(values.size), chunk_gap_ms=round(gap_ms, 3), sent_so_far=self.sent if self.source == "hardware" else None,
                  wire_bytes=len(wire), wire_crc32=f"{self.wire_crc:08x}",
                  first=[int(v) for v in values[:8]], last=[int(v) for v in values[-8:]],
                  stats_sampled=int(sample.size), minimum=float(sample.min()) if sample.size else None,
                  maximum=float(sample.max()) if sample.size else None, mean=float(sample.mean()) if sample.size else None,
                  low_two_bits_nonzero=int(np.count_nonzero(sample.astype(np.uint16) & 3)),
                  full_scale=int(np.count_nonzero(sample == 65532)))

    def finish(self, outcome, command=None):
        stats = getattr(command, "_link_stats", None)
        mismatch = self.source == "hardware" and self.sent != self.received
        self.emit("end", warning=outcome == "ok" and (mismatch or self.sync_ok is False), outcome=outcome,
                  commanded=self.sent if self.source == "hardware" else None, received=self.received,
                  forwarded_to_consumer=self.forwarded, wire_bytes=self.wire_bytes, command_chunks=self.chunks_sent,
                  adc_chunks=self.chunks_received, count_matches=(not mismatch) if self.source == "hardware" else None,
                  synchronization_matches=self.sync_ok, padding_samples=self.padding,
                  padding_host_flushed=self.padding_host_flushed,
                  first_point=self.first_points, last_point=self.last_points,
                  command_crc32=f"{self.command_crc:08x}", wire_crc32=f"{self.wire_crc:08x}",
                  max_adc_gap_ms=round(self.max_adc_gap_ms, 3),
                  link_pixels_received=getattr(stats, "pixels_recv", None))


def exposure_diagnostics(logger, request, source, transport):
    if os.environ.get("IONBEAM_EXPOSURE_DIAGNOSTICS", "1").lower() in {"0", "false", "off"}:
        return None
    return ExposureDiagnostics(logger, request, source, transport)


class ExposureWireDiagnostics:
    """Count only frames successfully handed to the WebSocket implementation."""
    def __init__(self, logger):
        self.logger = logger
        self.id = uuid.uuid4().hex[:12]
        self.bytes = self.chunks = self.crc = 0
        self.max_send_ms = 0.0

    def sent(self, wire, elapsed):
        self.bytes += len(wire)
        self.chunks += 1
        self.crc = zlib.crc32(wire, self.crc)
        self.max_send_ms = max(self.max_send_ms, elapsed*1000)

    def finish(self, completed):
        self.logger.info("[exposure-diag] %s", json.dumps({
            "event": "wire_end", "scan_id": self.id, "completed": completed,
            "chunks_sent": self.chunks, "bytes_sent": self.bytes,
            "wire_crc32": f"{self.crc:08x}", "max_send_ms": round(self.max_send_ms, 3),
            "delivery": "websocket_send_returned_not_browser_acknowledged",
        }, separators=(",", ":")))
