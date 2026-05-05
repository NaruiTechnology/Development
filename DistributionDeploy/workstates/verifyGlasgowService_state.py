#-------------------------------------------------------------------------------
# verifyGlasgowService_state.py
#
# Sanity-check the glasgow service log for liveness markers.
# Driven by `bash -c 'sleep {} && grep -E "{}" {} || true'`.
#
# We append `|| true` in the template so a missing marker doesn't fail the
# step -- this is an informational sanity check, not a hard gate.
#-------------------------------------------------------------------------------
from .executeShellCommand_state import executeShellCommand_state


class verifyGlasgowService_state(executeShellCommand_state):
    def __init__(self, parent):
        super(verifyGlasgowService_state, self).__init__(parent)
