"""Persistent Glasgow session for the desktop app (the OBI connection model).

The web service's GlasgowConnection closes the USB device after *every*
transfer (``_post_transfer_cleanup`` -> ``_hard_close``). The next scan then
re-runs IobeamLauncher: Amaranth elaboration to compute the bitstream ID,
``download_target(reload=True)`` (which re-downloads the cached bitstream
even when the FPGA is already running it) and, because that reports the
image as freshly programmed, fixed sleeps of 3.0 + 1.2 + 0.5 s. That is
several seconds of dead time per frame.

Upstream OBI opens the device once and streams frame after frame. This
module does the same while keeping the property the teardown was protecting
(a clean command parser, FIFOs and host buffers at the start of each scan):

* connect once; program the FPGA only when the running bitstream ID differs
  (so the post-programming sleeps only happen when an image really was
  loaded, e.g. after an ADC-test image);
* between scans, ``iface.reset()`` cancels in-flight USB transfers, pulses
  the gateware reset, clears the host buffers and re-arms the IN endpoint -
  a few register writes instead of a full re-open - then the applet run
  gate is re-asserted and the next transfer re-synchronises with a fresh
  cookie;
* any failure during that soft reset falls back to the original hard close,
  so the next scan reconnects exactly as the web service would.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Optional

from GlasgowDataIO.IobeamControl.IobeamLauncher import IobeamLauncher
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.device import GlasgowDevice, ST_FPGA_RDY
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.target import GlasgowHardwareTarget
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.multiplexer import DirectMultiplexer
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.demultiplexer import DirectDemultiplexer
from GlasgowDataIO.IobeamControl.transfer.glasgowStream import (
    GlasgowConnection, GlasgowStream, log_power_good,
)


@dataclass
class SessionStats:
    connects: int = 0
    images_programmed: int = 0
    soft_resets: int = 0
    hard_closes: int = 0
    last_connect_s: float = 0.0
    last_reset_s: float = 0.0
    total_reset_s: float = 0.0
    history: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "connects": self.connects,
            "images_programmed": self.images_programmed,
            "soft_resets": self.soft_resets,
            "hard_closes": self.hard_closes,
            "last_connect_s": round(self.last_connect_s, 4),
            "last_reset_ms": round(self.last_reset_s * 1e3, 3),
            "mean_reset_ms": round(self.total_reset_s * 1e3 / self.soft_resets, 3) if self.soft_resets else None,
        }


class PersistentLauncher(IobeamLauncher):
    """IobeamLauncher that only (re)programs the FPGA when the image differs."""

    def __init__(self, config, *, force_reload: bool = False):
        super().__init__(config)
        self.force_reload = bool(force_reload)
        self.applet = None
        self.image_programmed = False

    async def _launch_applet(self, applet, applet_args, *, deviceId=None, prepare=None):
        # Same lifecycle as IobeamLauncher._launch_applet, except for the
        # reload policy: download_target(reload=False) compares the running
        # bitstream ID and skips the download (and the post-programming
        # settle sleeps below) when it already matches.
        self.applet = applet
        device = GlasgowDevice(deviceId)
        target = GlasgowHardwareTarget(revision=device.revision, multiplexer_cls=DirectMultiplexer)
        applet.build(target, applet_args)
        plan = target.build_plan()
        self._logger.info("desktop launcher: bitstream %s (force_reload=%s)",
                          plan.bitstream_id.hex(), self.force_reload)
        image_programmed = await device.download_target(plan, reload=self.force_reload)
        self.image_programmed = bool(image_programmed)
        self._logger.info("desktop launcher: %s bitstream %s",
                          "programmed" if image_programmed else "reusing running", plan.bitstream_id.hex())
        device.demultiplexer = DirectDemultiplexer(device, target.multiplexer.pipe_count)
        if image_programmed:
            await asyncio.sleep(3.0)
        status = await device._status()
        if not (status & ST_FPGA_RDY):
            device.close()
            raise RuntimeError(f"FPGA is not ready after bitstream download. Status register = {status:#04x}")
        if image_programmed:
            await asyncio.sleep(1.2)
        if prepare is not None:
            await prepare(device)
        iface = await device.demultiplexer.claim_interface(
            applet, applet.mux_interface, applet_args,
            read_buffer_size=applet_args.buffer_size,
            write_buffer_size=applet_args.buffer_size,
            pull_high=getattr(applet_args, "beam_pull_high", []),
        )
        return iface, image_programmed


class PersistentGlasgowConnection(GlasgowConnection):
    """GlasgowConnection that stays open between transfers."""

    #: Grace period for a macro's background sender to finish its drain
    #: padding after a normally completed scan.
    SENDER_GRACE_S = 2.0

    def __init__(self, config, *, force_reload: bool = False, stats: Optional[SessionStats] = None):
        super().__init__(config)
        self._force_reload = force_reload
        self.stats = stats or SessionStats()
        self._applet = None
        self._task_baseline: set = set()
        self._active_command = None

    async def transfer_multiple(self, command, **kwargs):
        # Remember which tasks existed before the macro ran: RasterScanCommand
        # spawns its sender with a bare asyncio.create_task() and never reaps
        # it. The web service's hard close killed it implicitly; a soft reset
        # has to do that explicitly (see _reap_macro_tasks).
        self._task_baseline = set(asyncio.all_tasks())
        self._active_command = command
        inner = super().transfer_multiple(command, **kwargs)
        try:
            async for value in inner:
                yield value
        finally:
            await inner.aclose()

    async def _reap_macro_tasks(self) -> None:
        current = asyncio.current_task()
        stray = [task for task in asyncio.all_tasks() - self._task_baseline
                 if task is not current and not task.done()
                 and "sender" in getattr(task.get_coro(), "__qualname__", "")]
        if not stray:
            return
        abort = getattr(self._active_command, "abort", None)
        if abort is None or not abort.is_set():
            await asyncio.wait(stray, timeout=self.SENDER_GRACE_S)
        for task in stray:
            if not task.done():
                task.cancel()
        await asyncio.gather(*stray, return_exceptions=True)

    async def _connect(self):
        assert not self.connected
        started = time.perf_counter()
        launcher = PersistentLauncher(self._config, force_reload=self._force_reload)
        iface = await launcher.start()
        if iface is None:
            raise ConnectionError("Launcher failed to start: Interface is None")
        self._applet = launcher.applet
        self._stream = GlasgowStream(iface, self._config)
        self._synchronized = False
        self.stats.connects += 1
        self.stats.images_programmed += int(launcher.image_programmed)
        self.stats.last_connect_s = time.perf_counter() - started
        await log_power_good(self._logger, iface.device, getattr(iface, "iobeam_power_good_addr", None), "connect")

    async def _post_transfer_cleanup(self):
        """Soft reset between scans; the USB session stays open."""
        if self._stream is None:
            return
        started = time.perf_counter()
        try:
            await self.soft_reset()
        except Exception as exc:  # anything odd: behave exactly like the web service
            self._logger.warning("desktop session: soft reset failed (%s: %s); closing USB", type(exc).__name__, exc)
            await self.hard_close()
            return
        elapsed = time.perf_counter() - started
        self.stats.soft_resets += 1
        self.stats.last_reset_s = elapsed
        self.stats.total_reset_s += elapsed

    async def soft_reset(self) -> None:
        await self._reap_macro_tasks()
        iface = self._stream.lower
        # cancel in-flight bulk transfers, assert the mux reset, clear host
        # buffers, re-arm the IN queue and release reset (demultiplexer._activate).
        await iface.reset()
        applet = self._applet
        device = iface.device
        if applet is not None:
            # Re-open the applet run gate (a target register, outside the
            # subtarget's ResetInserter) exactly as the launcher did.
            await device.write_register(applet.addr_reset, 1)
        # Next transfer must re-synchronise with a new cookie.
        self._synchronized = False

    async def hard_close(self) -> None:
        self.stats.hard_closes += 1
        try:
            await self._hard_close()
        finally:
            self._stream = None
            self._synchronized = False
