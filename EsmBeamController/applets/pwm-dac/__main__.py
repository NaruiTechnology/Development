from glasgow.applet import GlasgowApplet
from BeamScanner.gatware import DualPWMDAC

class PWMDACApplet(GlasgowApplet):
    # logger = GlasgowApplet.logger

    @classmethod
    def add_build_arguments(cls, parser):
        parser.add_argument("--bit-width", type=int, default=8)

    def build(self, target, args):
        bit_width = args.bit_width
        pads = target.request("io", 2)  # 2 IO lines: x and y PWM
        dac = DualPWMDAC(pads=pads, bit_width=bit_width)
        return dac

    def run(self, device, args):
        # TODO: self.logger.info("PWM DAC applet does not support host-side interaction yet.")
        raise NotImplementedError("PWM DAC applet does not support host-side interaction yet.")
