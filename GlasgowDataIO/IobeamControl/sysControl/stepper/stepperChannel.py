from amaranth import *

class StepperChannel(Elaboratable):
    def __init__(self, pulse_high_us=2):
        # Inputs
        self.en = Signal(reset=0)
        self.run = Signal(reset=0)
        self.dir_in = Signal(reset=0)
        self.steps_in = Signal(32)
        self.period = Signal(32)

        # Outputs
        self.pulse = Signal(reset=0)
        self.dir_out = Signal(reset=0)

        self.pulse_high_us = pulse_high_us

    def elaborate(self, platform):
        m = Module()

        counter = Signal(32, reset=0)
        pulse_timer = Signal(32, reset=0)
        step_count = Signal(32, reset=0)
        pulse_active = Signal(reset=0)

        # Copy dir_in to dir_out when enabled
        with m.If(self.en):
            m.d.sync += self.dir_out.eq(self.dir_in)

            # Latch steps when run goes high
            with m.If(self.run & ~pulse_active):
                m.d.sync += step_count.eq(self.steps_in)

            # Generate pulses
            with m.If(step_count > 0):
                with m.If(~pulse_active):
                    m.d.sync += [
                        pulse_active.eq(1),
                        pulse_timer.eq(self.pulse_high_us),
                        counter.eq(self.period),
                        self.pulse.eq(1),
                        step_count.eq(step_count - 1),
                    ]
                with m.Else():
                    with m.If(counter > 0):
                        m.d.sync += counter.eq(counter - 1)
                    with m.Else():
                        m.d.sync += pulse_active.eq(0)
                    with m.If(pulse_timer > 0):
                        m.d.sync += pulse_timer.eq(pulse_timer - 1)
                    with m.Else():
                        m.d.sync += self.pulse.eq(0)
            with m.Else():
                m.d.sync += self.pulse.eq(0)
        with m.Else():
            m.d.sync += self.pulse.eq(0)
            m.d.sync += step_count.eq(0)

        return m
