"""
IobeamControl/applet/DataStreamApplet.py
========================================

Glue layer between the AutomationConfig (streamData.json) and the
gateware Elaboratable. Adds three things over the previous version:

    * Reads `action.pins` from streamData.json and forwards it to the
      subtarget as `pin_config=`. Pin assignments now live in JSON
      instead of being hard-coded in applet/__init__.py.

    * Reads `action.simulation` from streamData.json. When IsProduction
      is false, the `simulation.mode` key chooses what fills the ADC
      data path:
        - "image"    bake a PNG/BMP/pattern into BRAM (default)
        - "zeros"    tie data_i to 0; scan returns black at the actual
                     resolution. No BRAM cost. Use this to validate
                     the production data-path before the PCB arrives.
        - "loopback" DAC-coordinate echo (connectivity diagnostic)

    * Defaults `loopback=True` whenever `IsProduction == false`.
      Production builds (IsProduction == true) drive the real ADC
      path and ignore the `simulation` block.

Backward compatibility: when neither pins nor simulation is configured,
the applet falls back to loopback=True with no image (same behaviour as
before, minus the dead PCF pins).
"""

from .adcTiming import AdcTiming

import struct

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowApplet
from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget
from GlasgowDataIO.IobeamControl.applet.imageSource import get_image_data
from AutomationPy.buildingblocks.automation_log import AutomationLog
from AutomationPy.buildingblocks.definitions import Consts
from GlasgowDataIO.IobeamControl.scanConfiguration import BEAM_PORTS, configure_scan_args


# Sentinel object used by _resolve_simulation() to tell the subtarget
# "you're in zero-fill mode": loopback = True, no BRAM, data_i tied to
# constant 0. Distinct from `None` (which means "no image, fall back
# to coord-loopback") and from a real image list. We import the same
# sentinel from iobeamDataSubtarget so identity comparison works
# across modules.
from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import _ZERO_FILL
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
        """
        Decide what fills `bus.data_i` for this build.

        Returns (pin_config, sim_image, sim_image_resolution, loopback).

        Decision tree:

            IsProduction = True
                Real PCB is present. loopback = False, sim_image = None.
                The subtarget routes data.i from the physical pins.

            IsProduction = False
                No PCB (or simulation desired). loopback = True. The
                subtarget instantiates PipelinedLoopbackAdapter; what
                feeds it is selected by `simulation.mode`:

                    mode = "zeros"   - tie data_i to 0. No BRAM cost.
                                       Scans complete at the ACTUAL
                                       requested resolution and the
                                       saved PNG shows a pure black
                                       frame. Use this to validate the
                                       full scan path at production
                                       resolution before the PCB
                                       arrives. This is the new mode
                                       you asked for.
                    mode = "image"   - load PNG/BMP/pattern into BRAM,
                                       FakeAdcSimulator drives data_i.
                                       Bound by the iCE40 BRAM budget,
                                       so image resolution is decoupled
                                       from scan resolution (the image
                                       upsamples into tiles at high
                                       scan resolutions). This is the
                                       default if `mode` is absent and
                                       a `simulation` block exists.
                    mode = "loopback" - DAC-coordinate echo. No image,
                                        no BRAM, but the captured
                                        pixels carry no useful structure
                                        beyond "the path is alive".

        The `enabled` flag retained from earlier patches still gates
        the whole simulation block - if `simulation.enabled` is false
        and IsProduction is false, mode defaults to "loopback" so
        existing connectivity tests keep working.
        """
        action_data = util.GetStateConfigByName(
            self._config, Consts.STREAM_DATA).get(Consts.ACTION_DATA, {}) or {}

        pin_config = action_data.get("pins", {}) or {}
        sim_config = action_data.get("simulation", {}) or {}

        is_production = bool(self._config.IsProduction) \
            if self._config is not None and hasattr(self._config, "IsProduction") \
            else False

        # Production: real PCB. No simulation, no loopback.
        if is_production:
            return pin_config, None, 0, False

        # Non-production: figure out what fills data_i.
        # `mode` is the new knob; fall back sensibly when it's absent
        # so older configs keep working.
        sim_enabled = bool(sim_config.get("enabled", True))
        if not sim_enabled:
            # Explicit "no simulation" with no PCB - degenerate case.
            # Fall through to coord-loopback so the path still moves
            # bytes, but log so it's obvious in the build output.
            mode = "loopback"
        else:
            mode = sim_config.get("mode", "image")

        sim_image = None
        sim_res = int(sim_config.get("imageResolution", 64))

        if mode == "image":
            # Existing behavior: bake an image into BRAM.
            sim_image, sim_res = get_image_data(sim_config)
        elif mode == "zeros":
            # New behavior: no BRAM, no image. The subtarget will see
            # sim_image=None AND a marker telling it to tie data_i
            # to 0 instead of falling through to coord-loopback. We
            # carry that marker by passing sim_image as the special
            # sentinel object `_ZERO_FILL`. The subtarget recognizes
            # it and emits one comb assignment instead of a BRAM.
            sim_image = _ZERO_FILL
        elif mode == "loopback":
            # Coord-loopback diagnostic.
            sim_image = None
        else:
            if self.logger is not None:
                self.logger.warning(
                    f"Unknown simulation.mode={mode!r}; falling back to "
                    f"image-loopback")
            sim_image, sim_res = get_image_data(sim_config)

        if self.logger is not None:
            self.logger.info(
                f"simulation: IsProduction={is_production} mode={mode} "
                f"sim_image={'<image>' if isinstance(sim_image, list) else sim_image} "
                f"sim_res={sim_res}")

        return pin_config, sim_image, sim_res, True
    
    def build(self, target, args):
        args.pipes = "PQ"
        action_data = util.GetStateConfigByName(
            self._config, Consts.STREAM_DATA).get(Consts.ACTION_DATA, {}) or {}
        configure_scan_args(self._config, action_data, args)

        self.magic_reg, self.addr_magic = target.registers.add_ro(8, init=0xa5)
        self.reset_reg, addr_reset = target.registers.add_rw(8, init=0)
        self.addr_reset = addr_reset
        self.power_good_reg, self.addr_power_good = target.registers.add_ro(8, init=0)
        self.bus_ownership_reg, self.addr_bus_ownership = \
            target.registers.add_ro(8, init=0)
        self.bus_ownership_clear_reg, self.addr_bus_ownership_clear = \
            target.registers.add_rw(1, init=0)

        self.mux_interface = iface = target.multiplexer.claim_interface(
            self, args)

        # Claim FIFOs ONCE here.
        out_fifo = iface.get_out_fifo()
        in_fifo  = iface.get_in_fifo()

        ports = iface.get_port_group(**{name: getattr(args, name) for name in BEAM_PORTS})

        pin_config, sim_image, sim_res, loopback = self._resolve_simulation()
        action_data = util.GetStateConfigByName(
            self._config, Consts.STREAM_DATA).get(Consts.ACTION_DATA, {}) or {}
        timing = AdcTiming.from_action(action_data)

        subtarget = IobeamDataSubtarget(
            ports                = ports,
            in_fifo              = in_fifo,
            out_fifo             = out_fifo,
            _addr_reset          = self.reset_reg,
            bus_ownership_status = self.bus_ownership_reg,
            bus_ownership_clear  = self.bus_ownership_clear_reg,
            power_good_status    = self.power_good_reg,
            loopback             = loopback,
            adc_half_period      = timing.half_period,
            adc_settle_cycles    = timing.settle_cycles,
            adc_latch_cycles     = timing.latch_cycles,
            transforms           = args.transforms,
            ext_switch_delay     = args.ext_switch_delay_cycles,
            out_only             = getattr(args, "out_only", False),
            pin_config           = pin_config,
            sim_image            = sim_image,
            sim_image_resolution = sim_res,
        )
        return iface.add_subtarget(subtarget)

    async def run(self, device, args):
        await device.write_register(self.addr_reset, 0x01)
        return await device.demultiplexer.claim_interface(
            self, self.mux_interface, args, pull_high=args.beam_pull_high)

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
