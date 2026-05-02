#-------------------------------------------------------------------------------
# launchGlasgowService_state.py
#
# Launch the glasgow uvicorn service in the background. The command template
# uses `nohup ... &` to detach, so the process survives this step's exit.
# A small post-launch sleep is performed by verifyGlasgowService_state.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class launchGlasgowService_state(executeShellCommand_state):
    def __init__(self, parent):
        super(launchGlasgowService_state, self).__init__(parent)
