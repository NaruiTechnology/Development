#-------------------------------------------------------------------------------
# createDeployFolder_state.py
#
# Recreate the configured deploy root before unpacking the distribution.
#-------------------------------------------------------------------------------
from buildingblocks.decorators import overrides
from .distributionDeploy_state import distributionDeploy_state
from .unzipDistribution_state import unzipDistribution_state


class createDeployFolder_state(distributionDeploy_state):
    def __init__(self, parent):
        super(createDeployFolder_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            deployRoot = self.deployRoot()

            if not unzipDistribution_state._isSafeDeployRoot(deployRoot):
                self.error("[{}] refusing to recreate unsafe deploy root: {}"
                           .format(type(self).__name__, deployRoot))
                self._success = False
                return

            # Use the guarded, current-user implementation. Never interpolate
            # a deployment path into a recursive shell deletion command.
            helper = unzipDistribution_state(self.ParentWorkThread)
            helper.Config = self.Config
            helper.Logger = self.Logger
            self._success = helper._prepareDeployRoot(deployRoot)
            if self._success:
                self.info("[{}] safely prepared {}".format(
                    type(self).__name__, deployRoot))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False
