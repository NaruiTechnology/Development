"""The raster macro must unblank the beam before the frame.

The gateware resets with the beam blanked (blank_enable init=1).  Upstream OBI
clients send BlankCommand(enable=False, inline=True) (opcode 0x52) before every
frame; a raster scan without it leaves the ion beam off, so the ADC only reads
its zero level and the image is flat gray.  Order seen on the wire from OBI:
0x42 (beam select ion), 0x31 (external ctrl on), 0x52 (unblank), sync, region.
"""
import asyncio
import unittest

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange, BeamType
from GlasgowDataIO.IobeamControl.commands.low_level_commands import BlankCommand
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection, MockStream


class RecordingStream(MockStream):
    def __init__(self):
        super().__init__()
        self.writes = []

    async def write(self, data):
        self.writes.append(bytes(data))


async def _run(beam_type):
    rng = DACCodeRange.from_resolution(256)
    cmd = RasterScanCommand(cookie=123, x_range=rng, y_range=rng, dwell_time=16,
                            beam_type=beam_type, external_control=True)
    conn = MockConnection()
    await conn._connect()
    conn._stream = RecordingStream()
    async for _ in conn.transfer_multiple(cmd, latency=65536):
        pass
    return conn._stream.writes


class RasterUnblankTest(unittest.TestCase):
    def test_unblank_precedes_sync_and_pixels(self):
        writes = asyncio.run(_run(BeamType.Ion))
        unblank = bytes(BlankCommand(enable=False, inline=True))
        self.assertEqual(unblank, b"\x52")
        self.assertIn(unblank, writes)
        first_pixel_run = next(i for i, w in enumerate(writes) if w[:1] == b"\xc0")
        self.assertLess(writes.index(unblank), first_pixel_run)
        # beam select, external ctrl, unblank, then synchronize
        self.assertEqual(writes[:3], [b"\x42", b"\x31", unblank])
        self.assertEqual(writes[3][:1], b"\x01")

    def test_no_beam_is_not_unblanked(self):
        writes = asyncio.run(_run(BeamType.NoBeam))
        self.assertNotIn(bytes(BlankCommand(enable=False, inline=True)), writes)


if __name__ == "__main__":
    unittest.main()
