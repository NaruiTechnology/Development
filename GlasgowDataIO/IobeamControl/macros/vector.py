"""VectorScanCommand — parameterized.

Previously module-level constants encoded the FPGA pipeline depth, the
drain safety factor, the sender drain timeout, and MAX_PIPELINE. Each was
documented as "re-validate this when the bitstream changes" but had no
runtime override hook — meaning a per-build change required editing this
file. They're now constructor parameters with the same defaults, so any
caller can override per-request (from the UI/REST) or per-deployment
(from streamData.json), without editing macro source.

JSON / API → VectorParams → VectorScanCommand is the new flow; see
AutomationPy.buildingblocks.scan_params for the dataclass.
"""

import asyncio
import struct

# Import path note: must match the prefix used by callers
# (GlasgowDataIO.IobeamControl.*) so isinstance checks line up across
# imports. macros/raster.py uses the un-prefixed `IobeamControl.*`
# because __init__.py uses the same; here we keep the prefixed form
# because it's what every existing caller of macros.vector uses.
from GlasgowDataIO.IobeamControl.commands import BaseCommand
from GlasgowDataIO.IobeamControl.commands.low_level_commands import (
    BlankCommand, FlushCommand, SynchronizeCommand, ArrayCommand,
    BeamSelectCommand, ExternalCtrlCommand,
)
from GlasgowDataIO.IobeamControl.commands.structs import OutputMode, CmdType, BeamType
from GlasgowDataIO.IobeamControl.commands import DACCodeRange


BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))


# Module-level defaults. Single source of truth lives in
# AutomationPy.buildingblocks.scan_params; these mirror that file so
# macros.vector stays importable without the AutomationPy dependency.
#
# Drain padding floor for vector transfers ----------------------------
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
DEFAULT_FPGA_PIPELINE_DEPTH_PIXELS = 14_000
DEFAULT_DRAIN_SAFETY_FACTOR        = 1.5

# How long to wait for the sender task to finish its drain padding +
# final flush after the receiver loop has returned. The sender is
# pumping ~21k pixel commands (~126 KB) into an OUT FIFO that drains
# at FPGA / FX2 speed; in practice this takes well under a second.
# A generous ceiling here just bounds the worst case where the FPGA
# pipeline genuinely stalls — at which point we'd rather surface a
# warning than hang the test forever.
DEFAULT_SENDER_DRAIN_TIMEOUT_S = 15.0

# Vector chunks are much larger than raster chunks (every pixel
# carries x/y/dwell triples), so MAX_PIPELINE has historically been
# tuned much lower for vector than the 32 used by raster. See the
# block comment inside transfer() below for the full story.
DEFAULT_MAX_PIPELINE = 4


def default_iter(resolution=2048):
    x_range = DACCodeRange.from_resolution(resolution)
    y_range = DACCodeRange.from_resolution(resolution)
    for x_idx in range(x_range.count):
        x = x_range.start + ((x_idx * x_range.step) >> 8)
        for y_idx in range(y_range.count):
            y = y_range.start + ((y_idx * y_range.step) >> 8)
            yield x, y, 1


def _normalize_point(point):
    if isinstance(point, tuple) or isinstance(point, list):
        if len(point) < 3:
            raise ValueError("vector point tuples must have at least 3 entries")
        blank = None if len(point) < 4 or point[3] is None else bool(point[3])
        return int(point[0]), int(point[1]), int(point[2]), blank

    x = getattr(point, "x", None)
    y = getattr(point, "y", None)
    dwell = getattr(point, "dwell", None)
    if x is None or y is None or dwell is None:
        raise ValueError("vector points must provide x, y, and dwell")
    blank = getattr(point, "blank", None)
    return int(x), int(y), int(dwell), None if blank is None else bool(blank)


class VectorScanCommand(BaseCommand):
    def __init__(
        self,
        cookie: int,
        output_mode: OutputMode = OutputMode.SixteenBit,
        beam_type: BeamType = BeamType.Ion,
        external_control: bool = True,
        iter_points=None,
        drain_floor_pixels=None,
        *,
        # --- pipeline tuning (overridable per-build via VectorParams) -----
        max_pipeline: int               = DEFAULT_MAX_PIPELINE,
        fpga_pipeline_depth_pixels: int = DEFAULT_FPGA_PIPELINE_DEPTH_PIXELS,
        drain_safety_factor: float      = DEFAULT_DRAIN_SAFETY_FACTOR,
        sender_drain_timeout_s: float   = DEFAULT_SENDER_DRAIN_TIMEOUT_S,
    ):
        """
        Args:
            cookie (int):
            output_mode (OutputMode, optional): Defaults to SixteenBit.
            iter_points (iterable, optional): (x, y, dwell) triples.
                Defaults to the full-DAC sweep at resolution=2048.
            drain_floor_pixels (int, optional): Explicit override for the
                drain padding floor. If None, derived from
                `fpga_pipeline_depth_pixels * drain_safety_factor`. Allows
                streamData.json to keep working unchanged.
            max_pipeline (int): Outstanding-chunks cap on the OUT path.
                Previously hardcoded at 4 (down from 32 inherited from
                raster). Surfaced so the right value can come from JSON
                without editing macro source.
            fpga_pipeline_depth_pixels (int): Empirically observed FPGA
                pipeline depth that drain padding must exceed.
            drain_safety_factor (float): Multiplier on the pipeline
                depth before the floor is applied.
            sender_drain_timeout_s (float): Bound on how long transfer()
                waits for the sender task to drain after the receiver
                loop ends, before logging a warning and cancelling.
        """
        # Avoid the mutable-default trap: Python evaluates defaults once
        # at class-definition time, so a second VectorScanCommand in the
        # same session would have received an already-exhausted generator
        # and pre-processed zero chunks. Evaluate per-call instead.
        if iter_points is None:
            iter_points = default_iter()

        self._iter_points = iter_points
        self._processed_points = []
        self._processed = False
        self._cookie = cookie
        self._output_mode = output_mode
        self._beam_type = beam_type
        self._external_control = bool(external_control)

        self._max_pipeline               = int(max_pipeline)
        self._fpga_pipeline_depth_pixels = int(fpga_pipeline_depth_pixels)
        self._drain_safety_factor        = float(drain_safety_factor)
        self._sender_drain_timeout_s     = float(sender_drain_timeout_s)

        # Resolve the drain floor: explicit override wins, otherwise
        # derive from FPGA pipeline depth × safety factor.
        if drain_floor_pixels is None:
            drain_floor_pixels = int(
                self._fpga_pipeline_depth_pixels * self._drain_safety_factor
            )
        self._drain_floor_pixels = int(drain_floor_pixels)

        self.abort = asyncio.Event()

    def __repr__(self):
        return (f"VectorScanCommand: cookie={self._cookie}, "
                f"output_mode={self._output_mode}, "
                f"beam_type={self._beam_type}, "
                f"external_control={self._external_control}, "
                f"max_pipeline={self._max_pipeline}, "
                f"drain_floor_pixels={self._drain_floor_pixels}")

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
            current_blank = None
            saw_explicit_blank = False

            def get_command(pixel_count):
                cmd = ArrayCommand(cmdtype=CmdType.VectorPixel,
                                   array_length=pixel_count - 1)
                return bytes(cmd)

            pixel_count = 0
            total_dwell = 0
            for point in self._iter_points:
                x, y, dwell, blank = _normalize_point(point)
                if blank is not None:
                    saw_explicit_blank = True
                    if current_blank is None or current_blank != blank:
                        commands.extend(bytes(BlankCommand(enable=blank, inline=True)))
                        current_blank = blank
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
                if saw_explicit_blank and current_blank is False:
                    commands.extend(bytes(BlankCommand(enable=True)))
                cmd = get_command(pixel_count)
                yield (memoryview(cmd + commands), pixel_count)

    @BaseCommand.log_transfer
    async def transfer(self, stream, *, latency: int = 65536 * 65536):
        self._logger.debug(
            f"transfer - {latency=} max_pipeline={self._max_pipeline} "
            f"drain_floor={self._drain_floor_pixels}"
        )

        # MAX_PIPELINE — historically 32 (inherited from raster); reduced
        # to 4 for vector because the per-chunk size is dramatically larger.
        # Raster's chunks are ~5 bytes each (RasterPixelRunCommand is
        # run-length-encoded), so 32 chunks × 5 bytes = ~160 bytes queued on
        # OUT before the first token release. Vector carries x/y/dwell
        # triples for every pixel, so at latency=8196 each chunk is ~49 KB
        # and at latency=65536 each is ~393 KB. max_pipeline=32 would put
        # 1.5 MB – 12 MB on the OUT path before any token returns, which
        # either stalls bulk_write (TimeoutError) or trips the demultiplexer
        # _out_buffer assertion. 4 keeps the in-flight window bounded while
        # still hiding USB round-trip latency.
        max_pipeline = self._max_pipeline

        tokens = max_pipeline
        token_fut = asyncio.Future()

        count_queue = asyncio.Queue()
        end_marker = object()

        async def sender():
            nonlocal tokens
            total_pixels = 0
            try:
                for commands, pixel_count in self._iter_chunks(latency):
                    self._logger.debug(f"sender: tokens={tokens}")
                    if tokens == 0:
                        await FlushCommand().transfer(stream)
                        await token_fut
                    if self.abort.is_set():
                        # go to a blanked state after an aborted frame
                        commands.extend(bytes(BlankCommand(enable=True,
                                                           inline=False)))
                    await stream.write(commands)
                    # Per-chunk host-side flush. Without this, stream.write()
                    # only appends to the demultiplexer _out_buffer and the
                    # data doesn't reach the device until something else
                    # flushes (a FlushCommand or an auto-flush threshold).
                    # The token-based pacing then loses sync with the actual
                    # device-visible state, freezing exactly at
                    # max_pipeline+1 chunks.
                    await stream.flush()
                    tokens -= 1
                    total_pixels += pixel_count
                    await count_queue.put(pixel_count)
                    if self.abort.is_set():
                        break
                    await asyncio.sleep(0)

                # ---------- pipeline-drain padding -----------------------------
                # Mirrors RasterScanCommand.sender's tail. After the last real
                # chunk the Supersampler → BusController →
                # PipelinedLoopbackAdapter still holds pixels of scan output;
                # they only get pushed out once more pixel commands flow in
                # behind them. Without this padding, the final recv_res on
                # the host blocks forever waiting for data physically stuck
                # in FPGA FIFOs.
                #
                # These padding pixels produce output too, but the receiver
                # loop stops before reading them — so they sit harmlessly in
                # the host _in_buffer until teardown.
                #
                # Padding size: floor (drain_floor_pixels) OR 0.5% of total
                # scan pixels, whichever is larger. The 0.5% term covers
                # very large scans where per-pixel buffering accumulates;
                # for small scans the floor wins.
                padding_pixels = max(
                    self._drain_floor_pixels, total_pixels // 200)
                self._logger.debug(
                    f"vector drain padding: {padding_pixels} px "
                    f"(floor={self._drain_floor_pixels}, "
                    f"scan_pixels={total_pixels}, "
                    f"ratio_term={total_pixels // 200})"
                )
                padding_body = bytearray()
                for _ in range(padding_pixels):
                    padding_body.extend(struct.pack(">HHH", 0, 0, 1))
                padding = (
                    bytes(ArrayCommand(cmdtype=CmdType.VectorPixel,
                                       array_length=padding_pixels - 1))
                    + bytes(padding_body)
                )
                await stream.write(padding)
                await stream.flush()

                await FlushCommand().transfer(stream)
            finally:
                await count_queue.put(end_marker)

        await BeamSelectCommand(beam_type=self._beam_type).transfer(stream)
        await ExternalCtrlCommand(enable=self._external_control).transfer(stream)
        await SynchronizeCommand(
            cookie=self._cookie, raster=False, output=self._output_mode,
        ).transfer(stream)
        sender_task = asyncio.create_task(sender())

        # Discard the FFFF + cookie reply.
        # TODO: assert against synchronization result
        cookie = await stream.read(4)
        try:
            while True:
                pixel_count = await count_queue.get()
                if pixel_count is end_marker:
                    break
                tokens += 1
                if tokens == 1:
                    token_fut.set_result(None)
                    token_fut = asyncio.Future()
                if tokens == max_pipeline + 1:
                    if self.abort.is_set():
                        break
                self._logger.debug(f"recver: tokens={tokens}")
                yield await self.recv_res(pixel_count, stream, self._output_mode)
        finally:
            # Wait for the sender to finish its drain padding + final
            # flush before this generator returns.
            #
            # The receiver's `for` loop exhausts as soon as the last real
            # chunk is read back, but the sender at that point is still
            # pumping ~drain_floor_pixels pixel commands and parked in
            # `await stream.flush()`. Without this wait, the caller's
            # `_post_transfer_cleanup` runs `_hard_close` which cancels
            # the demultiplexer's in-flight `bulk_write`, and the sender
            # task surfaces 10 s later as
            #     "Task exception was never retrieved: TimeoutError"
            # via asyncio's default exception handler. Awaiting here
            # lets the padding flush through cleanly while the USB
            # stack is still alive.
            #
            # The timeout bounds the worst case where the FPGA pipeline
            # genuinely stalls (e.g. IN FIFO not draining) — we'd rather
            # log + cancel than hang the test forever.
            if not sender_task.done():
                try:
                    await asyncio.wait_for(
                        sender_task, timeout=self._sender_drain_timeout_s)
                except asyncio.TimeoutError:
                    self._logger.warning(
                        f"sender task did not finish drain in "
                        f"{self._sender_drain_timeout_s:.0f}s; cancelled")
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
