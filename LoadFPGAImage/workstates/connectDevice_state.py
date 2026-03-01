from .executeCommandLine_state import executeCommandLine_state

class connectDevice_state(executeCommandLine_state):
    def __init__(self, parent):
        super(connectDevice_state, self).__init__(parent)
