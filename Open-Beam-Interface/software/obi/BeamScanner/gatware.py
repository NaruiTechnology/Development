from amaranth import *

class Gatware(Elaboratable):
    def __init__(self, bit_width=8):
        self.x = Signal(bit_width)
        self.y = Signal(bit_width)
        self.enable = Signal()
        self.done = Signal()
        self.dwell_time = Signal(16)

        self.x_start = Signal(bit_width)
        self.y_start = Signal(bit_width)
        self.x_range = Signal(bit_width)
        self.y_range = Signal(bit_width)
        self.step = Signal(bit_width)

    def elaborate(self, platform):
        m = Module()

        x = Signal.like(self.x)
        y = Signal.like(self.y)
        dwell_counter = Signal(16)

        with m.If(self.enable):
            with m.If(dwell_counter < self.dwell_time):
                m.d.sync += dwell_counter.eq(dwell_counter + 1)
            with m.Else():
                m.d.sync += dwell_counter.eq(0)
                with m.If(x < self.x_start + self.x_range - self.step):
                    m.d.sync += x.eq(x + self.step)
                with m.Else():
                    m.d.sync += x.eq(self.x_start)
                    with m.If(y < self.y_start + self.y_range - self.step):
                        m.d.sync += y.eq(y + self.step)
                    with m.Else():
                        m.d.sync += y.eq(self.y_start)
                        m.d.sync += self.done.eq(1)

        m.d.sync += [
            self.x.eq(x),
            self.y.eq(y)
        ]

        return m
