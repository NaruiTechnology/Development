"""
IobeamControl/applet/fakeAdcSimulator.py
========================================

A gateware module that stands in for the missing IobeamTech analog board.

Architecture
------------
There is nothing to invent on the strobe side: BusController already
generates all six bus strobes (adc_clk, adc_le_clk, adc_oe, dac_clk,
dac_x_le_clk, dac_y_le_clk) as part of its FSM. They sequence the
DAC-write and ADC-read phases, and they keep doing that whether or not
their outputs are wired to physical pads.

What's missing on a sub-target-less Glasgow is the *response*: the ADC
chip that would otherwise drive `bus.data_i` with a 14-bit sample value
synced to those strobes. FakeAdcSimulator provides that response.

It works in two stages, designed to slot into the existing loopback path:

    1. FakeAdcSimulator (this module) watches the live (x14, y14) DAC
       codes flowing out of the Supersampler and looks up an 8-bit
       grayscale sample from a small block-RAM image. The 8-bit value is
       expanded to 14 bits (left-shift 6) and presented as
       `loopback_value`.

    2. PipelinedLoopbackAdapter (existing, applet/pipelinedLoopbackAdapter.py)
       takes that 14-bit `loopback_value`, latches it on adc_oe falling
       edges, and shifts it through an `adc_latency`-deep pipeline before
       presenting it on `bus.data_i`. This faithfully reproduces the
       latency of the real ADC + latch chain that the rest of the design
       was timed against.

So FakeAdcSimulator is a *value source* for the existing loopback adapter,
not a replacement for it. The PipelinedLoopbackAdapter still owns the
strobe-aware pipeline.

Image source
------------
The image is baked into block RAM at synthesis time. The host loads a
PNG/BMP (or generates random data) via applet/imageSource.py, hands a
flat list of N*N 8-bit values to this module's __init__, and the
synthesised bitstream contains that data as the BRAM init pattern.

Resolution defaults to 64x64 (4 KiB = 8 SB_RAM40_4K blocks at 8-bit
width), well within the iCE40-HX8K BRAM budget. The 14-bit DAC codes
are decimated by `14 - log2(image_resolution)` bits before addressing
the ROM, so any scan resolution maps cleanly: a 64x64 scan reads each
pixel 1:1; a 1024x1024 scan upsamples each ROM pixel into a 16x16 tile.

Timing notes
------------
The Memory's read port is synchronous (1 cycle from addr to data). That
extra cycle is absorbed into PipelinedLoopbackAdapter's existing
adc_latency-deep shift register: instead of the ROM word being latched
as the loopback value at adc_oe falling, the value latched is "the ROM
word that was addressed one cycle earlier", which is fine because we
keep the address combinational from super_dac_stream.payload. The
1-cycle skew shows up as one extra cycle of effective ADC latency,
which the BusController FSM tolerates (skid_buffer.depth ==
adc_latency, so the buffer absorbs the offset).
"""

from amaranth import *
from amaranth.lib import wiring, memory
from amaranth.lib.wiring import In, Out


class FakeAdcSimulator(wiring.Component):
    """
    Provide a 14-bit fake-ADC value derived from a baked-in image,
    indexed by the live super_dac_stream coordinates.

    Parameters
    ----------
    image_data : list[int]
        Length must equal image_resolution * image_resolution. Each
        entry is an 8-bit unsigned (0..255) grayscale sample. The host
        helper imageSource.load_image() / imageSource.random_image()
        produces this list.
    image_resolution : int
        Size of one side of the (square) image. Must be a power of two
        in the range [16, 256]. Default 64 keeps BRAM use modest.

    Ports
    -----
    dac_x_code : In(14)
        X coord of the pixel currently being scanned. Drive from
        executor.supersampler.super_dac_stream.payload.dac_x_code.
    dac_y_code : In(14)
        Y coord. Drive from .dac_y_code.
    loopback_value : Out(14)
        14-bit sample to feed PipelinedLoopbackAdapter.loopback_stream.
        High 8 bits = image pixel value; low 6 bits = 0.
    """

    dac_x_code:     In(14)
    dac_y_code:     In(14)
    loopback_value: Out(14)

    def __init__(self, *, image_data, image_resolution=64):
        if not (image_resolution & (image_resolution - 1) == 0
                and 16 <= image_resolution <= 256):
            raise ValueError(
                f"image_resolution must be a power of two in [16, 256], "
                f"got {image_resolution}")
        if len(image_data) != image_resolution * image_resolution:
            raise ValueError(
                f"image_data length {len(image_data)} doesn't match "
                f"{image_resolution}x{image_resolution} = "
                f"{image_resolution * image_resolution}")
        # Defensive: clip to 8 bits in case caller passed e.g. uint16.
        self._image_data = [int(v) & 0xff for v in image_data]
        self._image_resolution = image_resolution
        self._addr_bits = (image_resolution - 1).bit_length()  # log2(res)
        # Number of high bits of the 14-bit DAC code that index the ROM.
        # For a 64x64 image, top 6 of 14 -> each ROM pixel covers 256
        # consecutive DAC codes.
        self._shift = 14 - self._addr_bits
        super().__init__()

    def elaborate(self, platform):
        m = Module()

        depth = self._image_resolution * self._image_resolution

        # Block RAM, baked-in image.  Synchronous read.
        m.submodules.rom = rom = memory.Memory(
            shape=8, depth=depth, init=self._image_data)
        r_port = rom.read_port()

        # Decimate the 14-bit DAC codes into image-index bits.
        x_idx = Signal(self._addr_bits)
        y_idx = Signal(self._addr_bits)
        m.d.comb += [
            x_idx.eq(self.dac_x_code[self._shift:]),
            y_idx.eq(self.dac_y_code[self._shift:]),
        ]

        # Row-major flat address: y*W + x  (W = 1 << addr_bits).
        m.d.comb += r_port.addr.eq(Cat(x_idx, y_idx))
        m.d.comb += r_port.en.eq(1)

        # 8-bit pixel -> 14-bit ADC value (high-justified, low 6 bits 0).
        m.d.comb += self.loopback_value.eq(Cat(C(0, 6), r_port.data))

        return m
