"""Per-scan timing for the desktop engine.

Logged once per scan (and shown in the UI's run report) so the claim "the
host is no longer the bottleneck" can be checked on the instrument: duty =
beam time / wall time, where beam time = samples x (dwell + 1) conversions at
the configured ADC rate. OBI-class behaviour is duty close to 100 % for any
frame larger than a few hundred microseconds of beam time.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ScanPerf:
    kind: str
    params: dict
    t_start: float
    conversion_hz: float
    dwell: int
    t_first: Optional[float] = None
    t_end: Optional[float] = None
    samples: int = 0
    chunks: int = 0
    stopped: bool = False
    connects_before: int = 0
    connects_after: int = 0
    reset_ms: Optional[float] = None
    extra: dict = field(default_factory=dict)

    @classmethod
    def begin(cls, kind: str, request: dict, svc) -> "ScanPerf":
        dwell = int(request.get("dwell", 0) or 0)
        params = {k: request.get(k) for k in ("resolution", "vector_resolution", "dwell", "latency_bytes",
                                              "pattern", "scan_path", "preview") if k in request}
        return cls(kind=kind, params=params, t_start=time.perf_counter(),
                   conversion_hz=float(getattr(svc, "_conversion_hz", 0.0) or 0.0), dwell=dwell,
                   connects_before=svc.session_stats.connects)

    def chunk(self, samples: int) -> None:
        if self.t_first is None:
            self.t_first = time.perf_counter()
        self.samples += samples
        self.chunks += 1

    def finish(self, svc, chunks: int, *, stopped: bool = False) -> None:
        self.t_end = time.perf_counter()
        self.chunks = chunks
        self.stopped = stopped
        self.connects_after = svc.session_stats.connects
        self.reset_ms = svc.session_stats.last_reset_s * 1e3 if svc.session_stats.soft_resets else None

    @property
    def wall_s(self) -> float:
        return (self.t_end or time.perf_counter()) - self.t_start

    @property
    def first_sample_s(self) -> Optional[float]:
        return None if self.t_first is None else self.t_first - self.t_start

    @property
    def beam_s(self) -> Optional[float]:
        if self.conversion_hz <= 0:
            return None
        return self.samples * (self.dwell + 1) / self.conversion_hz

    @property
    def duty(self) -> Optional[float]:
        beam = self.beam_s
        return None if beam is None or self.wall_s <= 0 else beam / self.wall_s

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "params": self.params,
            "wall_ms": round(self.wall_s * 1e3, 2),
            "first_sample_ms": None if self.first_sample_s is None else round(self.first_sample_s * 1e3, 2),
            "beam_ms": None if self.beam_s is None else round(self.beam_s * 1e3, 2),
            "duty": None if self.duty is None else round(self.duty, 4),
            "samples": self.samples,
            "chunks": self.chunks,
            "reconnected": self.connects_after > self.connects_before,
            "soft_reset_ms": None if self.reset_ms is None else round(self.reset_ms, 3),
            "stopped": self.stopped,
        }

    def summary(self) -> str:
        d = self.as_dict()
        return ("[perf] {kind} {params} wall={wall_ms}ms first_sample={first_sample_ms}ms beam={beam_ms}ms "
                "duty={duty} samples={samples} chunks={chunks} reconnected={reconnected} "
                "soft_reset={soft_reset_ms}ms stopped={stopped}").format(**d)
