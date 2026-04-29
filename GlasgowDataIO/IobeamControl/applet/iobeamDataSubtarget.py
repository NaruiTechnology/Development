"""
IobeamControl/applet/iobeamDataSubtarget.py
===========================================

The top-level Amaranth Elaboratable that ties everything together:

    parser  -> executor  -> serializer  -> in_fifo (USB host)
    out_fifo (USB host) -> parser
    executor.bus  <->  data pins         (when pin_config provides them)
    executor.bus  <->  control pins      (when pin_config provides them)
    executor.bus  <->  PipelinedLoopbackAdapter  (when loopback=True)
                            ^
                            |  loopback_value
                       FakeAdcSimulator  <- super_dac_stream coords

What changed (vs. the previous version)
---------------------------------------
1. Resources come from `pin_config`, not a hard-coded list. Anything
   missing from the config is silently skipped - no PCF errors from
   placeholder strings.
2. New `sim_image` / `sim_image_resolution` constructor params. When
   loopback=True AND sim_image is provided, FakeAdcSimulator drives the
   loopback adapter instead of the historical "DAC-loopback" debug path
   (which only echoed the X coordinate or the dwell time as a synthetic
   pixel and produced visually meaningless gradients).
3. Bus strobes are routed to physical pins ONLY for those names that
   appear in iobeam_resources. Strobes that aren't pinned still toggle
   internally - that's what FakeAdcSimulator and PipelinedLoopbackAdapter
   need them to do.
"""

from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from amaranth.hdl import Elaboratable, Module

from GlasgowDataIO.IobeamControl.commands.structs import (
    CmdType, BeamType, OutputMode, Transforms,
)
from GlasgowDataIO.IobeamControl.applet.commandParser    import CommandParser
from GlasgowDataIO.IobeamControl.applet.commandExecutor  import CommandExecutor
from GlasgowDataIO.IobeamControl.applet.imageSerializer  import ImageSerializer
from GlasgowDataIO.IobeamControl.applet.pipelinedLoopbackAdapter \
    import PipelinedLoopbackAdapter
from GlasgowDataIO.IobeamControl.applet.fakeAdcSimulator import FakeAdcSimulator
from GlasgowDataIO.IobeamControl.applet import build_iobeam_resources


# All bus strobes BusController generates. Order is irrelevant; the names
# must match what fakeAdcSimulator and the JSON config use.
_BUS_STROBES = (
    "adc_clk",
    "adc_le_clk",
    "adc_oe",
    "dac_clk",
    "dac_x_le_clk",
    "dac_y_le_clk",
)


class IobeamDataSubtarget(Elaboratable):
    def __init__(self, *, ports, out_fifo, in_fifo, led=None, control=None,
                 data=None,
                 ext_switch_delay=0, transforms: Transforms = None,
                 benchmark_counters=None, loopback=False, out_only=False,
                 pin_config=None,
                 sim_image=None,
                 sim_image_resolution=64,
                 **kwargs):
        super().__init__()
        self._addr_reset = kwargs.get("_addr_reset", None)
        self.ports               = ports
        self.out_fifo            = out_fifo
        self.in_fifo             = in_fifo
        self.led                 = led
        self.control             = control
        self.data                = data
        self.ext_switch_delay    = ext_switch_delay
        self.transforms          = transforms
        self.loopback            = loopback
        self.out_only            = out_only
        self.pin_config          = pin_config or {}
        self.sim_image           = sim_image
        self.sim_image_resolution= sim_image_resolution

        if benchmark_counters is not None:
            self.benchmark = True
            (self.out_stall_events,
             self.out_stall_cycles,
             self.stall_count_reset) = benchmark_counters
        else:
            self.benchmark = False

    def elaborate(self, platform):
        m = Module()

        # ------------------------------------------------------------------ #
        # Run gate: keeps the in_fifo write path silent until the host
        # explicitly opens it by writing 1 to applet.addr_reset.
        # ------------------------------------------------------------------ #
        run_enable = Signal()
        if self._addr_reset is not None:
            m.d.comb += run_enable.eq(self._addr_reset)
        else:
            m.d.sync += run_enable.eq(1)

        # ------------------------------------------------------------------ #
        # Core modules
        # ------------------------------------------------------------------ #
        m.submodules.parser     = parser     = CommandParser()
        m.submodules.executor   = executor   = CommandExecutor(
            out_only=self.out_only,
            ext_switch_delay=self.ext_switch_delay,
            transforms=self.transforms)
        m.submodules.serializer = serializer = ImageSerializer()

        wiring.connect(m, parser.cmd_stream, executor.cmd_stream)
        wiring.connect(m, executor.img_stream, serializer.img_stream)

        # Wire executor.output_mode to serializer.output_mode at module
        # level so the sync cookie response and image bytes aren't
        # dropped during Write_FFFF / Write_cookie states.
        m.d.comb += serializer.output_mode.eq(executor.output_mode)

        # OUT FIFO -> Parser
        m.d.comb += [
            parser.usb_stream.payload.eq(self.out_fifo.r_data),
            parser.usb_stream.valid.eq(self.out_fifo.r_rdy),
            self.out_fifo.r_en.eq(parser.usb_stream.ready),
        ]

        # Serializer -> IN FIFO (gated by run_enable)
        m.d.comb += [
            self.in_fifo.w_data.eq(serializer.usb_stream.payload),
            self.in_fifo.w_en.eq(serializer.usb_stream.valid & run_enable),
            serializer.usb_stream.ready.eq(self.in_fifo.w_rdy & run_enable),
        ]

        # ------------------------------------------------------------------ #
        # Resources: built dynamically from pin_config
        # ------------------------------------------------------------------ #
        resources = build_iobeam_resources(self.pin_config)
        if resources:
            platform.add_resources(resources)

        # Helper: does the platform actually carry a Resource named `name`?
        # Used to decide whether to call platform.request().
        def _has_resource(name):
            for r in resources:
                if r.name == name:
                    return True
            return False

        # LED is provided by the Glasgow platform itself - always present.
        if platform is not None:
            self.led = platform.request("led", dir="-")
        else:
            self.led = io.SimulationPort("o", 1)

        m.submodules.led_buffer = led = io.Buffer("o", self.led)
        m.d.comb += led.o.eq(~serializer.usb_stream.ready)

        # ------------------------------------------------------------------ #
        # Optional control strobes
        # ------------------------------------------------------------------ #
        present_strobes = set()
        if platform is not None and _has_resource("control"):
            ctrl_res = next(r for r in resources if r.name == "control")
            ctrl_dirs = {sub.name: "-" for sub in ctrl_res.ios}
            self.control = platform.request("control", dir=ctrl_dirs)
            for sub in ctrl_res.ios:
                if hasattr(self.control, sub.name):
                    present_strobes.add(sub.name)
                    buf = io.Buffer("o", getattr(self.control, sub.name))
                    m.submodules[f"{sub.name}_buffer"] = buf
                    # Map known names to executor.bus signals; ignore others
                    # (e.g. d_clock, a_clock from the legacy resource).
                    if sub.name in _BUS_STROBES:
                        m.d.comb += buf.o.eq(getattr(executor.bus, sub.name))

        # ------------------------------------------------------------------ #
        # Optional data bus
        # ------------------------------------------------------------------ #
        data_buf = None
        if platform is not None and _has_resource("data"):
            self.data = platform.request("data", dir="-")
            m.submodules.data_buffer = data_buf = io.Buffer("io", self.data)
            m.d.comb += [
                data_buf.o.eq(executor.bus.data_o),
                data_buf.oe.eq(executor.bus.data_oe),
            ]

        # ------------------------------------------------------------------ #
        # Loopback / external data input
        # ------------------------------------------------------------------ #
        if self.loopback:
            m.submodules.loopback_adapter = loopback_adapter = \
                PipelinedLoopbackAdapter(executor.adc_latency)
            wiring.connect(m, executor.bus, flipped(loopback_adapter.bus))

            if self.sim_image is not None:
                # Image-backed fake ADC. Address ROM with the live
                # super_dac_stream coords (combinational), feed BRAM
                # output to the loopback shift register.
                m.submodules.fake_adc = fake_adc = FakeAdcSimulator(
                    image_data=self.sim_image,
                    image_resolution=self.sim_image_resolution,
                )
                m.d.comb += [
                    fake_adc.dac_x_code.eq(
                        executor.supersampler.super_dac_stream.payload.dac_x_code),
                    fake_adc.dac_y_code.eq(
                        executor.supersampler.super_dac_stream.payload.dac_y_code),
                    loopback_adapter.loopback_stream.eq(fake_adc.loopback_value),
                ]
            else:
                # Backward-compat DAC-loopback (no image): echoes dwell
                # time during raster scans, X coord during vector scans.
                # Useful only for raw connectivity sanity checks.
                loopback_dwell_time = Signal()
                m.d.sync += loopback_dwell_time.eq(
                    executor.cmd_stream.payload.type == CmdType.RasterPixel)
                with m.If(loopback_dwell_time):
                    m.d.comb += loopback_adapter.loopback_stream.eq(
                        executor.supersampler.dac_stream.payload.dwell_time)
                with m.Else():
                    m.d.comb += loopback_adapter.loopback_stream.eq(
                        executor.supersampler.super_dac_stream.payload.dac_x_code)
        elif data_buf is not None:
            # Real ADC path: external chip drives data bus during
            # ADC_Wait/ADC_Read (data_oe == 0). data.i is the latched
            # value from the input buffer.
            m.d.comb += executor.bus.data_i.eq(data_buf.i)
        else:
            # No loopback, no data pins -> tie data_i low. The design
            # synthesises but reads will be all zeros.
            m.d.comb += executor.bus.data_i.eq(0)

        # ------------------------------------------------------------------ #
        # External-control / blanking pins (from `ports`)
        # ------------------------------------------------------------------ #
        def connect_pins(pin_name, signal):
            if hasattr(self.ports, pin_name):
                if self.ports[pin_name] is not None:
                    if not hasattr(m.submodules, f"{pin_name}_buffer"):
                        m.submodules[f"{pin_name}_buffer"] = \
                            io.Buffer("o", self.ports[pin_name])
                    for pin in m.submodules[f"{pin_name}_buffer"].o:
                        m.d.comb += pin.eq(signal)

        connect_pins("ebeam_scan_enable",  executor.ext_ctrl_enable)
        connect_pins("ibeam_scan_enable",  executor.ext_ctrl_enable)
        connect_pins("ebeam_blank_enable", executor.ext_ctrl_enable)
        connect_pins("ibeam_blank_enable", executor.ext_ctrl_enable)

        with m.If(executor.ext_ctrl_enabled):
            with m.If(executor.beam_type == BeamType.NoBeam):
                connect_pins("ebeam_blank", 1)
                connect_pins("ibeam_blank", 1)
            with m.Elif(executor.beam_type == BeamType.Electron):
                connect_pins("ebeam_blank", executor.blank_enable)
                connect_pins("ibeam_blank", 1)
            with m.Elif(executor.beam_type == BeamType.Ion):
                connect_pins("ibeam_blank", executor.blank_enable)
                connect_pins("ebeam_blank", 1)
        with m.Else():
            connect_pins("ebeam_blank", 0)
            connect_pins("ibeam_blank", 0)

        # ------------------------------------------------------------------ #
        # Benchmark counters
        # ------------------------------------------------------------------ #
        if self.benchmark:
            m.d.comb += self.out_stall_cycles.eq(
                executor.supersampler.stall_cycles)
            m.d.comb += executor.supersampler.stall_count_reset.eq(
                self.stall_count_reset)
            out_stall_event = Signal()
            begin_write     = Signal()
            with m.If(self.stall_count_reset):
                m.d.sync += self.out_stall_events.eq(0)
                m.d.sync += out_stall_event.eq(0)
                m.d.sync += begin_write.eq(0)
            with m.Else():
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += begin_write.eq(1)
                with m.If(begin_write):
                    with m.If(~self.out_fifo.r_rdy):
                        with m.If(~out_stall_event):
                            m.d.sync += out_stall_event.eq(1)
                            with m.If(~(self.out_stall_events >= 65536)):
                                m.d.sync += self.out_stall_events.eq(
                                    self.out_stall_events + 1)
                    with m.Else():
                        m.d.sync += out_stall_event.eq(0)

        return m
