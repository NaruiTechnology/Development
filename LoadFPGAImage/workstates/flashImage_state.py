import os
from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state

class flashImage_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(flashImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)):
            await self.runCommand(self, "glasgow run program-ice40-sram {}".format(topBin), self.parent.buildPlan.buildDir)