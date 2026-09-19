#-------------------------------------------------------------------------------
# verifyDistribution_state.py
#
# Immediately after extraction, prove the deployed tree is exactly the archive
# that was verified before anything was stopped: the manifest that landed on
# disk must equal the pinned archive's manifest, and every file it lists must
# be present with the recorded size and SHA-256. Also logs the build identity
# (commit, build time, interpreter) so a deploy log says what is now running.
#-------------------------------------------------------------------------------
import json
import os
import zipfile

import distributionManifest
from buildingblocks.decorators import overrides

from .distributionDeploy_state import distributionDeploy_state
from .unzipDistribution_state import unzipDistribution_state


class verifyDistribution_state(distributionDeploy_state):
    def __init__(self, parent):
        super(verifyDistribution_state, self).__init__(parent)

    def _manifestRequired(self):
        deployment = getattr(self.Config, "Deployment", None)
        if isinstance(deployment, dict):
            return bool(deployment.get("RequireDistributionManifest", True))
        return True

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        self._success = False
        name = type(self).__name__
        try:
            root = os.path.abspath(os.path.expanduser(str(self.deployRoot())))
            if not unzipDistribution_state._isSafeDeployRoot(root):
                raise ValueError("unsafe deploy root: {}".format(root))
            manifest_path = os.path.join(root, distributionManifest.MANIFEST_NAME)

            if not self._manifestRequired():
                self.warn("[{}] RequireDistributionManifest is false: extracted "
                          "tree NOT verified".format(name))
                self._success = True
                return

            archive = getattr(self.ParentWorkThread, "_distributionZip", None)
            if not archive:
                raise RuntimeError("no verified archive is pinned; "
                                   "stopLocalSystem must run first")
            if not os.path.isfile(manifest_path):
                raise distributionManifest.ManifestError(
                    "{} is absent after extraction".format(
                        distributionManifest.MANIFEST_NAME))
            with open(manifest_path, "r", encoding="utf-8") as stream:
                deployed = json.load(stream)
            with zipfile.ZipFile(archive) as bundle:
                pinned = distributionManifest.load_manifest(bundle)
            if deployed != pinned:
                raise distributionManifest.ManifestError(
                    "the manifest on disk differs from the verified archive's manifest")

            distributionManifest.check_compatibility(deployed)
            count = distributionManifest.verify_tree(root, deployed)
            self.info("[{}] deployed tree verified ({} files): {}".format(
                name, count, distributionManifest.summarize(deployed)))
            self._success = True
        except Exception as e:
            self.error("[{}] {}".format(name, e))
            self._success = False
