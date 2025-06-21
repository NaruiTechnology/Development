from amaranth import *
from glasgow.gateware.registers import RegisterInterface

class PWMDAC(Elaboratable):
    def __init__(self):
        self.value = Signal(8)
        self.resolution = Signal(4)
        self.out = Signal()

    def elaborate(self, platform):
        m = Module()
        counter = Signal(8)
        pwm_masked = Signal(8)
        m.d.comb += pwm_masked.eq(self.value >> (8 - self.resolution))
        with m.If(counter < pwm_masked):
            m.d.sync += self.out.eq(1)
        with m.Else():
            m.d.sync += self.out.eq(0)
        m.d.sync += counter.eq(counter + 1)
        return m

    def register_interface(self, bus):
        return [
            bus.rw(0x00, self.value, description="PWM DAC duty value (8-bit)"),
            bus.rw(0x01, self.resolution, description="PWM resolution (1–8 bits)")
        ]
