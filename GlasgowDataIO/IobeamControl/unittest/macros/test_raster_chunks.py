"""Arithmetic chunking must equal the per-pixel loop it replaced.

The old `_iter_chunks` walked every pixel in Python (sender and receiver each
did it).  At large resolutions / short dwells that starves the asyncio loop for
tens of ms per chunk, which stalls USB IN servicing and shows up as plateaus
that depend on the scan settings.  The replacement must produce byte-identical
chunks.
"""
import unittest

from GlasgowDataIO.IobeamControl.macros import RasterScanCommand
from GlasgowDataIO.IobeamControl.commands import DACCodeRange, RasterPixelRunCommand
from GlasgowDataIO.IobeamControl.commands.low_level_commands import BlankCommand


def reference_chunks(cmd, latency):
    """Verbatim copy of the previous per-pixel implementation."""
    commands = bytearray()

    def append_command(pixel_count):
        while pixel_count > 65536:
            c = RasterPixelRunCommand(dwell_time=cmd._dwell, length=65535)
            commands.extend(bytes(c))
            pixel_count -= 65536
        c = RasterPixelRunCommand(dwell_time=cmd._dwell, length=pixel_count - 1)
        commands.extend(bytes(c))

    pixel_count = 0
    total_dwell = 0
    for n in range(cmd._x_range.count * cmd._y_range.count):
        pixel_count += 1
        total_dwell += cmd._dwell
        if total_dwell >= latency:
            append_command(pixel_count)
            if cmd.frame_blank and n + 1 == cmd._x_range.count * cmd._y_range.count:
                commands.extend(bytes(BlankCommand(enable=True, inline=False)))
            yield (bytes(commands), pixel_count)
            commands = bytearray()
            pixel_count = 0
            total_dwell = 0
    if pixel_count > 0:
        append_command(pixel_count)
        yield (bytes(commands), pixel_count)


class RasterChunkEquivalenceTest(unittest.TestCase):
    def test_matches_reference_for_many_settings(self):
        cases = 0
        for res in (16, 64, 128, 256):
            rng = DACCodeRange(0, res, 256)
            for dwell in (0, 1, 2, 3, 7, 15, 16, 31, 63, 255):
                for latency in (-5, 0, 1, 2, 3, 15, 16, 17, 1000, 4096, 8196,
                                65535, 65536, 65537, 262144, 65536 * 65536):
                    for frame_blank in (False, True):
                        cmd = RasterScanCommand(
                            cookie=1, x_range=rng, y_range=rng, dwell_time=dwell,
                            frame_blank=frame_blank)
                        got = [(bytes(c), n) for c, n in cmd._iter_chunks(latency)]
                        want = list(reference_chunks(cmd, latency))
                        self.assertEqual(got, want, (res, dwell, latency, frame_blank))
                        self.assertEqual(sum(n for _, n in got), res * res)
                        cases += 1
        self.assertGreater(cases, 1000)

    def test_large_frame_is_cheap(self):
        # 2048x2048 at dwell 1 with 100 ms chunks: must be O(chunks), not O(pixels)
        import time
        rng = DACCodeRange(0, 2048, 256)
        cmd = RasterScanCommand(cookie=1, x_range=rng, y_range=rng, dwell_time=1)
        t0 = time.perf_counter()
        chunks = list(cmd._iter_chunks(400_000))
        self.assertLess(time.perf_counter() - t0, 0.25)
        self.assertEqual(sum(n for _, n in chunks), 2048 * 2048)


if __name__ == "__main__":
    unittest.main()
