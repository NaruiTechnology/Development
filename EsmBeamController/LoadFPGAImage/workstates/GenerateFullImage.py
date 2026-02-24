from .LoadFPGAState import LoadFPGAState
from Development.AutomationPy.buildingblocks.decorators import overrides
import os

class GenerateFullImageState(LoadFPGAState):
    def __init__(self, parent):
        self._buildPlan = None
        super(GenerateFullImageState, self).__init__(parent)

    @overrides(LoadFPGAState)
    async def DoWork(self):
        topAsc = "top.asc"
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topAsc))    :
            await self.runCommand(self, "icepack {} {}".format(topAsc, topBin), self.parent.buildPlan.buildDir)