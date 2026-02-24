from .LoadFPGAState import LoadFPGAState
from Development.AutomationPy.buildingblocks.decorators import overrides
import os

class FlashImageState(LoadFPGAState):
    def __init__(self, parent):
        self._buildPlan = None
        super(FlashImageState, self).__init__(parent)

    @overrides(LoadFPGAState)
    async def DoWork(self):
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)):
            await self.runCommand(self, "glasgow run program-ice40-sram {}".format(topBin), self.parent.buildPlan.buildDir)