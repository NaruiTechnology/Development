from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from . import * 

class FastBusController(wiring.Component):
    # FPGA-side interface
    dac_stream: In(StreamSignature(SuperDACStream)) # type: ignore


    # IO-side interface
    bus: Out(BusSignature) # type: ignore
    inline_blank: Out(BlankRequest) # type: ignore

    # Ignored
    # adc_stream: Out(StreamSignature(data.StructLayout({
    #     "adc_code": 14,
    #     "adc_ovf":  1,
    #     "last":     1,
    # })))
    ADC_STREAM_SIGNATURE = StreamSignature(data.StructLayout({
        "adc_code": 14,
        "adc_ovf":  1,
        "last":     1,
    }))
    adc_stream: Out(ADC_STREAM_SIGNATURE) # type: ignore

    def __init__(self):
        self.delay = 3
        super().__init__()

    def elaborate(self, platform):
        m = Module()

        delay_cycles = Signal(3)

        dac_stream_data = Signal.like(self.dac_stream.payload)
        m.d.comb += self.inline_blank.eq(dac_stream_data.blank)

        with m.FSM():
            with m.State("X_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(dac_stream_data.dac_x_code),
                    self.bus.data_oe.eq(1),
                ]
                m.d.sync += self.bus.dac_clk.eq(0)
                m.next = "X_DAC_Write_2"

            with m.State("X_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(dac_stream_data.dac_x_code),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_x_le_clk.eq(1),
                ]
                m.next = "Y_DAC_Write"

            with m.State("Y_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(dac_stream_data.dac_y_code),
                    self.bus.data_oe.eq(1),
                ]
                m.next = "Y_DAC_Write_2"

            with m.State("Y_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(dac_stream_data.dac_y_code),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_y_le_clk.eq(1),
                ]  
                m.next = "Latch_Delay"
            
            with m.State("Latch_Delay"):
                with m.If(delay_cycles > 0):
                    m.d.sync += delay_cycles.eq(delay_cycles - 1) 
                with m.Else():
                    m.d.sync += self.bus.dac_clk.eq(1)
                    with m.If(self.dac_stream.valid):
                        # Latch DAC codes from input stream.
                        m.d.comb += self.dac_stream.ready.eq(1)
                        m.d.sync += dac_stream_data.eq(self.dac_stream.payload)
                        with m.If(dac_stream_data.last): #latch delay from the previous stream
                            m.d.sync +=  delay_cycles.eq(dac_stream_data.delay)
                    m.next = "X_DAC_Write"  
                
                    

        return m

