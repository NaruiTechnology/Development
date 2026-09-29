"""Per-scan host-link timing, so a stalled DAC waveform can be attributed.

The FPGA only moves the beam while it has commands to execute and room to
push samples back. When the host falls behind, the beam parks and the X DAC
shows flat steps instead of a continuous sawtooth. There are three places the
host can fall behind, and they need different fixes:

* OUT  - the sender's write / pipeline-boundary flush takes longer than one
         chunk's beam time, so the command FIFO runs dry.  (Like upstream OBI
         the raster sender does not flush per RasterPixelRun; it flushes at
         pipeline boundaries and at the end of the frame.)
* IN   - USB IN transfers do not keep up with the sample rate, so the FPGA's
         output FIFO fills and backpressure stalls the scan.
* host - the consumer of the macro's generator (websocket send, ADC monitor,
         image assembly) takes longer per chunk than the beam does.

Each macro fills one ``LinkStats`` and logs ``summary()`` once at the end of a
scan (success, abort or error). ``beam_hz`` (ADC conversions per second) is
set on the command by the service; without it only raw timings are logged.
The ``limit=`` field is a heuristic hint, not a measurement of the FPGA.
"""
import time
from typing import Optional


class LinkStats:
    def __init__(self, kind: str, dwell: Optional[int] = None,
                 beam_hz: Optional[float] = None, expected_chunks: Optional[int] = None):
        self.kind = kind
        self.dwell = dwell
        self.beam_hz = beam_hz
        self.expected_chunks = expected_chunks
        self.t0 = time.perf_counter()
        self.chunks_sent = 0
        self.chunks_recv = 0
        self.pixels_recv = 0
        self.flush_s = 0.0
        self.flush_max_s = 0.0
        self.read_s = 0.0
        self.read_max_s = 0.0
        self.consumer_s = 0.0
        self.consumer_max_s = 0.0

    # -- recording ---------------------------------------------------------
    def sent(self, flush_s: float) -> None:
        self.chunks_sent += 1
        self.flush_s += flush_s
        self.flush_max_s = max(self.flush_max_s, flush_s)

    def received(self, read_s: float, pixels: int) -> None:
        self.chunks_recv += 1
        self.pixels_recv += int(pixels)
        self.read_s += read_s
        self.read_max_s = max(self.read_max_s, read_s)

    def consumed(self, consumer_s: float) -> None:
        self.consumer_s += consumer_s
        self.consumer_max_s = max(self.consumer_max_s, consumer_s)

    # -- reporting ---------------------------------------------------------
    def beam_s(self) -> Optional[float]:
        """Beam time of the received pixels: dwell + 1 conversions each."""
        if not self.beam_hz or self.dwell is None:
            return None
        return self.pixels_recv * (int(self.dwell) + 1) / float(self.beam_hz)

    def limit_hint(self, wall_s: float) -> str:
        beam = self.beam_s()
        if beam is None or self.chunks_recv == 0 or wall_s <= 0:
            return "unknown"
        if beam / wall_s >= 0.9:
            return "none"
        per_chunk_beam = beam / self.chunks_recv
        if self.chunks_sent and self.flush_s / self.chunks_sent > per_chunk_beam:
            return "OUT(flush)"
        if self.consumer_s / self.chunks_recv > per_chunk_beam:
            return "host(consumer)"
        return "IN(usb-read)"

    def summary(self, outcome: str = "ok") -> str:
        wall = time.perf_counter() - self.t0
        beam = self.beam_s()
        sent = max(1, self.chunks_sent)
        recv = max(1, self.chunks_recv)
        expected = "?" if self.expected_chunks is None else str(self.expected_chunks)
        beam_txt = "?" if beam is None else f"{beam * 1e3:.1f}ms"
        duty_txt = "?" if beam is None or wall <= 0 else f"{100.0 * beam / wall:.0f}%"
        return (
            f"[link] {self.kind} {outcome}: chunks sent={self.chunks_sent} "
            f"recv={self.chunks_recv}/{expected} pixels={self.pixels_recv} "
            f"wall={wall * 1e3:.1f}ms beam={beam_txt} duty={duty_txt} | "
            f"flush mean={self.flush_s / sent * 1e3:.2f}ms max={self.flush_max_s * 1e3:.2f}ms | "
            f"read mean={self.read_s / recv * 1e3:.2f}ms max={self.read_max_s * 1e3:.2f}ms | "
            f"consumer mean={self.consumer_s / recv * 1e3:.2f}ms "
            f"max={self.consumer_max_s * 1e3:.2f}ms | limit={self.limit_hint(wall)}"
        )
