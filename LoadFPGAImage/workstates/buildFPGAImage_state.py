import os
from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state

class buildFPGAImage_state(loadFpgaImage_state):
    def __init__(self,  parent):
        super(buildFPGAImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topJson = "top.json"
        topV = "top.v"
        synthIce40Cmd =  "synth_ice40 -top top -json {}".format(topJson)
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topJson)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topV)):
            await self.runCommand(self, "yosys -p {} {}".format(synthIce40Cmd, topV), self.parent.buildPlan.buildDir)