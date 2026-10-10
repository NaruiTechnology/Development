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

import array
import asyncio
import struct
import time
from dataclasses import dataclass

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
from GlasgowDataIO.IobeamControl.transfer.linkStats import LinkStats


BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))


# The gateware sends SixteenBit samples the way OBI does: the 14-bit ADC code
# left-aligned in 16 bits (code << 2, full scale 0xFFFC). The adaptive-gray
# thresholds below stay in 14-bit units (they are built from the UI's 8-bit gray
# window), so received samples are converted back before they are compared.
OBI_SAMPLE_SHIFT = 2


@dataclass(frozen=True)
class AdaptiveGrayFeedbackConfig:
    """Thresholds are raw 14-bit ADC codes (0..0x3FFF), not OBI-aligned samples."""

    gray_min: int
    gray_max: int
    blank_when_inside: bool
    window_points: int = 1
    pipeline_delay_points: int = 0

    def __post_init__(self):
        lo = max(0, min(0x3FFF, int(self.gray_min)))
        hi = max(0, min(0x3FFF, int(self.gray_max)))
        object.__setattr__(self, "gray_min", min(lo, hi))
        object.__setattr__(self, "gray_max", max(lo, hi))
        object.__setattr__(self, "window_points", max(1, int(self.window_points)))
        object.__setattr__(self, "pipeline_delay_points", max(0, int(self.pipeline_delay_points)))


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
        pass_index = None if len(point) < 5 or point[4] is None else int(point[4])
        return int(point[0]), int(point[1]), int(point[2]), blank, pass_index

    x = getattr(point, "x", None)
    y = getattr(point, "y", None)
    dwell = getattr(point, "dwell", None)
    if x is None or y is None or dwell is None:
        raise ValueError("vector points must provide x, y, and dwell")
    blank = getattr(point, "blank", None)
    pass_index = getattr(point, "passIndex", None)
    return (
        int(x),
        int(y),
        int(dwell),
        None if blank is None else bool(blank),
        None if pass_index is None else int(pass_index),
    )


class VectorScanCommand(BaseCommand):
    def __init__(
        self,
        cookie: int,
        output_mode: OutputMode = OutputMode.SixteenBit,
        beam_type: BeamType = BeamType.Ion,
        external_control: bool = True,
        iter_points=None,
        drain_floor_pixels=None,
        adaptive_gray_feedback: AdaptiveGrayFeedbackConfig | None = None,
        *,
        # --- pipeline tuning (overridable per-build via VectorParams) -----
        max_pipeline: int               = DEFAULT_MAX_PIPELINE,
        fpga_pipeline_depth_pixels: int = DEFAULT_FPGA_PIPELINE_DEPTH_PIXELS,
        drain_safety_factor: float      = DEFAULT_DRAIN_SAFETY_FACTOR,
        sender_drain_timeout_s: float   = DEFAULT_SENDER_DRAIN_TIMEOUT_S,
        # --- live scan --------------------------------------------------
        continuous: bool                = False,
        points_factory=None,
        frame_blank: bool = True,
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
            continuous (bool): Live ("Infinite") scan, the vector
                counterpart of OBI's live scan. The point list is replayed
                pass after pass on ONE synchronized command stream until
                ``abort`` is set: no re-sync, no drain padding and no USB
                teardown between passes, so the beam never parks and the
                host receives samples without a gap. Padding and teardown
                run once, after Stop. Not available with adaptive gray
                feedback (each pass there depends on host decisions).
            points_factory (callable, optional): Returns a fresh iterable of
                points for each pass in continuous mode. When omitted,
                ``iter_points`` is materialized once and replayed.
        """
        # Avoid the mutable-default trap: Python evaluates defaults once
        # at class-definition time, so a second VectorScanCommand in the
        # same session would have received an already-exhausted generator
        # and pre-processed zero chunks. Evaluate per-call instead.
        if iter_points is None:
            iter_points = default_iter()

        self.frame_blank = bool(frame_blank)
        self._adaptive_gray_feedback = adaptive_gray_feedback
        self.continuous = bool(continuous) and adaptive_gray_feedback is None
        if self.continuous and points_factory is None:
            replay = list(iter_points)
            points_factory = lambda: iter(replay)
        self._points_factory = points_factory if self.continuous else None
        if self._points_factory is not None:
            iter_points = self._points_factory()
        self._iter_points = iter_points
        self._processed_points = []
        self._processed_adaptive_points = None
        self._processed = False
        self._cookie = cookie
        self._output_mode = (
            OutputMode.SixteenBit
            if self._adaptive_gray_feedback is not None
            else output_mode
        )
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
                f"adaptive_gray_feedback={self._adaptive_gray_feedback}, "
                f"max_pipeline={self._max_pipeline}, "
                f"drain_floor_pixels={self._drain_floor_pixels}, "
                f"continuous={self.continuous}")

    def _pre_process_chunks(self, latency):
        if self.continuous:
            # An endless pass stream cannot be materialized up front.
            return
        print("Pre-processing commands...")
        if self._adaptive_gray_feedback is not None:
            self._processed_adaptive_points = [
                _normalize_point(point) for point in self._iter_points
            ]
            self._processed = True
            print("Done processing")
            return
        for commands, pixel_count in self._iter_chunks(latency):
            self._processed_points.append((commands, pixel_count))
        self._processed = True
        print("Done processing")

    def _iter_adaptive_points(self):
        if self._processed and self._processed_adaptive_points is not None:
            yield from self._processed_adaptive_points
            return
        for point in self._iter_points:
            yield _normalize_point(point)

    @staticmethod
    def _feedback_sample_value(samples) -> int:
        if samples is None or len(samples) == 0:
            return 0
        # SixteenBit samples arrive OBI-aligned (code << 2); the thresholds are 14-bit.
        return int(sum(int(sample) for sample in samples) / len(samples)) >> OBI_SAMPLE_SHIFT

    def _feedback_blank_decision(self, samples) -> bool:
        cfg = self._adaptive_gray_feedback
        assert cfg is not None
        sample_value = self._feedback_sample_value(samples)
        in_range = cfg.gray_min <= sample_value <= cfg.gray_max
        return in_range if cfg.blank_when_inside else not in_range

    @staticmethod
    def _feedback_combine_samples(probe_samples, action_samples, *, probe_dwell: int, action_dwell: int):
        if probe_samples is None:
            return action_samples
        if action_samples is None or len(action_samples) == 0 or action_dwell <= 0:
            return probe_samples

        total_dwell = max(1, int(probe_dwell) + int(action_dwell))
        combined = array.array(action_samples.typecode)
        for idx, action_value in enumerate(action_samples):
            probe_value = int(probe_samples[idx]) if idx < len(probe_samples) else 0
            weighted = ((probe_value * probe_dwell) + (int(action_value) * action_dwell)) / total_dwell
            combined.append(int(round(weighted)))
        return combined

    async def _transfer_adaptive(self, stream):
        cfg = self._adaptive_gray_feedback
        assert cfg is not None

        await BeamSelectCommand(beam_type=self._beam_type).transfer(stream)
        await ExternalCtrlCommand(enable=self._external_control).transfer(stream)
        await SynchronizeCommand(
            cookie=self._cookie, raster=False, output=OutputMode.SixteenBit,
        ).transfer(stream)

        # Discard the FFFF + cookie reply.
        await stream.read(4)

        points_iter = self._iter_adaptive_points()

        # Same-coordinate adaptive mode:
        #   1. Probe each logical point with a single unblanked sample.
        #   2. Decide blank/unblank from that probe sample.
        #   3. Revisit the same coordinate for the remaining dwell with the
        #      chosen blank state.
        #
        # This is still not a true in-dwell closed loop, but it keeps the
        # feedback actuation on the same physical coordinate instead of a
        # later point in the sweep.
        while True:
            try:
                x, y, dwell, _blank, pass_index = next(points_iter)
            except StopIteration:
                break

            if pass_index is not None:
                self._logger.debug("adaptive vector pass index %s", pass_index)

            logical_dwell = max(1, int(dwell))
            probe_dwell = 1
            action_dwell = max(0, logical_dwell - probe_dwell)

            probe_commands = bytearray()
            probe_commands.extend(bytes(BlankCommand(enable=False, inline=True)))
            probe_commands.extend(bytes(ArrayCommand(
                cmdtype=CmdType.VectorPixel,
                array_length=0,
            )))
            probe_commands.extend(struct.pack(">HHH", x, y, probe_dwell))
            if self.abort.is_set():
                probe_commands.extend(bytes(BlankCommand(enable=True, inline=False)))
            await stream.write(probe_commands)
            await stream.flush()
            await FlushCommand().transfer(stream)
            probe_samples = await self.recv_res(1, stream, OutputMode.SixteenBit)
            blank_state = self._feedback_blank_decision(probe_samples)

            if self.abort.is_set():
                # Keep the probe value in the returned image.  The action
                # sample is intentionally blank, but the UI needs the probe
                # gray level to identify and mark this filtered point red.
                yield probe_samples
                break

            action_samples = None
            if action_dwell > 0:
                action_commands = bytearray()
                action_commands.extend(bytes(BlankCommand(enable=blank_state, inline=True)))
                action_commands.extend(bytes(ArrayCommand(
                    cmdtype=CmdType.VectorPixel,
                    array_length=0,
                )))
                action_commands.extend(struct.pack(">HHH", x, y, action_dwell))
                if self.abort.is_set():
                    action_commands.extend(bytes(BlankCommand(enable=True, inline=False)))
                await stream.write(action_commands)
                await stream.flush()
                await FlushCommand().transfer(stream)
                action_samples = await self.recv_res(1, stream, OutputMode.SixteenBit)

            if blank_state:
                # Return the unblanked probe reading rather than a synthetic
                # zero.  A zero loses the source gray level and makes the
                # filtered column render black instead of the ROI red spot.
                yield probe_samples if probe_samples is not None else action_samples
            else:
                yield self._feedback_combine_samples(
                    probe_samples,
                    action_samples,
                    probe_dwell=probe_dwell,
                    action_dwell=action_dwell,
                )

        await BlankCommand(enable=True, inline=False).transfer(stream)
        await FlushCommand().transfer(stream)

    def _iter_passes(self):
        """Point iterables to scan: one pass, or (continuous) passes forever."""
        if not self.continuous:
            yield self._iter_points
            return
        yield self._iter_points          # first pass (already created)
        while True:
            yield self._points_factory()

    def _iter_chunks(self, latency):
        if self._processed:
            for commands, pixel_count in self._processed_points:
                yield commands, pixel_count
            return

        commands = bytearray()
        vector_body = bytearray()
        current_blank = None
        saw_explicit_blank = False
        current_pass_index = None

        def get_command(pixel_count):
            cmd = ArrayCommand(cmdtype=CmdType.VectorPixel,
                               array_length=pixel_count - 1)
            return bytes(cmd)

        def flush_vector_body():
            nonlocal vector_body, vector_body_count
            if vector_body_count > 0:
                commands.extend(get_command(vector_body_count))
                commands.extend(vector_body)
                vector_body = bytearray()
                vector_body_count = 0

        chunk_pixel_count = 0
        vector_body_count = 0
        total_dwell = 0
        for points in self._iter_passes():
            for point in points:
                x, y, dwell, blank, pass_index = _normalize_point(point)
                if pass_index is not None and current_pass_index != pass_index:
                    self._logger.debug("vector pass index %s", pass_index)
                    current_pass_index = pass_index
                if blank is not None:
                    saw_explicit_blank = True
                    if current_blank is None or current_blank != blank:
                        flush_vector_body()
                        commands.extend(bytes(BlankCommand(enable=blank, inline=True)))
                        current_blank = blank
                chunk_pixel_count += 1
                vector_body_count += 1
                total_dwell += dwell
                vector_body.extend(struct.pack(">HHH", x, y, dwell))
                if total_dwell >= latency:
                    flush_vector_body()
                    yield (memoryview(commands), chunk_pixel_count)
                    commands = bytearray()
                    chunk_pixel_count = 0
                    total_dwell = 0
                if chunk_pixel_count == 65536:
                    flush_vector_body()
                    yield (memoryview(commands), chunk_pixel_count)
                    commands = bytearray()
                    chunk_pixel_count = 0
                    total_dwell = 0

            if self.continuous and chunk_pixel_count > 0:
                # End every live pass on a chunk boundary (the next pass's
                # first point follows in the same command stream; the beam
                # is NOT blanked between passes, like OBI's live scan).
                flush_vector_body()
                yield (memoryview(commands), chunk_pixel_count)
                commands = bytearray()
                chunk_pixel_count = 0
                total_dwell = 0

        if chunk_pixel_count > 0:
            flush_vector_body()
            if saw_explicit_blank and current_blank is False:
                commands.extend(bytes(BlankCommand(enable=True)))
            yield (memoryview(commands), chunk_pixel_count)

    @BaseCommand.log_transfer
    async def transfer(self, stream, *, latency: int = 65536 * 65536):
        if self._adaptive_gray_feedback is not None:
            async for chunk in self._transfer_adaptive(stream):
                yield chunk
            return

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
        # Per-point dwell can vary; the service sets link_dwell to the nominal
        # dwell so the summary can estimate beam time (None -> timings only).
        stats = LinkStats("vector", dwell=getattr(self, "link_dwell", None),
                          beam_hz=getattr(self, "link_beam_hz", None))
        outcome = "error"
        summary_logged = False
        sent_total = None      # set by the sender after the last real chunk

        def emit_summary(result):
            nonlocal summary_logged
            if not summary_logged:
                summary_logged = True
                self._logger.info(stats.summary(result))

        async def sender():
            nonlocal tokens, sent_total
            total_pixels = 0
            between_frames = False
            try:
                for commands, pixel_count in self._iter_chunks(latency):
                    self._logger.debug(f"sender: tokens={tokens}")
                    if tokens == 0:
                        await FlushCommand().transfer(stream)
                        await token_fut
                    if self.abort.is_set():
                        # go to a blanked state after an aborted frame
                        # (_iter_chunks yields memoryviews, which cannot be
                        # extended in place)
                        commands = bytes(commands) + bytes(BlankCommand(
                            enable=True, inline=False))
                    if between_frames:
                        await BlankCommand(enable=False, inline=True).transfer(stream)
                        between_frames = False
                    await stream.write(commands)
                    # Per-chunk host-side flush. Without this, stream.write()
                    # only appends to the demultiplexer _out_buffer and the
                    # data doesn't reach the device until something else
                    # flushes (a FlushCommand or an auto-flush threshold).
                    # The token-based pacing then loses sync with the actual
                    # device-visible state, freezing exactly at
                    # max_pipeline+1 chunks.
                    t_flush = time.perf_counter()
                    await stream.flush()
                    stats.sent(time.perf_counter() - t_flush)
                    tokens -= 1
                    total_pixels += pixel_count
                    pass_pixels = getattr(self, "pass_pixels", 0)
                    if self.frame_blank and self.continuous and pass_pixels and total_pixels % pass_pixels == 0:
                        await BlankCommand(enable=True, inline=False).transfer(stream)
                        between_frames = True
                    await count_queue.put(pixel_count)
                    if self.abort.is_set():
                        break
                    await asyncio.sleep(0)

                if self.frame_blank:
                    await BlankCommand(enable=True, inline=False).transfer(stream)

                sent_total = total_pixels

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
        # The gateware resets with the beam BLANKED (blank_enable init=1).
        # Points without an explicit blank flag (the default ROI sweeps) never
        # send a BlankCommand, so without this the ion beam stays off and the
        # ADC only sees its zero level.  OBI clients send this before every
        # frame (opcode 0x52).  Points that carry explicit blank flags still
        # override it inline from the first point on.
        if self._beam_type != BeamType.NoBeam:
            await BlankCommand(enable=False, inline=True).transfer(stream)
        await SynchronizeCommand(
            cookie=self._cookie, raster=False, output=self._output_mode,
        ).transfer(stream)
        sender_task = asyncio.create_task(sender())
        receiver_complete = False

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
                        outcome = "aborted"
                        break
                self._logger.debug(f"recver: tokens={tokens}")
                t_read = time.perf_counter()
                res = await self.recv_res(pixel_count, stream, self._output_mode)
                stats.received(time.perf_counter() - t_read, pixel_count)
                if sent_total is not None and stats.pixels_recv >= sent_total:
                    # Last chunk: log now; the consumer normally stops after
                    # it, so `finally` may not run until GC/teardown.
                    emit_summary("ok")
                t_yield = time.perf_counter()
                yield res
                stats.consumed(time.perf_counter() - t_yield)
            receiver_complete = True
            if outcome != "aborted":
                outcome = "ok"
        except GeneratorExit:
            outcome = "closed"
            raise
        finally:
            emit_summary(outcome)
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
            if not receiver_complete:
                # The consumer stopped before the frame completed (for
                # example, a WebSocket Stop/close). The sender can be parked
                # on token_fut waiting for receiver pacing that will never
                # resume, so cancel and reap it before USB teardown.
                sender_task.cancel()
                await asyncio.gather(sender_task, return_exceptions=True)
            else:
                try:
                    await asyncio.wait_for(
                        asyncio.shield(sender_task),
                        timeout=self._sender_drain_timeout_s,
                    )
                except asyncio.TimeoutError:
                    sender_task.cancel()
                    await asyncio.gather(sender_task, return_exceptions=True)
                    self._logger.warning(
                        f"sender task did not finish drain in "
                        f"{self._sender_drain_timeout_s:.0f}s; cancelled")
                except asyncio.CancelledError:
                    sender_task.cancel()
                    await asyncio.gather(sender_task, return_exceptions=True)
                    raise
                except Exception:
                    # Sender raised something else (e.g. a real USB
                    # error). Log it but don't re-raise — the receiver
                    # already delivered its chunks to the caller and
                    # masking the sender's exception with a re-raise
                    # here would lose those chunks.
                    self._logger.exception(
                        "sender task raised during transfer cleanup")
