import asyncio

from EsmBeamController.Software.lib.glasgow.hardware.device import GlasgowDevice
from .loadFpgaImage_state import loadFpgaImage_state
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

class connectDevice_state(loadFpgaImage_state):
    def __init__(self, parent):
        super(connectDevice_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        #device = self.ParentWorkThread.device
        try:
            stateConfig = self.ParentWorkThread.GetStateCongig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                cmd = self.formatCommand(stateConfig)
                await asyncio.wait_for(
                #device.set_voltage("AB", voltage), 
                self.runCommand(cmd),
                timeout=stateConfig[Consts.TIMEOUT]
            )
            print("Hardware responded successfully.")
            self.Success = True 
                
        except Exception as e:
            print(f"Hardware error: {e}")
            self.Success = False