from amaranth import *
from amaranth.lib import wiring
from amaranth.lib.wiring import In, Out, flipped
from amaranth.build import *
from . import *

class PipelinedLoopbackAdapter(wiring.Component):
    loopback_stream: In(unsigned(16)) # type: ignore
    bus: Out(BusSignature) # type: ignore

    def __init__(self, adc_latency: int):
        self.adc_latency = adc_latency
        super().__init__()

    def elaborate(self, platform):
        m = Module()

        # The converter advances even if its output register is disabled.
        # Follow the conversion clock, so a missed bus read cannot silently
        # stretch the simulated pipeline to match a broken bus schedule.
        # Logical falling edges are physical rising edges with production
        # adc_clk inversion. The configured latency is the end-to-end model
        # delay, not a claim about the ADC chip's pipeline depth alone.
        prev_bus_adc_clk = Signal()
        adc_conversion = Signal()
        m.d.sync += prev_bus_adc_clk.eq(self.bus.adc_clk)
        m.d.comb += adc_conversion.eq(prev_bus_adc_clk & ~self.bus.adc_clk)

        shift_register = Signal(16 * self.adc_latency)

        with m.If(adc_conversion):
            m.d.sync += shift_register.eq((shift_register << 16) | self.loopback_stream)

        m.d.comb += self.bus.data_i.eq(shift_register.word_select(self.adc_latency - 1, 16))

        return m
