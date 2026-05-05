#-------------------------------------------------------------------------------
# setupVirtualEnv_state.py
#
# Create the project virtualenv at <DeployRoot>/.venv and bootstrap pip.
# Pure template state.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class setupVirtualEnv_state(executeShellCommand_state):
    def __init__(self, parent):
        super(setupVirtualEnv_state, self).__init__(parent)
