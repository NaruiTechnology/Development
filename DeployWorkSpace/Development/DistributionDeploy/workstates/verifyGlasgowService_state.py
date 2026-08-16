#-------------------------------------------------------------------------------
# verifyGlasgowService_state.py
#
# Template-driven Windows service-log verification state. Configure a
# PowerShell commandFormat when this optional action is enabled.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class verifyGlasgowService_state(executeShellCommand_state):
    def __init__(self, parent):
        super(verifyGlasgowService_state, self).__init__(parent)
