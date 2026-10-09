"""Canonical RasterScanCommand.

Before this refactor there were two RasterScanCommand classes — one in
macros/__init__.py and one in macros/raster.py — with subtly different
sender behavior. macros/__init__.py had per-chunk `stream.flush()` and a
pipeline-drain padding tail; macros/raster.py had neither. Service code
and the raster unit test imported via `from macros import RasterScanCommand`
(the __init__.py one); frame_buffer imported via `from .raster` (the other
one). Bug fixes to one silently didn't apply to the other.

This file is now the single canonical definition. macros/__init__.py
re-exports it. The pipeline-drain padding tail of the previous __init__.py version is kept.
The per-chunk `stream.flush()` is NOT: the sender now batches RasterPixelRun
commands like upstream OBI and flushes only at pipeline boundaries
(FlushCommand when tokens run out) and at finalization, because a flush per
run put the USB round trip on the scan's critical path and could empty the
FPGA command FIFO (DAC plateau).

All values that used to be hardcoded in the sender — MAX_PIPELINE, the
padding floor / ratio, the padding pixel's dwell time — are now
constructor parameters. They keep their previous values as defaults, so
callers that pass nothing get exactly the previous behavior. Callers that
want to tune them (from streamData.json, from a debugging session) pass
explicit values via the RasterParams dataclass in
AutomationPy.buildingblocks.scan_params.
"""

import asyncio
import math
import struct
import time

# Import path: use the `GlasgowDataIO.IobeamControl.*` prefix consistently,
# matching what the service and the original macros/__init__.py used.
# Running under uvicorn, the working directory is the project root and
# only `GlasgowDataIO` is on sys.path as a top-level package — unprefixed
# `IobeamControl.*` imports fail with ModuleNotFoundError. Some legacy
# test scripts ran from inside `GlasgowDataIO/` where unprefixed imports
# also worked, which is presumably how the original raster.py got away
# with them.
from GlasgowDataIO.IobeamControl.commands import DwellTime, DACCodeRange, OutputMode, BeamType
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    BaseCommand, VectorPixelCommand, RasterRegionCommand,
    SynchronizeCommand, RasterPixelRunCommand, BlankCommand, FlushCommand,
    BeamSelectCommand, ExternalCtrlCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import u16
from GlasgowDataIO.IobeamControl.transfer.linkStats import LinkStats


BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))


# Module-level defaults. The single source of truth lives in
# AutomationPy.buildingblocks.scan_params; these mirror the values there
# so this module stays importable without that dependency for callers
# that just want the macro and pass everything explicitly.
DEFAULT_MAX_PIPELINE        = 32
DEFAULT_PADDING_MIN_PIXELS  = 128
DEFAULT_PADDING_RATIO_DENOM = 200    # padding = total_pixels // 200 (0.5%)
DEFAULT_PADDING_DWELL       = 2
DEFAULT_FRAME_BLANK         = False  # matches the API request default


class RasterScanCommand(BaseCommand):
    def __init__(
        self,
        x_range: DACCodeRange,
        y_range: DACCodeRange,
        dwell_time: DwellTime,
        cookie: u16,
        output_mode: OutputMode = OutputMode.SixteenBit,
        beam_type: BeamType = BeamType.Ion,
        external_control: bool = True,
        frame_blank: bool = DEFAULT_FRAME_BLANK,
        *,
        # --- pipeline tuning (overridable per-build via RasterParams) -----
        max_pipeline: int               = DEFAULT_MAX_PIPELINE,
        padding_min_pixels: int         = DEFAULT_PADDING_MIN_PIXELS,
        padding_ratio_denominator: int  = DEFAULT_PADDING_RATIO_DENOM,
        padding_dwell: int              = DEFAULT_PADDING_DWELL,
        # --- live scan --------------------------------------------------
        continuous: bool                = False,
    ):
        """
        Scan a frame and return data using a combination of
        :class:`RasterRegionCommand` and :class:`RasterPixelRunCommand`.

        Args:
            x_range (DACCodeRange):
            y_range (DACCodeRange):
            dwell_time (DwellTime):
            cookie (u16):
            output_mode (OutputMode, optional): Defaults to SixteenBit.
            frame_blank (bool, optional): Start and end frame in a blanked
                state. Default False — used to be True hardcoded, but the
                API and the unit test both expect False as the production
                default. The previous True default was masking the fact
                that nothing was passing this argument.
            max_pipeline (int): How many chunks may be in flight on the OUT
                endpoint before the sender blocks for a token. Previously
                hardcoded at 32; surfaced as a parameter because the right
                value depends on per-chunk size and FX2 FIFO depth, both
                of which can change with bitstream revisions.
            padding_min_pixels (int): Lower bound on the pipeline-drain
                pixel count appended after the last real chunk. The drain
                must exceed FPGA pipeline depth or the last few real
                samples never reach the host. Default 128.
            padding_ratio_denominator (int): Drain is at least
                total_pixels // padding_ratio_denominator pixels in
                addition to padding_min_pixels. Default 200 == 0.5%.
            padding_dwell (int): Dwell time used on the synthetic drain
                pixels. These pixels are read but discarded by the
                receiver, so the value only affects how long the drain
                takes — not the scan output. Default 2.
            continuous (bool): Live ("Infinite") scan. Instead of one frame,
                the command streams frame after frame over a single
                synchronized command stream until ``abort`` is set — the
                same idea as OBI's Acquire Photo / live scan, where the
                display is fed per chunk and never waits for a frame
                boundary. Each new frame is re-armed in-band by a
                ``RasterRegionCommand`` queued directly behind the previous
                frame's last ``RasterPixelRun``: the gateware RasterScanner
                returns to ``Get-ROI`` after the last pixel and accepts the
                queued region from its command FIFO, so XY keeps moving with
                no host round trip, no re-sync, no drain padding and no USB
                teardown between frames. Padding, fly-back and teardown run
                once, after Stop. Default False (single frame, unchanged).
        """
        self._x_range     = x_range
        self._y_range     = y_range
        self._dwell       = dwell_time
        self._cookie      = cookie
        self._output_mode = output_mode
        self._beam_type   = beam_type
        self._external_control = bool(external_control)
        self.frame_blank  = frame_blank

        self._max_pipeline              = int(max_pipeline)
        self._padding_min_pixels        = int(padding_min_pixels)
        self._padding_ratio_denominator = int(padding_ratio_denominator)
        self._padding_dwell             = int(padding_dwell)
        self.continuous                 = bool(continuous)

        self.abort = asyncio.Event()

    def __repr__(self):
        return (f"RasterScanCommand: x_range={self._x_range}, "
                f"y_range={self._y_range}, dwell={self._dwell}, "
                f"cookie={self._cookie}, output_mode={self._output_mode}, "
                f"beam_type={self._beam_type}, "
                f"external_control={self._external_control}, "
                f"frame_blank={self.frame_blank}, "
                f"max_pipeline={self._max_pipeline}, "
                f"continuous={self.continuous}")

    @property
    def frame_pixels(self) -> int:
        return self._x_range.count * self._y_range.count

    def frame_chunk_count(self, latency) -> int:
        """Number of chunks (receiver yields) that make up one frame."""
        return sum(1 for _ in self._iter_frame_chunks(latency, last_frame=False))

    def _iter_chunks(self, latency):
        """Chunks for the whole command: one frame, or frames forever.

        In continuous mode every frame after the first starts with an
        in-band ``RasterRegionCommand`` (the first frame's region is sent
        by ``transfer()`` together with the synchronize command). The
        generator is lazy, so the infinite loop costs nothing until it is
        consumed; sender and receiver both stop iterating after an abort.
        """
        if not self.continuous:
            yield from self._iter_frame_chunks(latency, last_frame=True)
            return

        region = bytes(RasterRegionCommand(
            x_range=self._x_range, y_range=self._y_range))
        first = True
        while True:
            for n, (commands, pixel_count) in enumerate(
                    self._iter_frame_chunks(latency, last_frame=False)):
                if n == 0 and not first:
                    commands[:0] = region
                yield (commands, pixel_count)
            first = False

    def _iter_frame_chunks(self, latency, *, last_frame: bool):
        commands = bytearray()

        def append_command(pixel_count):
            while pixel_count > 65536:
                cmd = RasterPixelRunCommand(dwell_time=self._dwell, length=65535)
                commands.extend(bytes(cmd))
                pixel_count -= 65536
            cmd = RasterPixelRunCommand(dwell_time=self._dwell, length=pixel_count - 1)
            commands.extend(bytes(cmd))

        # Chunk boundaries are computed arithmetically.  This used to be a
        # per-pixel Python loop, run once by the sender and once by the
        # receiver: for a 2048x2048 frame that is ~8 million iterations, and
        # one chunk at a short dwell is a several-hundred-thousand-iteration
        # slice that blocks the asyncio loop (and with it USB IN servicing)
        # for tens of ms - a stall that grows with resolution and shrinks
        # with dwell, i.e. exactly the settings-dependent plateau OBI does
        # not have.  The output is identical to the loop it replaces: a chunk
        # ends at the first pixel where the running dwell sum reaches
        # `latency`; with dwell 0 the sum never grows, so the frame is one
        # chunk (unless latency <= 0).
        total = self._x_range.count * self._y_range.count
        dwell = int(self._dwell)
        latency = int(latency)
        if dwell > 0:
            per_chunk = max(1, -(-latency // dwell))
        else:
            per_chunk = 1 if latency <= 0 else None

        done = 0
        if per_chunk is not None:
            while total - done >= per_chunk:
                done += per_chunk
                append_command(per_chunk)
                # blank at the end of the last pixel (never between live
                # frames: the beam stays on for the next frame, like OBI)
                if self.frame_blank and last_frame and done == total:
                    commands.extend(bytes(BlankCommand(enable=True, inline=False)))
                yield (commands, per_chunk)
                commands = bytearray()

        if total - done > 0:
            append_command(total - done)
            yield (commands, total - done)

    @BaseCommand.log_transfer
    async def transfer(self, stream, *, latency: int = 65536 * 65536):
        self._logger.debug(f"transfer - {latency=} max_pipeline={self._max_pipeline}")

        tokens = self._max_pipeline
        token_fut = asyncio.Future()
        total_pixels = self._x_range.count * self._y_range.count
        stats = LinkStats(
            "raster", dwell=self._dwell,
            beam_hz=getattr(self, "link_beam_hz", None),
            expected_chunks=None if self.continuous else math.ceil(
                total_pixels / max(1, math.ceil(latency / max(1, int(self._dwell))))))

        async def sender():
            nonlocal tokens
            for commands, pixel_count in self._iter_chunks(latency):
                self._logger.debug(f"sender: tokens={tokens}")
                flush_s = 0.0
                if tokens == 0:
                    # Pipeline boundary: push everything written so far to the
                    # device (FlushCommand also commits the IN FIFO tail),
                    # then wait for the receiver to return a token.
                    t_flush = time.perf_counter()
                    await FlushCommand().transfer(stream)
                    flush_s = time.perf_counter() - t_flush
                    await token_fut
                if self.frame_blank and self.abort.is_set():
                    # go to a blanked state after an aborted frame
                    commands.extend(bytes(BlankCommand(enable=True, inline=False)))
                # Batch like upstream OBI: write the RasterPixelRun and do NOT
                # flush USB per run.  Flushing (and waiting on) every run made
                # the host round-trip part of the scan's critical path, and any
                # hiccup emptied the FPGA command FIFO, parking the DAC at its
                # last value (a plateau on the scope).  Commands reach the
                # device when the demultiplexer's OUT threshold is crossed, at
                # the pipeline boundary above, and at finalization below.
                t_write = time.perf_counter()
                await stream.write(commands)
                stats.sent(flush_s + time.perf_counter() - t_write)
                tokens -= 1
                if self.abort.is_set():
                    break
                await asyncio.sleep(0)

            # ---------- pipeline-drain padding -----------------------------
            # After the last real chunk the FPGA's Supersampler →
            # BusController → PipelinedLoopbackAdapter still holds
            # ~padding_min_pixels of output that only reaches the host once
            # more input pushes them out. Without this tail the final
            # recv_res() blocks forever waiting for data that's physically
            # trapped in the device.
            #
            # The receive loop iterates _iter_chunks() and stops before
            # reading these padding pixels, so they sit harmlessly in the
            # host _in_buffer until teardown.
            ratio_term = (
                total_pixels // self._padding_ratio_denominator
                if self._padding_ratio_denominator > 0 else 0
            )
            padding_pixels = max(self._padding_min_pixels, ratio_term)
            self._logger.debug(
                f"raster drain padding: {padding_pixels} px "
                f"(min={self._padding_min_pixels}, "
                f"ratio_term={ratio_term})"
            )
            padding = bytearray()
            for _ in range(padding_pixels):
                padding.extend(bytes(VectorPixelCommand(
                    x_coord=self._x_range.start,
                    y_coord=self._y_range.start,
                    dwell_time=self._padding_dwell,
                )))
            await stream.write(padding)
            await stream.flush()

            await FlushCommand().transfer(stream)

        await BeamSelectCommand(beam_type=self._beam_type).transfer(stream)
        await ExternalCtrlCommand(enable=self._external_control).transfer(stream)
        # The gateware resets with the beam BLANKED (blank_enable init=1) and
        # nothing else unblanks it on this path, so without this command the
        # ion beam never turns on and the ADC only sees its zero level (flat
        # gray image).  Upstream OBI clients send exactly this before every
        # frame (frame_buffer.py / OBI client: BlankCommand(enable=False,
        # inline=True), opcode 0x52).  It takes effect with the first pixel.
        if self._beam_type != BeamType.NoBeam:
            await BlankCommand(enable=False, inline=True).transfer(stream)
        await SynchronizeCommand(
            cookie=self._cookie, raster=True, output=self._output_mode,
        ).transfer(stream)
        await RasterRegionCommand(
            x_range=self._x_range, y_range=self._y_range,
        ).transfer(stream)
        asyncio.create_task(sender())

        # Discard the FFFF + cookie reply.
        # TODO: assert against synchronization result
        cookie = await stream.read(4)
        outcome = "error"
        summary_logged = False

        def emit_summary(result):
            nonlocal summary_logged
            if not summary_logged:
                summary_logged = True
                self._logger.info(stats.summary(result))

        try:
            for commands, pixel_count in self._iter_chunks(latency):
                tokens += 1
                if tokens == 1:
                    token_fut.set_result(None)
                    token_fut = asyncio.Future()
                if tokens == self._max_pipeline + 1:
                    if self.abort.is_set():
                        outcome = "aborted"
                        break
                self._logger.debug(f"recver: tokens={tokens}")
                t_read = time.perf_counter()
                res = await self.recv_res(pixel_count, stream, self._output_mode)
                stats.received(time.perf_counter() - t_read, pixel_count)
                if not self.continuous and stats.pixels_recv >= total_pixels:
                    # Last chunk: log now.  The consumer normally stops
                    # iterating after it, so code after the final `yield`
                    # (including `finally`) may not run until GC/teardown.
                    emit_summary("ok")
                t_yield = time.perf_counter()
                yield res
                stats.consumed(time.perf_counter() - t_yield)
            else:
                outcome = "ok"
        except GeneratorExit:
            outcome = "closed"
            raise
        finally:
            emit_summary(outcome)
        # Fly back to origin. This is a single hidden pixel emitted to
        # move the DAC back to the scan's starting position after the
        # frame finishes; it isn't part of the captured scan data and
        # is discarded by the receive loop above. dwell_time=1 (the
        # shortest legal value) is intentional — there's no scan-quality
        # reason to dwell here, the only goal is to land at (start, start)
        # as quickly as possible. Not user-tunable.
        await VectorPixelCommand(
            x_coord=self._x_range.start, y_coord=self._y_range.start,
            dwell_time=1,
        ).transfer(stream)
