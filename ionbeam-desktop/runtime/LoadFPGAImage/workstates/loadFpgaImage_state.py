from abc import abstractmethod
from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.workflow.workstate import WorkState

@abstractmethod
class loadFpgaImage_state(WorkState):
    def __init__(self, parent):
        super(loadFpgaImage_state, self).__init__(parent)
    
    @overrides(WorkState)
    def formatCommand(self, stateConfig):
        cmd = super(loadFpgaImage_state, self).formatCommand(stateConfig)
        return cmd.replace("glasgow", f"glasgow --serial {self.ParentWorkThread.device.serial}")