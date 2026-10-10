"""Streamed vector scans must unblank the beam before the first point.

Same root cause as the raster macro: the gateware resets blanked, and points
without an explicit blank flag never send a BlankCommand.
"""
import asyncio
import unittest

from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand
from GlasgowDataIO.IobeamControl.commands import BeamType
from GlasgowDataIO.IobeamControl.commands.low_level_commands import BlankCommand
from GlasgowDataIO.IobeamControl.transfer.mock import MockConnection, MockStream


class RecordingStream(MockStream):
    def __init__(self):
        super().__init__()
        self.writes = []

    async def write(self, data):
        self.writes.append(bytes(data))


async def _run(beam_type):
    points = [(x * 64, y * 64, 4) for y in range(8) for x in range(8)]
    cmd = VectorScanCommand(iter_points=iter(points), cookie=123,
                            beam_type=beam_type, external_control=True)
    conn = MockConnection()
    await conn._connect()
    conn._stream = RecordingStream()
    async for _ in conn.transfer_multiple(cmd, latency=65536):
        pass
    return conn._stream.writes


class VectorUnblankTest(unittest.TestCase):
    def test_unblank_precedes_sync_and_points(self):
        writes = asyncio.run(_run(BeamType.Ion))
        unblank = bytes(BlankCommand(enable=False, inline=True))
        self.assertEqual(writes[:3], [b"\x42", b"\x31", unblank])
        self.assertEqual(writes[3][:1], b"\x00")     # synchronize (raster=False)

    def test_no_beam_is_not_unblanked(self):
        writes = asyncio.run(_run(BeamType.NoBeam))
        self.assertNotIn(bytes(BlankCommand(enable=False, inline=True)), writes)


if __name__ == "__main__":
    unittest.main()
