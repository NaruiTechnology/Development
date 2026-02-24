import os
from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state

class generateFullImage_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(generateFullImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topAsc = "top.asc"
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topAsc))    :
            await self.runCommand(self, "icepack {} {}".format(topAsc, topBin), self.parent.buildPlan.buildDir)