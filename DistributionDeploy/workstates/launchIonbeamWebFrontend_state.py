#-------------------------------------------------------------------------------
# launchIonbeamWebFrontend_state.py
#
# Start `npm run dev` in ionbeam-web/frontend, detached.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class launchIonbeamWebFrontend_state(executeShellCommand_state):
    def __init__(self, parent):
        super(launchIonbeamWebFrontend_state, self).__init__(parent)
