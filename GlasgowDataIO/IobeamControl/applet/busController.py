from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from GlasgowDataIO.IobeamControl.commands.structs import CmdType, BeamType, OutputMode, Transforms
#from . import StreamSignature, BusSignature, BlankRequest, SuperDACStream, Transforms
from GlasgowDataIO.IobeamControl.applet import * #StreamSignature, BusSignature, BlankRequest
from GlasgowDataIO.IobeamControl.applet.skidBuffer import SkidBuffer


class BusController(wiring.Component):
    # FPGA-side interface
    dac_stream: In(StreamSignature(SuperDACStream)) # type: ignore

    ADC_STREAM_SIGNATURE = StreamSignature(data.StructLayout({
        "adc_code": 14,
        "adc_ovf":  1,
        "last":     1,
    }))
    adc_stream: Out(ADC_STREAM_SIGNATURE) # type: ignore

    # IO-side interface
    bus: Out(BusSignature) # type: ignore
    inline_blank: Out(BlankRequest) # type: ignore

    def __init__(self, *, adc_half_period: int, adc_latency: int, transforms: Transforms = Transforms(False,False,False)):
        assert (adc_half_period * 2) >= 6, "ADC period must be large enough for FSM latency"
        self.adc_half_period = adc_half_period
        self.adc_latency     = adc_latency
        self.transforms = transforms

        super().__init__()

        self.dac_x_code_transformed = Signal.like(self.dac_stream.payload.dac_x_code)
        self.dac_y_code_transformed = Signal.like(self.dac_stream.payload.dac_y_code)

    def elaborate(self, platform):
        m = Module()

        adc_cycles = Signal(range(self.adc_half_period))
        with m.If(adc_cycles == self.adc_half_period - 1):
            m.d.sync += adc_cycles.eq(0)
            m.d.sync += self.bus.adc_clk.eq(~self.bus.adc_clk)
        with m.Else():
            m.d.sync += adc_cycles.eq(adc_cycles + 1)
        # ADC and DAC share the bus and have to work in tandem. The ADC conversion starts simultaneously
        # with the DAC update, so the entire ADC period is available for DAC-scope-ADC propagation.
        m.d.comb += self.bus.dac_clk.eq(self.bus.adc_clk)


        # Queue; MSB = most recent sample, LSB = least recent sample
        accept_sample = Signal(self.adc_latency)
        # Queue; as above
        last_sample = Signal(self.adc_latency)

        m.submodules.skid_buffer = skid_buffer = \
            SkidBuffer(self.adc_stream.payload.shape(), depth=self.adc_latency)
        wiring.connect(m, flipped(self.adc_stream), skid_buffer.o)

        adc_stream_data = Signal.like(self.adc_stream.payload) # FIXME: will not be needed after FIFOs have shapes
        m.d.comb += [
            # Cat(adc_stream_data.adc_code,
            #     adc_stream_data.adc_ovf).eq(self.bus.i),
            adc_stream_data.last.eq(last_sample[self.adc_latency-1]),
            skid_buffer.i.payload.eq(adc_stream_data),
        ]

        dac_stream_data = Signal.like(self.dac_stream.payload)
        
        x = Signal.like(self.dac_x_code_transformed)
        y = Signal.like(self.dac_y_code_transformed)

        m.d.comb += adc_stream_data.adc_code.eq(self.bus.data_i)

        stalled = Signal()

        with m.FSM():
            with m.State("ADC_Wait"):
                with m.If(self.bus.adc_clk & (adc_cycles == 0)):
                    m.d.comb += self.bus.adc_le_clk.eq(1)
                    m.d.comb += self.bus.adc_oe.eq(1) #give bus time to stabilize before sampling
                    m.next = "ADC_Read"

            with m.State("ADC_Read"):
                #m.d.comb += self.bus.adc_le_clk.eq(1)
                m.d.comb += self.bus.adc_oe.eq(1)
                # buffers up to self.adc_latency samples if skid_buffer.i.ready
                m.d.comb += skid_buffer.i.valid.eq(accept_sample[self.adc_latency-1])
                with m.If(self.dac_stream.valid & skid_buffer.i.ready):
                    # Latch DAC codes from input stream.
                    m.d.comb += self.dac_stream.ready.eq(1)
                    m.d.sync += dac_stream_data.eq(self.dac_stream.payload)
                    # Transforms
                    # Rotate first so that x is x and y is y, then flip x and y as needed
                    if self.transforms is not None and hasattr(self.transforms.rotate90, 'rotate90') and self.transforms.rotate90:
                        m.d.comb += x.eq(self.dac_stream.payload.dac_y_code)
                        m.d.comb += y.eq(self.dac_stream.payload.dac_x_code)
                    else:
                        m.d.comb += x.eq(self.dac_stream.payload.dac_x_code)
                        m.d.comb += y.eq(self.dac_stream.payload.dac_y_code)
                    
                    if self.transforms is not None:
                        if self.transforms.xflip:
                            m.d.sync += self.dac_x_code_transformed.eq(16383-x)
                        else:
                            m.d.sync += self.dac_x_code_transformed.eq(x)

                        if self.transforms.yflip:
                            m.d.sync += self.dac_y_code_transformed.eq(16383-y)
                        else:
                            m.d.sync += self.dac_y_code_transformed.eq(y)

                    # Transmit blanking state from input stream
                    m.d.comb += self.inline_blank.eq(self.dac_stream.payload.blank)
                    # Schedule ADC sample for these DAC codes to be output.
                    m.d.sync += accept_sample.eq(Cat(1, accept_sample))
                    # Carry over the flag for last sample [of averaging window] to the output.
                    m.d.sync += last_sample.eq(Cat(self.dac_stream.payload.last, last_sample))
                with m.Else():
                    # Leave DAC codes as they are.
                    # Schedule ADC sample for these DAC codes to be discarded.
                    m.d.sync += accept_sample.eq(Cat(0, accept_sample))
                    # The value of this flag is discarded, so it doesn't matter what it is.
                    m.d.sync += last_sample.eq(Cat(0, last_sample))
                m.next = "X_DAC_Write"

            with m.State("X_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_x_code_transformed),
                    self.bus.data_oe.eq(1),
                ]
                m.next = "X_DAC_Write_2"

            with m.State("X_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_x_code_transformed),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_x_le_clk.eq(1),
                ]
                m.next = "Y_DAC_Write"

            with m.State("Y_DAC_Write"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_y_code_transformed),
                    self.bus.data_oe.eq(1),
                ]
                m.next = "Y_DAC_Write_2"

            with m.State("Y_DAC_Write_2"):
                m.d.comb += [
                    self.bus.data_o.eq(self.dac_y_code_transformed),
                    self.bus.data_oe.eq(1),
                    self.bus.dac_y_le_clk.eq(1),
                ]
                m.next = "ADC_Wait"

        return m
