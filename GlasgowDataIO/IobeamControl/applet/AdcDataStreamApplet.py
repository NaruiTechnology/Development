"""Dedicated ADC-only Glasgow applet.

This design deliberately does not instantiate the scan command parser,
CommandExecutor, BusController, Supersampler, or either DAC path.  The shared
14-bit data bus is requested as input-only, and only the three ADC control
signals are routed to pins.  In particular, there is no FPGA output-enable or
physical resource for the XY DAC bus in this bitstream.
"""

from amaranth import *
from amaranth.build import Attrs, Pins, Resource, Subsignal
from amaranth.hdl import Elaboratable, Module
from amaranth.lib import io

from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.applet import GlasgowApplet
from AutomationPy.buildingblocks.automation_log import AutomationLog
import AutomationPy.buildingblocks.utils as util
from AutomationPy.buildingblocks.definitions import Consts


def build_adc_resources(pin_config):
    """Build an ADC-only resource set from the normal stream pin config.

    DAC subsignals are intentionally filtered out rather than driven low.  The
    data resource is forced to input direction even though the scan applet uses
    the same pins bidirectionally.
    """
    pin_config = pin_config or {}
    resources = []
    control = pin_config.get("control", {}) or {}
    adc_names = {"adc_clk", "adc_le_clk", "adc_oe"}
    subsignals = []
    for entry in control.get("subsignals", []) or []:
        name = entry.get("name")
        pin = str(entry.get("pin") or "").strip()
        if name not in adc_names or not pin:
            continue
        subsignals.append(Subsignal(
            name,
            Pins(pin, dir="o", invert=bool(entry.get("invert", False))),
        ))
    if subsignals:
        resources.append(Resource(
            "adc_control", 0, *subsignals,
            Attrs(**(control.get("attrs") or {"IO_STANDARD": "SB_LVCMOS33"})),
        ))

    data = pin_config.get("data", {}) or {}
    data_pins = str(data.get("pins") or "").strip()
    if data_pins:
        resources.append(Resource(
            "adc_data", 0, Pins(data_pins, dir="i"),
            Attrs(**(data.get("attrs") or {"IO_STANDARD": "SB_LVCMOS33"})),
        ))
    return resources


class AdcDataSubtarget(Elaboratable):
    """Autonomous ADC sampler with a hardware-bounded capture window."""

    def __init__(self, *, in_fifo, capture_enable, capture_status,
                 pin_config=None, simulation=False, seed=1,
                 adc_half_period=6, adc_settle_cycles=2,
                 duration_cycles=None, clock_hz=48_000_000):
        self.in_fifo = in_fifo
        self.capture_enable = capture_enable
        self.capture_status = capture_status
        self.pin_config = pin_config or {}
        self.simulation = bool(simulation)
        self.seed = int(seed) & 0x3fff or 1
        self.adc_half_period = max(2, int(adc_half_period))
        self.adc_settle_cycles = max(1, int(adc_settle_cycles))
        self.duration_cycles = max(1, int(duration_cycles or clock_hz))

        # Public signals make the no-DAC invariants directly testable.
        self.adc_oe = Signal()
        self.adc_clk = Signal()
        self.adc_le_clk = Signal()
        self.data_i = Signal(14)
        self.running = Signal()
        self.complete = Signal()

    def elaborate(self, platform):
        m = Module()

        resources = [] if self.simulation else build_adc_resources(self.pin_config)
        if platform is not None and resources:
            platform.add_resources(resources)

        resource_names = {resource.name for resource in resources}
        if platform is not None and "adc_control" in resource_names:
            control = platform.request("adc_control", dir={
                "adc_clk": "o", "adc_le_clk": "o", "adc_oe": "o",
            })
            for name in ("adc_clk", "adc_le_clk", "adc_oe"):
                if hasattr(control, name):
                    m.d.comb += getattr(control, name).o.eq(getattr(self, name))
        if platform is not None and "adc_data" in resource_names:
            data_port = platform.request("adc_data", dir="-")
            m.submodules.adc_data_buffer = data_buffer = io.Buffer("i", data_port)
            m.d.comb += self.data_i.eq(data_buffer.i)
        elif not self.simulation:
            m.d.comb += self.data_i.eq(0)

        duration_counter = Signal(range(self.duration_cycles + 1))
        started = Signal()
        period = self.adc_half_period * 2
        conversion_counter = Signal(range(period))
        sample_phase = min(period - 1, self.adc_settle_cycles + 1)
        sample_tick = Signal()

        # adc_oe is the logical active-high signal. The production pin is
        # inverted in streamData.json, so logical 1 is physical OE low.
        m.d.comb += [
            self.adc_oe.eq(self.running),
            self.adc_clk.eq(self.running &
                            (conversion_counter >= self.adc_half_period)),
            self.adc_le_clk.eq(self.running & (conversion_counter == 0)),
            sample_tick.eq(self.running & (conversion_counter == sample_phase)),
            self.capture_status.eq(Cat(self.running, self.complete, started)),
        ]

        with m.If(~self.capture_enable):
            m.d.sync += [
                started.eq(0), self.running.eq(0), self.complete.eq(0),
                duration_counter.eq(0), conversion_counter.eq(0),
            ]
        with m.Elif(~started):
            m.d.sync += [
                started.eq(1), self.running.eq(1), self.complete.eq(0),
                duration_counter.eq(0), conversion_counter.eq(0),
            ]
        with m.Elif(self.running):
            with m.If(duration_counter == self.duration_cycles - 1):
                m.d.sync += [self.running.eq(0), self.complete.eq(1)]
            with m.Else():
                m.d.sync += duration_counter.eq(duration_counter + 1)
            with m.If(conversion_counter == period - 1):
                m.d.sync += conversion_counter.eq(0)
            with m.Else():
                m.d.sync += conversion_counter.eq(conversion_counter + 1)

        # One sample register and byte serializer. If USB backpressure lasts
        # across a sample point, that point is dropped while ADC timing and OE
        # remain uninterrupted. Complete mode emits an aligned 0xffff marker
        # repeatedly so a fixed-size host read always terminates.
        IDLE, SAMPLE_HI, SAMPLE_LO, END_HI, END_LO = range(5)
        writer_state = Signal(range(5), reset=IDLE)
        sample = Signal(16)
        lfsr = Signal(14, reset=self.seed)
        random_value = Signal(14)
        m.d.comb += random_value.eq(Cat(lfsr[13] ^ lfsr[12], lfsr[:13]))

        m.d.comb += [self.in_fifo.w_en.eq(0), self.in_fifo.w_data.eq(0)]
        with m.Switch(writer_state):
            with m.Case(SAMPLE_HI):
                m.d.comb += [
                    self.in_fifo.w_en.eq(1),
                    self.in_fifo.w_data.eq(sample[8:16]),
                ]
                with m.If(self.in_fifo.w_rdy):
                    m.d.sync += writer_state.eq(SAMPLE_LO)
            with m.Case(SAMPLE_LO):
                m.d.comb += [
                    self.in_fifo.w_en.eq(1),
                    self.in_fifo.w_data.eq(sample[:8]),
                ]
                with m.If(self.in_fifo.w_rdy):
                    m.d.sync += writer_state.eq(IDLE)
            with m.Case(END_HI, END_LO):
                m.d.comb += [self.in_fifo.w_en.eq(1), self.in_fifo.w_data.eq(0xff)]
                with m.If(self.in_fifo.w_rdy):
                    with m.If(writer_state == END_HI):
                        m.d.sync += writer_state.eq(END_LO)
                    with m.Else():
                        m.d.sync += writer_state.eq(END_HI)

        with m.If(~self.capture_enable):
            m.d.sync += writer_state.eq(IDLE)
        with m.Elif(writer_state == IDLE):
            with m.If(self.complete):
                m.d.sync += writer_state.eq(END_HI)
            with m.Elif(sample_tick):
                m.d.sync += [
                    sample.eq(random_value if self.simulation else self.data_i),
                    writer_state.eq(SAMPLE_HI),
                    lfsr.eq(random_value),
                ]

        return m


class AdcDataStreamApplet(GlasgowApplet):
    required_revision = "C3"
    help = "IobeamTech isolated ADC data stream applet"
    description = "ADC acquisition without XY DAC or shared-bus output activity"

    def __init__(self, config, *, duration_minutes=5, simulation=False, seed=1,
                 duration_cycles=None):
        super().__init__()
        self._config = config
        self.logger = AutomationLog.GetLogger(config.LogName) \
            if config is not None else None
        self.duration_minutes = int(duration_minutes)
        self.simulation = bool(simulation)
        self.seed = int(seed)
        self.duration_cycles = duration_cycles

    def build(self, target, args):
        args.pipes = "PQ"
        self.capture_enable, self.addr_capture_enable = target.registers.add_rw(1, init=0)
        self.capture_status, self.addr_capture_status = target.registers.add_ro(8, init=0)
        self.mux_interface = iface = target.multiplexer.claim_interface(self, args)
        in_fifo = iface.get_in_fifo()
        # Claim the OUT FIFO as well so the direct multiplexer pipe layout is
        # identical to the normal applet, although this applet never consumes it.
        iface.get_out_fifo()

        action = getattr(args, "action_data", None)
        if action is None:
            state = util.GetStateConfigByName(self._config, Consts.STREAM_DATA)
            action = state.get(Consts.ACTION_DATA, {}) or {}
        clock_hz = int(getattr(args, "clock_hz", 48_000_000))
        duration_cycles = self.duration_cycles or (
            self.duration_minutes * 60 * clock_hz
        )
        subtarget = AdcDataSubtarget(
            in_fifo=in_fifo,
            capture_enable=self.capture_enable,
            capture_status=self.capture_status,
            pin_config=action.get("pins", {}),
            simulation=self.simulation,
            seed=self.seed,
            adc_half_period=int(action.get("adcHalfPeriod", 6)),
            adc_settle_cycles=int(action.get("adcSettleCycles", 2)),
            duration_cycles=duration_cycles,
            clock_hz=clock_hz,
        )
        self.subtarget = subtarget
        return iface.add_subtarget(subtarget)

    async def run(self, device, args):
        return await device.demultiplexer.claim_interface(
            self, self.mux_interface, args)
