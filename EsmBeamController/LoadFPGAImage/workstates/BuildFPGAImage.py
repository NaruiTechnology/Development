from .LoadFPGAState import LoadFPGAState
from Development.AutomationPy.buildingblocks.decorators import overrides
import os

class BuildFPGAImageState(LoadFPGAState):
    def __init__(self, parent):
        self._buildPlan = None
        super(BuildFPGAImageState, self).__init__(parent)

    @overrides(LoadFPGAState)
    async def DoWork(self):
        topJson = "top.json"
        topV = "top.v"
        synthIce40Cmd =  "synth_ice40 -top top -json {}".format(topJson)
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topJson)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topV)):
            await self.runCommand(self, "yosys -p {} {}".format(synthIce40Cmd, topV), self.parent.buildPlan.buildDir)