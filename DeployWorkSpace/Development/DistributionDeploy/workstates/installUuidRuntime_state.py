#-------------------------------------------------------------------------------
# installUuidRuntime_state.py
#
# Install uuid-runtime via apt. Pure template state.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class installUuidRuntime_state(executeShellCommand_state):
    def __init__(self, parent):
        super(installUuidRuntime_state, self).__init__(parent)
