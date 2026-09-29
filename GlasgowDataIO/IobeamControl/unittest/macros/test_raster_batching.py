"""The raster sender must batch RasterPixelRun commands like upstream OBI.

Upstream OBI writes each RasterPixelRun and flushes USB only at pipeline
boundaries (a FlushCommand when the token budget is exhausted) and at the end
of the frame.  Flushing after every run puts the host USB round trip on the
scan's critical path; a hiccup then empties the FPGA command FIFO and the DAC
parks at its last value, which shows on a scope as a plateau in the X ramp
whatever the resolution or dwell.
"""
import asyncio
import unittest

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange, BeamType
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection, MockStream

RUN = b"\xc0"          # RasterPixelRun opcode (0xc0 | output/flags)
FLUSH_CMD = b"\x02"    # FlushCommand opcode


class EventStream(MockStream):
    def __init__(self):
        super().__init__()
        self.events = []

    async def write(self, data):
        self.events.append(("write", bytes(data)))

    async def flush(self):
        self.events.append(("flush", b""))


async def _run(resolution, dwell, latency, max_pipeline):
    rng = DACCodeRange.from_resolution(resolution)
    cmd = RasterScanCommand(cookie=123, x_range=rng, y_range=rng,
                            dwell_time=dwell, beam_type=BeamType.Ion,
                            max_pipeline=max_pipeline)
    conn = MockConnection()
    await conn._connect()
    conn._stream = EventStream()
    async for _ in conn.transfer_multiple(cmd, latency=latency):
        pass
    return conn._stream.events


def _run_writes(events):
    return [i for i, (kind, data) in enumerate(events)
            if kind == "write" and data[:1] == RUN]


class RasterBatchingTest(unittest.TestCase):
    def check(self, resolution, dwell, latency, max_pipeline):
        events = asyncio.run(_run(resolution, dwell, latency, max_pipeline))
        runs = _run_writes(events)
        self.assertGreaterEqual(len(runs), 3, "need several chunks to test batching")
        for i in runs:
            # no flush directly after a RasterPixelRun write
            self.assertNotEqual(events[i + 1][0], "flush", (resolution, dwell, i))
        # every flush after the first run is a pipeline boundary / finalization
        for j in range(runs[0], len(events)):
            if events[j][0] == "flush":
                prev = events[j - 1]
                self.assertEqual(prev[0], "write")
                self.assertNotEqual(prev[1][:1], RUN)
        # at most one flush per max_pipeline runs (+ finalization), not one per run
        flushes = sum(1 for k, _ in events[runs[0]:] if k == "flush")
        self.assertLessEqual(flushes, len(runs) // max(1, max_pipeline) + 3)
        return events

    def test_default_pipeline_batches_all_runs(self):
        events = self.check(256, 16, 65536, 32)
        first, last = _run_writes(events)[0], _run_writes(events)[-1]
        self.assertFalse([e for e in events[first:last] if e[0] == "flush"],
                         "runs inside one pipeline window must not be flushed")

    def test_small_pipeline_flushes_at_boundaries_only(self):
        self.check(256, 16, 65536, 4)

    def test_smoothness_settings_do_not_change_the_batching(self):
        # resolution / dwell change slope and frequency only, never the flush
        # structure of the sender.
        for resolution, dwell, latency in ((128, 1, 2048), (256, 3, 16384),
                                           (256, 63, 262144)):
            with self.subTest(resolution=resolution, dwell=dwell):
                self.check(resolution, dwell, latency, 8)


if __name__ == "__main__":
    unittest.main()
