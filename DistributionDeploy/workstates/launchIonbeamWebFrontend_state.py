#-------------------------------------------------------------------------------
# launchIonbeamWebFrontend_state.py
#
# Start `npm run dev` in ionbeam-web/frontend, detached.
#-------------------------------------------------------------------------------
from .detachedShellLaunch_state import detachedShellLaunch_state


class launchIonbeamWebFrontend_state(detachedShellLaunch_state):
    def __init__(self, parent):
        super(launchIonbeamWebFrontend_state, self).__init__(parent)
