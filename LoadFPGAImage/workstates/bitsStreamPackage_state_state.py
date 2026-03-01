import asyncio
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
from .loadFpgaImage_state import loadFpgaImage_state

class generateFullImage_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(generateFullImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        """ topAsc = "top.asc"
        topBin = "top.bin"
        if os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topBin)) and os.path.isfile(os.path.join(self.parent.buildPlan.buildDir, topAsc))    :
            await self.runCommand(self, "icepack {} {}".format(topAsc, topBin), self.parent.buildPlan.buildDir) """
        try:
            stateConfig = self.ParentWorkThread.GetStateCongig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                cmd = self.formatCommand(stateConfig)
                await asyncio.wait_for(
                self.runCommand(cmd),
                timeout=stateConfig[Consts.TIMEOUT]
                )
                print("Hardware responded successfully.")
                self.Success = True 
                
        except Exception as e:
            print(f"Generate full image failed,  error: {e}")
            self.Success = False