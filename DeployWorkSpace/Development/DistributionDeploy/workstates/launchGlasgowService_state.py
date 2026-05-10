#-------------------------------------------------------------------------------
# launchGlasgowService_state.py
#
# Launch the glasgow uvicorn service in its own shell/session.
# A small post-launch sleep is performed by verifyGlasgowService_state.
#-------------------------------------------------------------------------------
from .longRunShellLaunch_state import longRunShellLaunch_state


class launchGlasgowService_state(longRunShellLaunch_state):
    def __init__(self, parent):
        super(launchGlasgowService_state, self).__init__(parent)
