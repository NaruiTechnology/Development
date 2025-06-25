from amaranth import *
# TODO from glasgow.gateware.pads import Pads
from glasgow.applet import GlasgowApplet

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
    
class DualPWMDAC(Elaboratable):
    # TODO: def __init__(self, pads: Pads, bit_width=8):
    def __init__(self, bit_width=8):
        self.input_x = Signal(bit_width)
        self.input_y = Signal(bit_width)
        self.pwm_x = Signal()
        self.pwm_y = Signal()
        self.bit_width = bit_width
        self.pads = pads

    def elaborate(self, platform):
        m = Module()

        counter = Signal(self.bit_width)
        m.d.sync += counter.eq(counter + 1)

        m.d.comb += [
            self.pwm_x.eq(counter < self.input_x),
            self.pwm_y.eq(counter < self.input_y),
            self.pads.io[0].o.eq(self.pwm_x),
            self.pads.io[1].o.eq(self.pwm_y),
        ]

        return m

class PWMDACApplet(GlasgowApplet):
    # logger = GlasgowApplet.logger

    @classmethod
    def add_build_arguments(cls, parser):
        parser.add_argument("--bit-width", type=int, default=8,
                            help="PWM resolution in bits")

    @classmethod
    def add_run_arguments(cls, parser):
        parser.add_argument("--interactive", action="store_true",
                            help="Enable USB streaming interaction")

    def build(self, target, args):
        pads = target.request("io", 2)
        self.dac = DualPWMDAC(pads=pads, bit_width=args.bit_width)
        return self.dac

    def prepare(self, device, args):
        self.device = device
        self.bit_width = args.bit_width
        self.args = args

    async def run(self):
        if self.args.interactive:
            await self.interact()
        else:
            # self.logger.info("PWM DAC applet running in passive mode.")
            print("PWM DAC applet running in passive mode.")
            # In passive mode, we just wait for interrupts and do nothing
            while True:
                await self.device.wait_for_interrupt()

    async def interact(self):
        self.logger.info("Interactive mode: streaming PWM values over USB")
        while True:
            data = await self.device.read(2)
            x_val = data[0]
            y_val = data[1]
            self.logger.debug(f"Received X={x_val} Y={y_val}")
            self.device.set_gpio("port-a", x_val)
            self.device.set_gpio("port-b", y_val)
            self.device.flush()
    

