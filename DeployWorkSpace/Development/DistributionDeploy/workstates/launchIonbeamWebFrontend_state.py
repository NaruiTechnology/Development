#-------------------------------------------------------------------------------
# launchIonbeamWebFrontend_state.py
#
# Start `npm run dev` in ionbeam-web/frontend, detached.
#-------------------------------------------------------------------------------
from .longRunShellLaunch_state import longRunShellLaunch_state


class launchIonbeamWebFrontend_state(longRunShellLaunch_state):
    def __init__(self, parent):
        super(launchIonbeamWebFrontend_state, self).__init__(parent)
