"""The host hands the instrument back after every scan transfer.

A scan takes external control (scan-select and blank-enable relays) and ends
blanked. Before USB is closed, Connection must send Blank(on) ->
ExternalCtrl(off) -> Synchronize and wait for the cookie, on every exit path:
normal end, Stop / WebSocket close (generator closed early) and errors.
"""
import asyncio
import struct
import unittest

from GlasgowDataIO.IobeamControl.transfer.abc import Connection, Stream
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    BlankCommand, ExternalCtrlCommand,
)

RELEASE = bytes(BlankCommand(enable=True, inline=False)) + bytes(ExternalCtrlCommand(enable=False))


class RecordingStream(Stream):
    def __init__(self, *, reply=True, hang=False):
        super().__init__(None)
        self.writes = bytearray()
        self.reply = reply
        self.hang = hang

    async def write(self, data):
        self.writes.extend(bytes(data))

    async def flush(self):
        pass

    async def read(self, length):
        return memoryview(bytes(length))

    async def readuntil(self, separator=b"\n", *, flush=True, max_count=False):
        if self.hang:
            await asyncio.Event().wait()
        # Pretend queued pixels precede the cookie, as after a Stop.
        return memoryview(b"\x12\x34" * 8 + (separator if self.reply else b""))


class RecordingConnection(Connection):
    def __init__(self, stream):
        super().__init__(None)
        self._stream = stream
        self._synchronized = True
        self.closed = 0

    async def _connect(self):
        raise AssertionError("already connected")

    async def _post_transfer_cleanup(self):
        # Mirrors GlasgowConnection: USB is closed after every transfer.
        self.closed += 1
        self._stream = None
        self._synchronized = False


class FakeScan:
    def __init__(self, *, external_control=True, frames=3, fail_at=None):
        self._external_control = external_control
        self.frames = frames
        self.fail_at = fail_at

    async def transfer(self, stream, **kwargs):
        for i in range(self.frames):
            if i == self.fail_at:
                raise RuntimeError("ADC presence check failed")
            await stream.write(b"\xaa\xaa")  # stands in for pixel commands
            yield i


def run(coro):
    return asyncio.run(coro)


class ExternalControlReleaseTest(unittest.TestCase):
    def assert_released_last(self, stream, conn):
        tail = bytes(stream.writes)
        start = tail.rfind(RELEASE)
        self.assertNotEqual(start, -1, "Blank(on) + ExternalCtrl(off) not sent")
        # Nothing but the Synchronize/Flush handshake may follow the release.
        self.assertNotIn(b"\xaa\xaa", tail[start:])
        self.assertEqual(conn.closed, 1)

    def test_released_after_a_complete_scan(self):
        stream = RecordingStream()
        conn = RecordingConnection(stream)

        async def go():
            return [x async for x in conn.transfer_multiple(FakeScan())]

        self.assertEqual(run(go()), [0, 1, 2])
        self.assert_released_last(stream, conn)

    def test_released_when_stop_or_disconnect_closes_the_stream_early(self):
        stream = RecordingStream()
        conn = RecordingConnection(stream)

        async def go():
            gen = conn.transfer_multiple(FakeScan(frames=100))
            async for x in gen:
                if x == 1:
                    break
            await gen.aclose()  # what the WebSocket handler does

        run(go())
        self.assert_released_last(stream, conn)

    def test_released_when_the_scan_raises(self):
        stream = RecordingStream()
        conn = RecordingConnection(stream)

        async def go():
            async for _ in conn.transfer_multiple(FakeScan(fail_at=1)):
                pass

        with self.assertRaises(RuntimeError):
            run(go())
        self.assert_released_last(stream, conn)

    def test_nothing_sent_when_the_scan_never_took_control(self):
        stream = RecordingStream()
        conn = RecordingConnection(stream)

        async def go():
            return [x async for x in conn.transfer_multiple(FakeScan(external_control=False))]

        run(go())
        self.assertNotIn(RELEASE, bytes(stream.writes))
        self.assertEqual(conn.closed, 1)

    def test_handshake_waits_for_its_own_cookie(self):
        stream = RecordingStream()
        conn = RecordingConnection(stream)
        cookie = conn._next_cookie

        async def go():
            async for _ in conn.transfer_multiple(FakeScan(frames=1)):
                pass

        run(go())
        sync = bytes(stream.writes)[bytes(stream.writes).rfind(RELEASE) + len(RELEASE):]
        self.assertIn(struct.pack(">H", cookie), sync)

    def test_dead_link_cannot_hang_cleanup(self):
        stream = RecordingStream(hang=True)
        conn = RecordingConnection(stream)
        conn.RELEASE_TIMEOUT_S = 0.05

        async def go():
            async for _ in conn.transfer_multiple(FakeScan(frames=1)):
                pass

        run(asyncio.wait_for(go(), timeout=2))
        self.assertEqual(conn.closed, 1)

    def test_unconfirmed_release_still_closes(self):
        stream = RecordingStream(reply=False)
        conn = RecordingConnection(stream)

        async def go():
            async for _ in conn.transfer_multiple(FakeScan(frames=1)):
                pass

        run(go())
        self.assert_released_last(stream, conn)


if __name__ == "__main__":
    unittest.main()
