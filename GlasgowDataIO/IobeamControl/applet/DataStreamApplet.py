"""
IobeamControl/applet/DataStreamApplet.py
========================================

Glue layer between the AutomationConfig (streamData.json) and the
gateware Elaboratable. Adds three things over the previous version:

    * Reads `action.pins` from streamData.json and forwards it to the
      subtarget as `pin_config=`. Pin assignments now live in JSON
      instead of being hard-coded in applet/__init__.py.

    * Reads `action.simulation` from streamData.json. When enabled,
      loads a PNG/BMP (or generates random/pattern data) via
      imageSource.get_image_data(), and passes the resulting flat
      pixel list to the subtarget as `sim_image=`. The bitstream
      synthesises the image into BRAM, FakeAdcSimulator looks it up
      during scans.

    * Defaults `loopback=True` whenever `simulation.enabled == true`,
      regardless of the IsProduction flag. Production builds can still
      set `simulation.enabled == false` and `loopback=false` to drive
      a real sub-target board once it exists.

Backward compatibility: when neither pins nor simulation is configured,
the applet falls back to loopback=True with no image (same behaviour as
before, minus the dead PCF pins).
"""

import struct

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowApplet
from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
from GlasgowDataIO.IobeamControl.applet.imageSource import get_image_data
from AutomationPy.buildingblocks.automation_log import AutomationLog
from AutomationPy.buildingblocks.definitions import Consts
import AutomationPy.buildingblocks.utils as util


class DataStreamApplet(GlasgowApplet):
    required_revision = "C3"
    help              = "IobeamTech ADC data stream Applet"
    description       = ""

    def __init__(self, config=None):
        super(DataStreamApplet, self).__init__()
        self._config = config
        self.logger  = AutomationLog.GetLogger(config.LogName) \
            if config is not None else None

    @classmethod
    def add_build_arguments(cls, parser, access):
        super().add_build_arguments(parser, access)

        access.add_pin_set_argument(parser, "ebeam_scan_enable",  range(1, 3))
        access.add_pin_set_argument(parser, "ibeam_scan_enable",  range(1, 3))
        access.add_pin_set_argument(parser, "ebeam_blank_enable", range(1, 3))
        access.add_pin_set_argument(parser, "ibeam_blank_enable", range(1, 3))
        access.add_pin_set_argument(parser, "ibeam_blank",        range(1, 3))
        access.add_pin_set_argument(parser, "ebeam_blank",        range(1, 3))

        parser.add_argument("--loopback", dest="loopback",
                            action="store_true",
                            help="connect output and input streams internally")
        parser.add_argument("--benchmark", dest="benchmark",
                            action="store_true",
                            help="run benchmark test")
        parser.add_argument("--xflip", dest="xflip", action="store_true",
                            help="flip x axis")
        parser.add_argument("--yflip", dest="yflip", action="store_true",
                            help="flip y axis")
        parser.add_argument("--rotate90", dest="rotate90", action="store_true",
                            help="switch x and y axes")
        parser.add_argument("--out_only", dest="out_only", action="store_true",
                            help="use FastBusController instead of "
                                 "BusController; don't use ADC")
        parser.add_argument("--ext_switch_delay", type=int, default=0,
                            help="time for external control switch to "
                                 "actuate, in ms")

    # ------------------------------------------------------------------ #
    # Helper: pull (pin_config, sim_image, sim_image_resolution, loopback)
    # out of the streamData.json action block, with sensible defaults.
    # ------------------------------------------------------------------ #
    def _resolve_simulation(self):
        action_data = util.GetStateConfigByName(self._config, Consts.STREAM_DATA).get(Consts.ACTION_DATA, {}) or {}
        pin_config = action_data.get("pins", {}) or {}
        sim_config = action_data.get("simulation", {}) or {}

        sim_enabled = bool(sim_config.get("enabled", False))
        sim_image   = None
        sim_res     = int(sim_config.get("imageResolution", 64))

        if sim_enabled:
            try:
                sim_image, sim_res = get_image_data(sim_config)
                if self.logger:
                    self.logger.info(
                        f"simulation: image source={sim_config.get('source')} "
                        f"resolution={sim_res}x{sim_res} "
                        f"size={len(sim_image)}")
            except Exception as exc:
                if self.logger:
                    self.logger.error(
                        f"simulation: failed to load image: {exc} - "
                        f"falling back to no image")
                sim_image = None

        # Loopback decision tree:
        #   simulation.enabled true  -> loopback always true
        #   simulation.enabled false -> use IsProduction as before
        if sim_enabled:
            loopback = True
        elif self._config is not None and hasattr(self._config,
                                                  "IsProduction"):
            loopback = not self._config.IsProduction
        else:
            loopback = True

        return pin_config, sim_image, sim_res, loopback

    def build(self, target, args):
        args.pipes = "PQ"

        self.magic_reg, self.addr_magic = target.registers.add_ro(8, init=0xa5)
        self.reset_reg, addr_reset = target.registers.add_rw(8, init=0)
        self.addr_reset = addr_reset

        self.mux_interface = iface = target.multiplexer.claim_interface(
            self, args)

        # Claim FIFOs ONCE here.
        out_fifo = iface.get_out_fifo()
        in_fifo  = iface.get_in_fifo()

        ports = iface.get_port_group()

        pin_config, sim_image, sim_res, loopback = self._resolve_simulation()

        subtarget = IobeamDataSubtarget(
            ports                = ports,
            in_fifo              = in_fifo,
            out_fifo             = out_fifo,
            _addr_reset          = self.reset_reg,
            loopback             = loopback,
            pin_config           = pin_config,
            sim_image            = sim_image,
            sim_image_resolution = sim_res,
        )
        return iface.add_subtarget(subtarget)

    async def run(self, device, args):
        await device.write_register(self.addr_reset, 0x01)
        return await device.demultiplexer.claim_interface(
            self, self.mux_interface, args)

    async def run_handshake(self, iface):
        if self.logger:
            self.logger.info("Synchronizing with Glasgow hardware...")

        cookie_val = 0x1234
        # Format: [ID=0 (Sync), Cookie_High, Cookie_Low, Mode]
        sync_cmd = struct.pack('>BHB', 0, cookie_val, 1)

        await iface.write(sync_cmd)
        await iface.flush()

        reply = await iface.read(4)
        if len(reply) < 4:
            raise RuntimeError("Handshake failed: No response from hardware")

        if self.logger:
            self.logger.info(
                f"Handshake successful. Hardware echo: {reply.hex()}")
