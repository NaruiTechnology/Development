#-------------------------------------------------------------------------------
# launchIonbeamWebBackend_state.py
#
# Start `npm run dev` in ionbeam-web/backend, detached.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class launchIonbeamWebBackend_state(executeShellCommand_state):
    def __init__(self, parent):
        super(launchIonbeamWebBackend_state, self).__init__(parent)
