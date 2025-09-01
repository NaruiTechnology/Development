from amaranth import *
from amaranth.lib import enum, io, wiring

from .stepperChannel import StepperChannel

class ControlStepperSubtarget(Elaboratable):
    class Command(enum.Enum):
        Disable         = 0x00
        Enable          = 0x01
        SetDirection    = 0x02   # payload: 1 byte (0/1)
        SetPeriodUS     = 0x03   # payload: 2 bytes (u16, µs; clamp to >=1)
        RunSteps        = 0x04   # payload: 4 bytes (u32, number of steps)
        RunContinuous   = 0x05   # payload: 1 byte (0/1)

    def __init__(self, ports, out_fifo):
        self.ports    = ports
        self.out_fifo = out_fifo

    def elaborate(self, platform):
        m = Module()
        m.submodules.chan = chan = StepperChannel(pulse_high_us=5)

        # Bind outputs
        m.submodules.step_buf = step_buf = io.Buffer("o", self.ports.step)
        m.submodules.dir_buf  = dir_buf  = io.Buffer("o", self.ports.dir)
        m.submodules.en_buf   = en_buf   = io.Buffer("o", self.ports.en)

        m.d.comb += [
            step_buf.o.eq(chan.step),
            dir_buf.o.eq(chan.dir),
            en_buf.o.eq(chan.en_o),
        ]

        command = Signal(self.Command)
        byte0   = Signal.like(self.out_fifo.r_data)
        byte1   = Signal.like(self.out_fifo.r_data)
        byte2   = Signal.like(self.out_fifo.r_data)
        byte3   = Signal.like(self.out_fifo.r_data)

        # Local registers for channel control (latched into StepperChannel internally)
        en       = Signal(reset=0)
        run      = Signal(reset=0)
        direction= Signal(reset=0)
        period   = Signal(range(1_000_000), reset=1000) # default 1000 µs (1 kHz stepping)
        steps    = Signal(32, reset=0)

        # Connect control lines
        m.d.comb += [
            chan.en.eq(en),
            chan.run.eq(run),
            chan.dir_in.eq(direction),
            chan.period.eq(period),
            chan.steps_in.eq(steps),
        ]

        def fifo_read_then(next_state):
            m.d.comb += self.out_fifo.r_en.eq(1)
            with m.If(self.out_fifo.r_rdy):
                m.d.sync += byte0.eq(self.out_fifo.r_data)
                m.next = next_state

        with m.FSM(name="stepper"):
            with m.State("ReadCommand"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += command.eq(self.out_fifo.r_data)
                    m.next = "HandleCommand"

            with m.State("HandleCommand"):
                with m.If(command == self.Command.Disable):
                    m.d.sync += en.eq(0)
                    m.next = "ReadCommand"

                with m.Elif(command == self.Command.Enable):
                    m.d.sync += en.eq(1)
                    m.next = "ReadCommand"

                with m.Elif(command == self.Command.SetDirection):
                    # read 1 byte
                    m.next = "ReadDir"

                with m.Elif(command == self.Command.SetPeriodUS):
                    # read 2 bytes (u16)
                    m.next = "ReadPeriodL"

                with m.Elif(command == self.Command.RunSteps):
                    # read 4 bytes (u32)
                    m.next = "ReadSteps0"

                with m.Elif(command == self.Command.RunContinuous):
                    # read 1 byte
                    m.next = "ReadRunFlag"

                with m.Else():
                    # unknown -> ignore and continue
                    m.next = "ReadCommand"

            # Direction
            with m.State("ReadDir"):
                fifo_read_then("ApplyDir")
            with m.State("ApplyDir"):
                m.d.sync += direction.eq(byte0[0])
                m.next = "ReadCommand"

            # Period (u16 little-endian, clamp to >=1)
            with m.State("ReadPeriodL"):
                fifo_read_then("ReadPeriodH")
            with m.State("ReadPeriodH"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += [
                        byte1.eq(self.out_fifo.r_data),
                        period.eq(Mux(Cat(byte0, self.out_fifo.r_data) == 0, 1, Cat(byte0, self.out_fifo.r_data)))
                    ]
                    m.next = "ReadCommand"

            # Steps (u32 little-endian)
            with m.State("ReadSteps0"):
                fifo_read_then("ReadSteps1")
            with m.State("ReadSteps1"):
                fifo_read_then("ReadSteps2")
            with m.State("ReadSteps2"):
                fifo_read_then("ReadSteps3")
            with m.State("ReadSteps3"):
                m.d.comb += self.out_fifo.r_en.eq(1)
                with m.If(self.out_fifo.r_rdy):
                    m.d.sync += [
                        byte3.eq(self.out_fifo.r_data),
                        steps.eq(Cat(byte0, byte1, byte2, self.out_fifo.r_data)),
                        run.eq(0),        # finite move
                        en.eq(1),         # ensure enabled
                    ]
                    m.next = "ReadCommand"

            # Run continuous flag
            with m.State("ReadRunFlag"):
                fifo_read_then("ApplyRunFlag")
            with m.State("ApplyRunFlag"):
                m.d.sync += [
                    run.eq(byte0[0]),
                    en.eq(1),
                ]
                m.next = "ReadCommand"

        return m
