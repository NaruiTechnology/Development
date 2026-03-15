import asyncio
from .loadFpgaImage_state import loadFpgaImage_state
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

class asyncioCommand_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(asyncioCommand_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig: # and self.ParentWorkThread.fpgaBuildPlan is not None:
                cmd = self.formatCommand(stateConfig)
                self._success = await self.commandAsyncio(cmd, self.ParentWorkThread.fpgaBuildPlan.buildDir)
                if self._success is True:
                    print(f"DoWord - {type(self).__name__} successfully.")
        except Exception as e:
            print(f"DoWord - {type(self).__name__} error: {e}")
            self.Success = False