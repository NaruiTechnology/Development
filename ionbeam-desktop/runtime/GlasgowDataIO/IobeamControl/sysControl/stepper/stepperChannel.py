from amaranth import *

class StepperChannel(Elaboratable):
    def __init__(self, pulse_high_us=2):
        # Inputs
        self.en = Signal(reset=0)
        self.run = Signal(reset=0)
        self.start = Signal(reset=0)
        self.dir_in = Signal(reset=0)
        self.steps_in = Signal(32)
        self.period = Signal(32)

        # Outputs
        self.pulse = Signal(reset=0)
        self.dir_out = Signal(reset=0)
        self.en_out = Signal(reset=0)

        self.pulse_high_us = pulse_high_us

    def elaborate(self, platform):
        m = Module()

        period_timer = Signal(32, reset=0)
        pulse_timer = Signal(32, reset=0)
        steps_remaining = Signal(32, reset=0)

        m.d.comb += self.en_out.eq(self.en)

        with m.If(self.en):
            m.d.sync += self.dir_out.eq(self.dir_in)
            with m.If(self.start):
                m.d.sync += [
                    steps_remaining.eq(self.steps_in),
                    period_timer.eq(0),
                ]

            with m.If(pulse_timer > 0):
                m.d.sync += [
                    self.pulse.eq(1),
                    pulse_timer.eq(pulse_timer - 1),
                ]
            with m.Else():
                m.d.sync += self.pulse.eq(0)

            with m.If(period_timer > 0):
                m.d.sync += period_timer.eq(period_timer - 1)
            with m.Elif(~self.start & (self.run | (steps_remaining > 0))):
                m.d.sync += [
                    self.pulse.eq(1),
                    pulse_timer.eq(max(1, self.pulse_high_us) - 1),
                    period_timer.eq(Mux(self.period > 0, self.period - 1, 0)),
                ]
                with m.If(~self.run):
                    m.d.sync += steps_remaining.eq(steps_remaining - 1)
        with m.Else():
            m.d.sync += [
                self.pulse.eq(0),
                steps_remaining.eq(0),
                period_timer.eq(0),
                pulse_timer.eq(0),
            ]

        return m
