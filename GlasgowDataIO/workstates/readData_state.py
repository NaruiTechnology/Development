from AutomationPy.buildingblocks.workflow.workstate import WorkState

class readData_state(WorkState):
    def __init__(self, parent, data=None):
        super(readData_state, self).__init__(parent)
        self._data = data