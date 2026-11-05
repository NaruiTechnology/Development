"""Regression: live scan froze when a pipeline token came back while the
sender was awaiting FlushCommand (lost wake-up on the old one-shot Future).

The fake stream models a device that only produces a chunk's pixels after the
host has written that chunk, so a stalled sender starves the receiver exactly
like the production log (silent sender, USB read TimeoutError).
"""
import asyncio
import unittest

from GlasgowDataIO.IobeamControl.commands.structs import DACCodeRange, OutputMode
from GlasgowDataIO.IobeamControl.macros.raster import RasterScanCommand


class FakeStream:
    def __init__(self, flush_delay, read_delay, read_timeout=2.0):
        self.flush_delay, self.read_delay, self.read_timeout = flush_delay, read_delay, read_timeout
        self.chunks_written = 0
        self.chunks_read = 0
        self._armed = False
        self._avail = asyncio.Semaphore(0)

    async def write(self, data):
        data = bytes(data)
        if self._armed and len(data) >= 4:     # pixel-run chunk (flush is 1 byte)
            self.chunks_written += 1
            self._avail.release()

    async def flush(self):
        await asyncio.sleep(self.flush_delay)  # the await in which the race lived

    async def read(self, n):
        if n == 4:                             # sync cookie reply
            self._armed = True
            return b"\x00" * 4
        try:
            await asyncio.wait_for(self._avail.acquire(), self.read_timeout)
        except asyncio.TimeoutError:
            raise TimeoutError("device starved: host sender stalled") from None
        await asyncio.sleep(self.read_delay)
        self.chunks_read += 1
        return b"\x00" * n


class PipelineTokenRaceTest(unittest.IsolatedAsyncioTestCase):
    async def _run(self, max_pipeline, frames_chunks):
        stream = FakeStream(flush_delay=0.02, read_delay=0.002)
        cmd = RasterScanCommand(
            x_range=DACCodeRange(0, 8, 1), y_range=DACCodeRange(0, 8, 1),
            dwell_time=1, cookie=1, output_mode=OutputMode.SixteenBit,
            max_pipeline=max_pipeline, continuous=True)
        got = 0
        agen = cmd.transfer(stream, latency=16)       # 4 chunks of 16 px per 64 px frame
        try:
            async for _ in agen:
                got += 1
                if got >= frames_chunks:
                    cmd.abort.set()
                    break
        finally:
            await agen.aclose()
        return got, stream

    async def test_sender_survives_token_return_during_flush(self):
        got, stream = await self._run(max_pipeline=2, frames_chunks=60)
        self.assertEqual(got, 60)
        self.assertGreaterEqual(stream.chunks_written, 60)


if __name__ == "__main__":
    unittest.main()
