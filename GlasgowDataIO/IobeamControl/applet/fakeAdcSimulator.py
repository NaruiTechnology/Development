"""
fakeAdcSimulator.py  v9  (ROM-based combinatorial Elaboratable)

Root-cause fix
--------------
v7/v8 used a Python yield-loop process that wrote to adc_out_signal every
`dwell` clock cycles.  That process is fully decoupled from the BusController
ADC timing, so the sample latched at each adc_oe edge is from several
pixels in the future, producing the characteristic diagonal-skew artefact.

v9 replaces the process with a combinatorial ROM Elaboratable.  The
loopback_value output is driven continuously from the live DAC codes, and the
PipelinedLoopbackAdapter samples it on the exact adc_oe rising edge in sync
with the BusController, giving zero skew by construction.

Interface (matches iobeamDataSubtarget.py hard-wiring)
-------------------------------------------------------
    m.submodules.fake_adc = fake_adc = FakeAdcSimulator(
        image_data        = self.sim_image,
        image_resolution  = self.sim_image_resolution,
    )
    m.d.comb += [
        fake_adc.dac_x_code.eq(executor.supersampler.super_dac_stream.payload.dac_x_code),
        fake_adc.dac_y_code.eq(executor.supersampler.super_dac_stream.payload.dac_y_code),
        loopback_adapter.loopback_stream.eq(fake_adc.loopback_value),
    ]

ROM layout
----------
    shift     = 14 - log2(N)          # maps 14-bit DAC code to N-pixel index
    x_idx     = dac_x_code >> shift   # 0 .. N-1
    y_idx     = dac_y_code >> shift   # 0 .. N-1
    addr      = Cat(x_idx, y_idx)     # = y_idx*N + x_idx  (row-major)
    rom[addr] = image_data[addr] * 64 # scale 8-bit to 14-bit
"""

from amaranth import *
from amaranth.lib import wiring
from amaranth.lib.wiring import In, Out


class FakeAdcSimulator(wiring.Component):
    """
    Combinatorial ROM-based simulated ADC for Amaranth hardware simulations.

    Parameters
    ----------
    image_data : list[int]
        Flat 1-D list of 8-bit pixel values (0-255), row-major:
        image_data[y * image_resolution + x].
    image_resolution : int
        Side length N of the square image (power of 2, 2 <= N <= 16384).

    Ports
    -----
    dac_x_code    : In(14)   current X DAC code from supersampler
    dac_y_code    : In(14)   current Y DAC code from supersampler
    loopback_value : Out(14)  ADC sample value (purely combinatorial)
    """

    DAC_BITS: int = 14
    ADC_BITS: int = 14

    dac_x_code:     In(14)   # type: ignore
    dac_y_code:     In(14)   # type: ignore
    loopback_value: Out(14)  # type: ignore

    def __init__(self, *, image_data: list, image_resolution: int):
        N = image_resolution
        if N < 2 or N > (1 << self.DAC_BITS) or (N & (N - 1)) != 0:
            raise ValueError(
                f"image_resolution must be a power of 2 in [2, {1 << self.DAC_BITS}], got {N}"
            )
        expected = N * N
        if len(image_data) != expected:
            raise ValueError(
                f"image_data length {len(image_data)} != {N}x{N}={expected}"
            )

        self._N     = N
        self._bits  = (N - 1).bit_length()          # index width (e.g. 6 for N=64)
        self._shift = self.DAC_BITS - self._bits    # e.g. 8 for N=64

        # Scale 8-bit values to 14-bit ADC range (0-255 -> 0-16320)
        self._rom = [min(int(v) * 64, (1 << self.ADC_BITS) - 1) for v in image_data]

        super().__init__()

    def elaborate(self, platform) -> Module:
        m = Module()

        bits  = self._bits
        shift = self._shift
        N     = self._N

        x_idx = Signal(bits, name="x_idx")
        y_idx = Signal(bits, name="y_idx")
        addr  = Signal(range(N * N), name="rom_addr")

        m.d.comb += [
            x_idx.eq(self.dac_x_code >> shift),
            y_idx.eq(self.dac_y_code >> shift),
            # Cat(x_idx, y_idx) => addr = y_idx * N + x_idx  (row-major)
            addr.eq(Cat(x_idx, y_idx)),
        ]

        rom = Array(Const(v, self.ADC_BITS) for v in self._rom)
        m.d.comb += self.loopback_value.eq(rom[addr])

        return m
