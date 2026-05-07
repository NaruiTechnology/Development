#-------------------------------------------------------------------------------
# launchGlasgowService_state.py
#
# Launch the glasgow uvicorn service in its own shell/session.
# A small post-launch sleep is performed by verifyGlasgowService_state.
#-------------------------------------------------------------------------------
from .detachedShellLaunch_state import detachedShellLaunch_state


class launchGlasgowService_state(detachedShellLaunch_state):
    def __init__(self, parent):
        super(launchGlasgowService_state, self).__init__(parent)
