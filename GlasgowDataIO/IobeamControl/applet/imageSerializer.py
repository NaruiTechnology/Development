from amaranth import *
from amaranth.build import *
from amaranth.lib import wiring
from amaranth.lib.wiring import In, Out, flipped
from amaranth.build import *
from ..commands.structs import CmdType, BeamType, OutputMode, Transforms
from . import * 


class ImageSerializer(wiring.Component):
    img_stream: In(StreamSignature(unsigned(16)))
    usb_stream: Out(StreamSignature(8))
    output_mode: In(2)

    def elaborate(self, platform):
        m = Module()

        low = Signal(8)

        with m.FSM():
            with m.State("High"):
                with m.If(self.output_mode == OutputMode.NoOutput):
                    m.d.comb += self.img_stream.ready.eq(1) #consume and destroy image stream
                with m.Else():
                    m.d.comb += self.usb_stream.payload.eq(self.img_stream.payload[8:16])
                    m.d.comb += self.usb_stream.valid.eq(self.img_stream.valid)
                    m.d.comb += self.img_stream.ready.eq(self.usb_stream.ready)
                    with m.If(self.output_mode == OutputMode.SixteenBit):
                        m.d.sync += low.eq(self.img_stream.payload[0:8])
                        with m.If(self.usb_stream.ready & self.img_stream.valid):
                            m.next = "Low"
                    with m.If(self.output_mode == OutputMode.EightBit):
                        m.next = "High"

            with m.State("Low"):
                m.d.comb += self.usb_stream.payload.eq(low)
                m.d.comb += self.usb_stream.valid.eq(1)
                with m.If(self.usb_stream.ready):
                    m.next = "High"

        return m

