
from amaranth import *
from amaranth.build import *
from amaranth.lib.wiring import In, Out, flipped


class PowerOfTwoDetector(Elaboratable):
    """Priority encode requests to binary.

    If any bit in ``i`` is asserted, ``n`` is low and ``o`` indicates the least significant
    asserted bit.
    Otherwise, ``n`` is high and ``o`` is ``0``.

    Parameters
    ----------
    width : int
        Bit width of the input.

    Attributes
    ----------
    i : Signal(width), in
        Input requests.
    o : Signal(range(width)), out
        Encoded natural binary.
    n : Signal, out
        Invalid: no input bits are asserted.
    """
    def __init__(self, width):
        self.width = width

        self.i = Signal(width)
        self.o = Signal(range(width))
        self.n = Signal()
        self.p = Signal()

    def elaborate(self, platform):
        m = Module()
        p = Signal()
        for power in range(self.width):
            with m.If(self.i[power]):
                m.d.comb += self.o.eq(power)
            with m.If(self.i == 1 << power):
                m.d.comb += p.eq(1)
        m.d.comb += self.n.eq(self.i == 0)
        m.d.comb += self.p.eq(p & ~self.n)
        return m


