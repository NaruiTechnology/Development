
import os
from types import SimpleNamespace

from AutomationPy.buildingblocks.decorators import overrides
from EsmBeamController.Software.configs import applet
from EsmBeamController.Software.lib.glasgow.hardware.multiplexer import DirectMultiplexer
from EsmBeamController.Software.lib.glasgow.hardware.target import GlasgowHardwareTarget
from .loadFpgaImage_state import loadFpgaImage_state

class buildFPGAPlan_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(buildFPGAPlan_state, self).__init__(parent)


    @property
    def buildPlan(self):
        return self._buildPlan

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        args = SimpleNamespace(
            port="A",
            x_pins=[f"{self.port}0"], # PinArgument(0)
            y_pins=[f"{self.port}1"], # PinArgument(1)
            operation="run",
            loopback = True,
            out_only = False,
            xflip = False, 
            yflip = False, 
            rotate90 = False,
            ext_switch_delay = 0.5,
            benchmark = True           
        )
        target = GlasgowHardwareTarget(revision=self.device.revision, multiplexer_cls=DirectMultiplexer)
        self.iface = applet.build(target, args)
        self.device.demultiplexer = target.multiplexer
        plan = target.build_plan()
        if plan is not None and os.path.exists(os.path.join(plan, "top.v")):
            self.parent.fpgaBuildPlan = plan