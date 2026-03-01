import os
from AutomationPy.buildingblocks.decorators import overrides
from .loadFpgaImage_state import loadFpgaImage_state
from .executeCommandLine_state import executeCommandLine_state
from .asyncioCommand_state import asyncioCommand_state

""" class flashImage_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(flashImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)):
            await self.runCommand(self, "glasgow run program-ice40-sram {}".format(topBin), self.parent.buildPlan.buildDir)

 """
class flashImage_state(asyncioCommand_state):
    def __init__(self, parent):
        super(flashImage_state, self).__init__(parent)            