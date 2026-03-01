import asyncio
from .loadFpgaImage_state import loadFpgaImage_state
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

class executeCommandLine_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(executeCommandLine_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateCongig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                cmd = self.formatCommand(stateConfig)
                await asyncio.wait_for(
                self.runCommand(cmd),
                timeout=stateConfig[Consts.TIMEOUT]
            )
            print(f"DoWord - {type(self).__name__} successfully.")
            self.Success = True 
                
        except Exception as e:
            print(f"DoWord - {type(self).__name__} error: {e}")
            self.Success = False