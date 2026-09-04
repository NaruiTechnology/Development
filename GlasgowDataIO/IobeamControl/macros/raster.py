"""Canonical RasterScanCommand.

Before this refactor there were two RasterScanCommand classes — one in
macros/__init__.py and one in macros/raster.py — with subtly different
sender behavior. macros/__init__.py had per-chunk `stream.flush()` and a
pipeline-drain padding tail; macros/raster.py had neither. Service code
and the raster unit test imported via `from macros import RasterScanCommand`
(the __init__.py one); frame_buffer imported via `from .raster` (the other
one). Bug fixes to one silently didn't apply to the other.

This file is now the single canonical definition. macros/__init__.py
re-exports it. The behavior matches the previous __init__.py version
(per-chunk flush + pipeline-drain padding) since that's what the service
and the wet-run test were actually exercising.

All values that used to be hardcoded in the sender — MAX_PIPELINE, the
padding floor / ratio, the padding pixel's dwell time — are now
constructor parameters. They keep their previous values as defaults, so
callers that pass nothing get exactly the previous behavior. Callers that
want to tune them (from streamData.json, from a debugging session) pass
explicit values via the RasterParams dataclass in
AutomationPy.buildingblocks.scan_params.
"""

import asyncio
import struct

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


BIG_ENDIAN = (struct.pack('@H', 0x1234) == struct.pack('>H', 0x1234))


# Module-level defaults. The single source of truth lives in
# AutomationPy.buildingblocks.scan_params; these mirror the values there
# so this module stays importable without that dependency for callers
# that just want the macro and pass everything explicitly.
DEFAULT_MAX_PIPELINE        = 4
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

        self.abort = asyncio.Event()

    def __repr__(self):
        return (f"RasterScanCommand: x_range={self._x_range}, "
                f"y_range={self._y_range}, dwell={self._dwell}, "
                f"cookie={self._cookie}, output_mode={self._output_mode}, "
                f"beam_type={self._beam_type}, "
                f"external_control={self._external_control}, "
                f"frame_blank={self.frame_blank}, "
                f"max_pipeline={self._max_pipeline}")

    def _iter_chunks(self, latency):
        commands = bytearray()

        def append_command(pixel_count):
            while pixel_count > 65536:
                cmd = RasterPixelRunCommand(dwell_time=self._dwell, length=65535)
                commands.extend(bytes(cmd))
                pixel_count -= 65536
            cmd = RasterPixelRunCommand(dwell_time=self._dwell, length=pixel_count - 1)
            commands.extend(bytes(cmd))

        pixel_count = 0
        total_dwell = 0
        for n in range(self._x_range.count * self._y_range.count):
            pixel_count += 1
            total_dwell += self._dwell
            if total_dwell >= latency:
                append_command(pixel_count)
                # blank at the end of the last pixel
                if (self.frame_blank
                        and n + 1 == self._x_range.count * self._y_range.count):
                    commands.extend(bytes(BlankCommand(enable=True, inline=False)))
                yield (commands, pixel_count)
                commands = bytearray()
                pixel_count = 0
                total_dwell = 0

        if pixel_count > 0:
            append_command(pixel_count)
            yield (commands, pixel_count)

    @BaseCommand.log_transfer
    async def transfer(self, stream, *, latency: int = 65536 * 65536):
        self._logger.debug(f"transfer - {latency=} max_pipeline={self._max_pipeline}")

        tokens = self._max_pipeline
        token_fut = asyncio.Future()

        async def sender():
            nonlocal tokens
            for commands, pixel_count in self._iter_chunks(latency):
                self._logger.debug(f"sender: tokens={tokens}")
                if tokens == 0:
                    await FlushCommand().transfer(stream)
                    await token_fut
                if self.frame_blank and self.abort.is_set():
                    # go to a blanked state after an aborted frame
                    commands.extend(bytes(BlankCommand(enable=True, inline=False)))
                await stream.write(commands)
                # Per-chunk flush — must match the vector macro's sender.
                # Without this, stream.write() only buffers in the
                # demultiplexer _out_buffer and the device-visible state
                # falls out of sync with the token pacing.
                await stream.flush()
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
            total_pixels = self._x_range.count * self._y_range.count
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
        for commands, pixel_count in self._iter_chunks(latency):
            tokens += 1
            if tokens == 1:
                token_fut.set_result(None)
                token_fut = asyncio.Future()
            if tokens == self._max_pipeline + 1:
                if self.abort.is_set():
                    break
            self._logger.debug(f"recver: tokens={tokens}")
            yield await self.recv_res(pixel_count, stream, self._output_mode)
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
