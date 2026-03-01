from abc import abstractmethod
from amaranth import Const
from AutomationPy.buildingblocks.workflow.workstate import WorkState

@abstractmethod
class loadFpgaImage_state(WorkState):
    def __init__(self, parent):
        self._last_output = ""
        super(loadFpgaImage_state, self).__init__(parent)
    
    @property
    def last_output(self):
         return self._last_output
    
    def __str__(self):
        return self._last_output
    