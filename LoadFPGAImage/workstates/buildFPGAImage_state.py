import asyncio
import os
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts
#from .loadFpgaImage_state import loadFpgaImage_state
from .executeCommandLine_state import executeCommandLine_state
from .asyncioCommand_state import asyncioCommand_state

""" class buildFPGAImage_state(loadFpgaImage_state):
    def __init__(self,  parent):
        super(buildFPGAImage_state, self).__init__(parent)

    @overrides(loadFpgaImage_state)
    async def DoWork(self):
        topJson = "top.json"
        topV = "top.v"
        try:
            stateConfig = self.ParentWorkThread.GetStateCongig(self)
            if stateConfig is not None and Consts.ACTION_DATA in stateConfig:
                cmd = self.formatCommand(stateConfig)
                if os.path.isfile(os.path.join(self.ParentWorkThread.fpgaBuildPlan.buildDir, topJson)) and os.path.isfile(os.path.join(self.ParentWorkThread.fpgaBuildPlan.buildDir, topV)):
                    await asyncio.wait_for(
                    self.runCommand(cmd),
                    timeout=stateConfig[Consts.TIMEOUT]
                    )
                    self.Success = True
                    print("Build FPGA image successfully.")
        except Exception as e:
            print(f"Build FPGA image failed with error: {e}")
            self.Success = False                 """

class buildFPGAImage_state(asyncioCommand_state):
    def __init__(self,  parent):
        super(buildFPGAImage_state, self).__init__(parent)