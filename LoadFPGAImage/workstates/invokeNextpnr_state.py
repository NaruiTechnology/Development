import os
from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state

class invokeNextpnr_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(invokeNextpnr_state, self).__init__(parent)   

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topJson = "top.json"
        topPcf= "top.pcf"
        topAsc = "top.asc"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topJson)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topPcf)):
            # await self.runCommand(self, "nextpnr-ice40 --hx1k --package tq144 --json {} --pcf {} --asc {}".format(topJson, topPcf, topAsc), self.parent.buildPlan.buildDir)
            await self.runCommand(self, "nextpnr-ice40 --hx8k --package tq144 --json {} --pcf {} --asc {}".format(topJson, topPcf, topAsc), self.parent.buildPlan.buildDir)