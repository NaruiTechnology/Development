
from .executeShellCommand_state import executeShellCommand_state


class installPostgreSQL_state(executeShellCommand_state):
    def __init__(self, parent):
        super(installPostgreSQL_state, self).__init__(parent)
