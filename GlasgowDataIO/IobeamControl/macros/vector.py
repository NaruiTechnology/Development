import asyncio
import struct
import array

# FIX (housekeeping A): import paths aligned with the rest of the project.
# Before:
#   from IobeamControl.commands import BaseCommand
#   from IobeamControl.commands.low_level_commands import ...
#   from IobeamControl.commands.structs import ...
# The rest of the project — test_vector.py, the raster macro, abc.py — all
# import via `GlasgowDataIO.IobeamControl.*`. With both paths resolvable
# Python can import the same module twice under two different names, which
# silently breaks isinstance checks and registry lookups.
from GlasgowDataIO.IobeamControl.commands import BaseCommand
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    BlankCommand, FlushCommand, SynchronizeCommand, ArrayCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode, CmdType


BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))


# Drain padding floor for vector transfers.
#
# Output for the last ~N pixels stays trapped in the
# Supersampler → BusController → PipelinedLoopbackAdapter chain until
# more input arrives behind it. The trailing padding written at the end
# of every vector transfer must exceed this depth, or the final
# recv_res calls block forever waiting for data that's physically
# stuck inside the FPGA.
#
# 14_000 was observed empirically on a 2048×2048 sweep where chunks
# 511–512 timed out with only 128 pad pixels. The 1.5× safety factor
# covers jitter / future buffer changes; the 0.5% term in transfer()
# is an additional margin for very large scans. Re-validate this
# constant whenever the bitstream changes — a regression here will
# look like vector-tail read timeouts.
_FPGA_PIPELINE_DEPTH_PIXELS = 14_000
_DRAIN_SAFETY_FACTOR        = 1.5
_DEFAULT_DRAIN_FLOOR_PIXELS = int(_FPGA_PIPELINE_DEPTH_PIXELS
                                  * _DRAIN_SAFETY_FACTOR)   # = 21_000

# How long to wait for the sender task to finish its drain padding +
# final flush after the receiver loop has returned. The sender is
# pumping ~21k pixel commands (~126 KB) into an OUT FIFO that drains
# at FPGA / FX2 speed; in practice this takes well under a second.
# A generous ceiling here just bounds the worst case where the FPGA
# pipeline genuinely stalls — at which point we'd rather surface a
# warning than hang the test forever.
_SENDER_DRAIN_TIMEOUT_S = 15.0


def default_iter():
    for x in range(2048):
        for y in range(2048):
            yield x, y, 1


class VectorScanCommand(BaseCommand):
    def __init__(self, cookie: int,
                 output_mode: OutputMode = OutputMode.SixteenBit,
                 iter_points=None,
                 drain_floor_pixels=None):
        # FIX (housekeeping B): mutable-default-argument trap.
        # Before: `iter_points=default_iter()` — Python evaluates defaults
        # once at class-definition time, so a second VectorScanCommand in
        # the same session got an already-exhausted generator and pre-
        # processed zero chunks. Evaluate the default per-call instead.
        if iter_points is None:
            iter_points = default_iter()
        # `drain_floor_pixels=None` falls back to the module default; pass
        # an explicit int (e.g. from streamData.json) to override per-build.
        if drain_floor_pixels is None:
            drain_floor_pixels = _DEFAULT_DRAIN_FLOOR_PIXELS
        self._iter_points = iter_points
        self._processed_points = []
        self._processed = False
        self._cookie = cookie
        self._output_mode = output_mode
        self._drain_floor_pixels = int(drain_floor_pixels)
        self.abort = asyncio.Event()

    def __repr__(self):
        return (f"VectorScanCommand: cookie={self._cookie}, "
                f"output_mode={self._output_mode}")

    def _pre_process_chunks(self, latency):
        print("Pre-processing commands...")
        for commands, pixel_count in self._iter_chunks(latency):
            self._processed_points.append((commands, pixel_count))
        self._processed = True
        print("Done processing")

    def _iter_chunks(self, latency):
        if self._processed:
            for commands, pixel_count in self._processed_points:
                yield commands, pixel_count
        else:
            commands = bytearray()

            def get_command(pixel_count):
                cmd = ArrayCommand(cmdtype=CmdType.VectorPixel,
                                   array_length=pixel_count - 1)
                return bytes(cmd)

            pixel_count = 0
            total_dwell = 0
            for (x, y, dwell) in self._iter_points:
                pixel_count += 1
                total_dwell += dwell
                commands.extend(struct.pack(">HHH", x, y, dwell))
                if total_dwell >= latency:
                    cmd = get_command(pixel_count)
                    yield (memoryview(cmd + commands), pixel_count)
                    commands = bytearray()
                    pixel_count = 0
                    total_dwell = 0
                if pixel_count == 65536:
                    cmd = get_command(pixel_count)
                    yield (memoryview(cmd + commands), pixel_count)
                    commands = bytearray()
                    pixel_count = 0
                    total_dwell = 0

            if pixel_count > 0:
                cmd = get_command(pixel_count)
                yield (memoryview(cmd + commands), pixel_count)

    @BaseCommand.log_transfer
    async def transfer(self, stream, *, latency: int = 65536 * 65536):
        self._logger.debug(f"transfer - {latency=}")

        # FIX 1: MAX_PIPELINE reduced 32 → 4.
        # Raster's chunks are ~5 bytes each (RasterPixelRunCommand is
        # run-length-encoded), so 32 chunks × 5 bytes = ~160 bytes queued on
        # OUT before the first token release. Vector carries x/y/dwell
        # triples for every pixel, so at latency=8196 each chunk is ~49 KB
        # and at latency=65536 each is ~393 KB. MAX_PIPELINE=32 inherited
        # from raster puts 1.5 MB – 12 MB on the OUT path before any token
        # returns, which either stalls bulk_write (TimeoutError) or trips
        # the demultiplexer _out_buffer assertion. 4 keeps the in-flight
        # window bounded while still hiding USB round-trip latency.
        MAX_PIPELINE = 4

        tokens = MAX_PIPELINE
        token_fut = asyncio.Future()

        async def sender():
            nonlocal tokens
            for commands, pixel_count in self._iter_chunks(latency):
                self._logger.debug(f"sender: tokens={tokens}")
                if tokens == 0:
                    await FlushCommand().transfer(stream)
                    await token_fut
                if self.abort.is_set():
                    ## go to a blanked state after an aborted frame
                    commands.extend(bytes(BlankCommand(enable=True,
                                                       inline=False)))
                await stream.write(commands)
                # FIX 2: per-chunk host-side flush, matching
                # RasterScanCommand.sender. Without this, stream.write()
                # only appends to the demultiplexer _out_buffer and the
                # data doesn't reach the device until something else
                # flushes (a FlushCommand or an auto-flush threshold).
                # The token-based pacing then loses sync with the actual
                # device-visible state, which is why the previous run
                # froze at exactly MAX_PIPELINE+1 = 33 chunks.
                await stream.flush()
                tokens -= 1
                if self.abort.is_set():
                    break
                await asyncio.sleep(0)

            # FIX 3: pipeline-drain padding, mirroring
            # RasterScanCommand.sender's tail. After the last real chunk
            # the Supersampler → BusController → PipelinedLoopbackAdapter
            # still holds pixels of scan output; they only get pushed out
            # once more pixel commands flow in behind them. Without this
            # padding, the final recv_res on the host blocks forever
            # waiting for data that's physically stuck in FPGA FIFOs.
            # These padding pixels produce output too, but the receiver
            # loop iterates self._processed_points and stops before
            # reading them — so they sit harmlessly in the host
            # _in_buffer until teardown.
            #
            # Padding size uses raster's empirical 0.5% rule. A fixed
            # floor of 128 was too small: on the 2048×2048 run it only
            # drained 128 pixels, leaving chunks 511–512 (~14k pixels)
            # trapped and timing out the final reads. Scaling with total
            # scan size matches how raster sizes the drain for a 512×512
            # frame (1310 pixels) and puts us at ~21k padding for a
            # 2048×2048 vector scan, which covers the observed tail.
            if self._processed:
                total_pixels = sum(pc for _, pc in self._processed_points)
            else:
                total_pixels = 0
            # The floor must exceed FPGA pipeline depth (see module-level
            # comment near _FPGA_PIPELINE_DEPTH_PIXELS). The 0.5% term is
            # a safety margin for very large scans where any per-pixel
            # buffering accumulates; for small scans the floor wins.
            PADDING_PIXELS = max(self._drain_floor_pixels,
                                 total_pixels // 200)
            self._logger.debug(
                f"drain padding: {PADDING_PIXELS} px "
                f"(floor={self._drain_floor_pixels}, "
                f"scan_pixels={total_pixels}, "
                f"ratio_term={total_pixels // 200})"
            )
            padding_body = bytearray()
            for _ in range(PADDING_PIXELS):
                padding_body.extend(struct.pack(">HHH", 0, 0, 1))
            padding = (
                bytes(ArrayCommand(cmdtype=CmdType.VectorPixel,
                                   array_length=PADDING_PIXELS - 1))
                + bytes(padding_body)
            )
            await stream.write(padding)
            await stream.flush()

            await FlushCommand().transfer(stream)

        await SynchronizeCommand(
            cookie=self._cookie, raster=False, output=self._output_mode,
        ).transfer(stream)
        sender_task = asyncio.create_task(sender())

        cookie = await stream.read(4)  # just assume these are exactly FFFF + cookie, and discard them
        ## TODO: assert against synchronization result
        try:
            for commands, pixel_count in self._iter_chunks(latency):
                tokens += 1
                if tokens == 1:
                    token_fut.set_result(None)
                    token_fut = asyncio.Future()
                if tokens == MAX_PIPELINE + 1:
                    if self.abort.is_set():
                        break
                self._logger.debug(f"recver: tokens={tokens}")
                yield await self.recv_res(pixel_count, stream, self._output_mode)
        finally:
            # FIX 4: wait for the sender to finish its drain padding +
            # final flush before this generator returns.
            #
            # The receiver's `for` loop exhausts as soon as the last real
            # chunk is read back, but the sender at that point is still
            # pumping ~21k pixel commands (the drain padding) and parked
            # in `await stream.flush()`. Without this wait, the caller's
            # `_post_transfer_cleanup` runs `_hard_close` which cancels
            # the demultiplexer's in-flight `bulk_write`, and the sender
            # task surfaces 10s later as
            #     "Task exception was never retrieved: TimeoutError"
            # via asyncio's default exception handler. Awaiting here
            # lets the padding flush through cleanly while the USB
            # stack is still alive.
            #
            # A timeout bounds the worst case where the FPGA pipeline
            # genuinely stalls (e.g. IN FIFO not draining) — we'd
            # rather log + cancel than hang the test forever.
            if not sender_task.done():
                try:
                    await asyncio.wait_for(
                        sender_task, timeout=_SENDER_DRAIN_TIMEOUT_S)
                except asyncio.TimeoutError:
                    self._logger.warning(
                        f"sender task did not finish drain in "
                        f"{_SENDER_DRAIN_TIMEOUT_S:.0f}s; cancelled")
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Sender raised something else (e.g. a real USB
                    # error). Log it but don't re-raise — the receiver
                    # already delivered its chunks to the caller and
                    # masking the sender's exception with a re-raise
                    # here would lose those chunks.
                    self._logger.exception(
                        "sender task raised during transfer cleanup")
