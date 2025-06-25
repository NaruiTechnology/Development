from amaranth import *
from glasgow.gateware.pwm_dac import DualPWMDAC
from glasgow.applet import GlasgowApplet
# from amaranth import Elaboratable

class PWMDACApplet(GlasgowApplet, Elaboratable):
    def __init__(self, device, args):
        self.bit_width = int(args.get("bit_width", 8))
        self.device = device

    @classmethod
    def add_arguments(cls, parser):
        parser.add_argument("--bit-width", type=int, default=8)

    def elaborate(self, platform):
        m = Module()
        self.dac = DualPWMDAC(bit_width=self.bit_width)
        m.submodules.dac = self.dac

        platform.request("gpio-a", 0).o.eq(self.dac.pwm_x)
        platform.request("gpio-b", 0).o.eq(self.dac.pwm_y)

        return m

    async def run(self):
        while True:
            await self.device.wait_for_interrupt()
