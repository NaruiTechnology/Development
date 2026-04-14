from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from dataclasses import dataclass

iobeam_resources  = [
    Resource("control", 0,
        Subsignal("d_clock", Pins("F3", dir="o", invert=True)), # D23
        #Subsignal("a_clock", Pins("G1", dir="o", invert=True)), # D24
        Attrs(IO_STANDARD="SB_LVCMOS33")
    ),

    Resource("data", 0, Pins("", dir="io"), #  Pins("B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2"
        Attrs(IO_STANDARD="SB_LVCMOS33")
    ),
]

BusSignature = wiring.Signature({
    "adc_clk":  Out(1),
    "adc_le_clk":   Out(1),
    "adc_oe":   Out(1),

    "dac_clk":  Out(1),
    "dac_x_le_clk": Out(1),
    "dac_y_le_clk": Out(1),

    "data_i":   In(15),
    "data_o":   Out(15),
    "data_oe":  Out(1),
})

def StreamSignature(data_layout):
    return wiring.Signature({
        "payload":  Out(data_layout),
        "valid": Out(1),
        "ready": In(1)
    })

@dataclass
class BIG_ENDIAN:
    xflip: bool
    yflip: bool
    rotate90: bool

class BlankRequest(data.Struct):
    enable: 1
    request: 1

class DACStream(data.Struct):
    dac_x_code: 14
    padding_x: 2
    dac_y_code: 14
    padding_x: 2
    dwell_time: 16
    blank: BlankRequest
    delay: 3


class SuperDACStream(data.Struct):
    dac_x_code: 14
    padding_x: 2
    dac_y_code: 14
    padding_y: 2
    blank: BlankRequest
    last:       1
    delay: 3

class RasterRegion(data.Struct):
    x_start: 14 # UQ(14,0)
    padding_x_start: 2
    x_count: 14 # UQ(14,0)
    padding_x_count: 2
    x_step:  16 # UQ(8,8)
    y_start: 14 # UQ(14,0)
    padding_y_start: 2
    y_count: 14 # UQ(14,0)
    padding_y_count: 2
    y_step:  16 # UQ(8,8)