"""A byte-level Glasgow/OBI emulator for tests and benchmarks (no USB, no FPGA).

``FakeGlasgowInterface`` stands in for ``DirectDemultiplexerInterface``: it
parses the command stream the real macros write (Synchronize, Flush,
Blank, BeamSelect, ExternalCtrl, RasterRegion, RasterPixel/Run/Fill,
VectorPixel, VectorPixelMinDwell, Array), emits one sample per pixel after
the beam time the pixel would take (``(dwell + 1) / conversion_hz``), and
implements ``reset()`` like the gateware reset (pending commands and
samples discarded). Samples are ``((cookie + n) * 4) & 0xfffc`` where ``n``
counts pixels since the last Synchronize, so a test can tell exactly which
scan a sample belongs to and detect stale data after an abort.

Host-link delivery follows the demultiplexer: written bytes reach the device
when 64 KiB have accumulated or on flush.
"""
from __future__ import annotations

import asyncio
import struct
import time
from typing import Optional

import numpy as np

OUT_THRESHOLD = 64 * 1024
_FIXED_LENGTH = {0x0: 3, 0x1: 1, 0x2: 1, 0x3: 1, 0x4: 1, 0x5: 1, 0x6: 3, 0xA: 13, 0xB: 3, 0xC: 5,
                 0xD: 3, 0xE: 7, 0xF: 5, 0x9: 3}
_ARRAY_PAYLOAD = {0xB: 2, 0xE: 6, 0xF: 4, 0xC: 4, 0x9: 2}


def sample_value(cookie: int, n: int) -> int:
    return ((cookie + n) * 4) & 0xFFFC


class _Buffer:
    def __init__(self):
        self._data = bytearray()
        self.total_read_bytes = 0
        self.total_written_bytes = 0

    def __len__(self):
        return len(self._data)

    def write(self, data) -> None:
        self._data.extend(data)
        self.total_written_bytes += len(data)

    def read(self, length: Optional[int] = None) -> memoryview:
        if length is None or length > len(self._data):
            length = len(self._data)
        out = bytes(self._data[:length])
        del self._data[:length]
        self.total_read_bytes += length
        return memoryview(out)

    def clear(self) -> None:
        self._data.clear()


class _Waiter:
    """Truthy object with wait_one(), like glasgow's TaskQueue for readuntil()."""

    def __init__(self, buffer: "_Buffer"):
        self._event = asyncio.Event()
        self._buffer = buffer

    def __bool__(self):
        return True

    def notify(self):
        self._event.set()

    async def wait_one(self):
        # wait_for() starts this coroutine one loop turn late; data emitted in
        # between must not be lost, so only block while the buffer is empty.
        await self.wait_for_length(1)

    async def wait_for_length(self, length: int):
        while len(self._buffer) < length:
            self._event.clear()
            await self._event.wait()


class FakeDevice:
    def __init__(self, on_close=None):
        self.registers: dict = {}
        self.closed = False
        self._on_close = on_close

    async def write_register(self, address, value, width=1):
        self.registers[address] = value

    async def read_register(self, address, width=1):
        return self.registers.get(address, 0)

    def close(self):
        self.closed = True
        if self._on_close is not None:
            self._on_close()


class FakeGlasgowInterface:
    def __init__(self, *, conversion_hz: float = 8_000_000.0, flush_latency_s: float = 0.0,
                 time_scale: float = 1.0):
        self.device = FakeDevice(on_close=self._shutdown)
        self.conversion_hz = conversion_hz
        self.flush_latency_s = flush_latency_s
        self.time_scale = time_scale
        self._in_buffer = _Buffer()
        self._out_buffer = _Buffer()
        self._in_tasks = _Waiter(self._in_buffer)
        self._pending = bytearray()      # delivered to the device, not yet parsed
        self._wake = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._generation = 0
        self.resets = 0
        self.output_mode = 0
        self.cookie = 0
        self.counter = 0
        self.region_count = 0
        self.pixels_emitted = 0
        self.iobeam_power_good_addr = None
        self.iobeam_bus_ownership_addr = None
        self._start()

    # ---- host side (DirectDemultiplexerInterface API) --------------------------

    async def write(self, data) -> None:
        self._out_buffer.write(bytes(data))
        if len(self._out_buffer) >= OUT_THRESHOLD:
            self._deliver()

    async def flush(self, wait: bool = True) -> None:
        if self.flush_latency_s and wait:
            await asyncio.sleep(self.flush_latency_s)
        self._deliver()

    async def read(self, length: Optional[int] = None, *, flush: bool = True) -> memoryview:
        if flush and len(self._out_buffer):
            await self.flush(wait=False)
        if length is None:
            await self._in_tasks.wait_for_length(1)
            return self._in_buffer.read()
        await self._in_tasks.wait_for_length(length)
        return self._in_buffer.read(length)

    async def cancel(self) -> None:
        pass

    async def reset(self) -> None:
        """Gateware + host FIFO reset: everything in flight is discarded."""
        self.resets += 1
        self._generation += 1
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._pending.clear()
        self._in_buffer.clear()
        self._out_buffer.clear()
        self.counter = 0
        self._start()

    def _shutdown(self) -> None:
        self._generation += 1
        if self._task is not None:
            self._task.cancel()

    def statistics(self) -> None:
        pass

    # ---- device side ----------------------------------------------------------

    def _start(self) -> None:
        self._task = asyncio.get_event_loop().create_task(self._run(self._generation))

    def _deliver(self) -> None:
        if len(self._out_buffer):
            self._pending.extend(self._out_buffer.read())
            self._wake.set()

    def _emit(self, data: bytes) -> None:
        self._in_buffer.write(data)
        self._in_tasks.notify()

    async def _pixels(self, dwells, generation: int) -> None:
        """Emit one sample per pixel, paced at the emulated beam rate.

        Vectorised so that the emulator's own cost stays far below the beam
        time it models (samples are produced in <= 2 ms beam-time slices).
        """
        dwells = np.asarray(dwells, dtype=np.float64)
        total = dwells.size
        if total == 0:
            return
        beam = np.cumsum((dwells + 1.0) / self.conversion_hz * self.time_scale)
        start = 0
        started_at = time.perf_counter()
        while start < total:
            stop = int(np.searchsorted(beam, (beam[start - 1] if start else 0.0) + 0.002, side="right"))
            stop = max(stop, start + 1)
            stop = min(stop, total)
            # sleep until the slice's beam time has elapsed (absolute schedule,
            # so emulator overhead does not accumulate on top of beam time)
            delay = started_at + beam[stop - 1] - time.perf_counter()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                await asyncio.sleep(0)
            if generation != self._generation:
                return
            n = np.arange(self.counter + start, self.counter + stop, dtype=np.int64)
            values = ((self.cookie + n) * 4) & 0xFFFC
            if self.output_mode == 0:
                self._emit(values.astype(">u2").tobytes())
            elif self.output_mode == 1:
                self._emit((values >> 8).astype(np.uint8).tobytes())
            start = stop
        self.counter += total
        self.pixels_emitted += total

    async def _run(self, generation: int) -> None:
        buf = self._pending
        while generation == self._generation:
            if not buf:
                self._wake.clear()
                await self._wake.wait()
                continue
            op = buf[0] >> 4
            flags = buf[0] & 0xF
            if op == 0x8:  # Array
                if len(buf) < 3:
                    await self._need_more()
                    continue
                inner = flags
                count = struct.unpack(">H", buf[1:3])[0] + 1
                size = 3 + count * _ARRAY_PAYLOAD.get(inner, 0)
                if len(buf) < size:
                    await self._need_more()
                    continue
                body = bytes(buf[3:size])
                del buf[:size]
                dwells = []
                step = _ARRAY_PAYLOAD.get(inner, 0)
                for i in range(count):
                    item = body[i * step:(i + 1) * step]
                    if inner == 0xE:
                        dwells.append(struct.unpack(">HHH", item)[2])
                    elif inner in (0xB, 0x9):
                        dwells.append(struct.unpack(">H", item)[0])
                    elif inner == 0xC:
                        length, dwell = struct.unpack(">HH", item)
                        dwells.extend([dwell] * (length + 1))
                    else:
                        dwells.append(1)
                await self._pixels(dwells, generation)
                continue
            size = _FIXED_LENGTH.get(op, 1)
            if len(buf) < size:
                await self._need_more()
                continue
            cmd = bytes(buf[:size])
            del buf[:size]
            if op == 0x0:  # Synchronize
                self.cookie = struct.unpack(">H", cmd[1:3])[0]
                self.output_mode = (flags >> 1) & 0x3
                self.counter = 0
                self._emit(struct.pack(">HH", 0xFFFF, self.cookie))
            elif op == 0xA:  # RasterRegion: x count, y count
                x_count = struct.unpack(">H", cmd[3:5])[0]
                y_count = struct.unpack(">H", cmd[9:11])[0]
                self.region_count = x_count * y_count
            elif op == 0xC:  # RasterPixelRun
                length, dwell = struct.unpack(">HH", cmd[1:5])
                await self._pixels([dwell] * (length + 1), generation)
            elif op in (0xB, 0x9):
                await self._pixels([struct.unpack(">H", cmd[1:3])[0]], generation)
            elif op == 0xE:  # VectorPixel
                await self._pixels([struct.unpack(">H", cmd[5:7])[0]], generation)
            elif op == 0xF:
                await self._pixels([0], generation)
            elif op == 0x6:  # Delay
                await asyncio.sleep(struct.unpack(">H", cmd[1:3])[0] / 48e6 * self.time_scale)
            # Flush / Blank / BeamSelect / ExternalCtrl / Abort: no output

    async def _need_more(self) -> None:
        self._wake.clear()
        await self._wake.wait()


class FakeApplet:
    addr_reset = 0x10


class FakeStreamLauncherMixin:
    """Mixin for connection classes: connect to a FakeGlasgowInterface instead of USB."""

    fake_kwargs: dict = {}
    connect_cost_s: float = 0.0

    async def _connect(self):
        from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowStream
        assert not self.connected
        started = time.perf_counter()
        if self.connect_cost_s:
            await asyncio.sleep(self.connect_cost_s)
        iface = FakeGlasgowInterface(**self.fake_kwargs)
        self.fake_iface = iface
        self._stream = GlasgowStream(iface, self._config)
        self._synchronized = False
        if hasattr(self, "_applet"):
            self._applet = FakeApplet()
        stats = getattr(self, "stats", None)
        if stats is not None:
            stats.connects += 1
            stats.last_connect_s = time.perf_counter() - started


def emulated_service_cls():
    """DesktopDeviceService whose persistent connection talks to the emulator (``--emulator``)."""
    from ..engine.persistent import PersistentGlasgowConnection
    from ..engine.service import DesktopDeviceService

    class EmulatedPersistentConnection(FakeStreamLauncherMixin, PersistentGlasgowConnection):
        pass

    class EmulatedDesktopService(DesktopDeviceService):
        connection_cls = EmulatedPersistentConnection

    return EmulatedDesktopService
