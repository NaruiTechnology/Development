"""Stop the installed stack using the incoming distribution's manager."""
import asyncio
import os
import shlex
import tempfile
import zipfile
from pathlib import Path

from .distributionDeploy_state import distributionDeploy_state
from .unzipDistribution_state import unzipDistribution_state


class stopLocalSystem_state(distributionDeploy_state):
    async def DoWork(self):
        self._success = False
        self.ParentWorkThread._localSystemStopped = False
        try:
            root = self.deployRoot()
            if not unzipDistribution_state._isSafeDeployRoot(root):
                raise ValueError("unsafe deploy root: {}".format(root))
            config = self.ParentWorkThread.GetStateConfig(self) or {}
            unzip_config = next(a["unzipDistribution"] for a in self.Config.Actions
                                if "unzipDistribution" in a)
            hint = unzip_config["actionData"]["zip"]
            helper = unzipDistribution_state(self.ParentWorkThread)
            archive = helper._findZipFile(helper._resolveSearchFolder(hint), os.path.basename(hint))
            if not archive:
                raise FileNotFoundError("distribution archive not found")
            if os.path.commonpath([os.path.realpath(archive), os.path.realpath(root)]) == os.path.realpath(root):
                raise ValueError("distribution archive must be outside the deploy root")
            # Pin the archive used by extraction; validate it before stopping
            # anything or deleting the existing installation.
            with zipfile.ZipFile(archive) as bundle:
                bad = bundle.testzip()
                if bad:
                    raise ValueError("corrupt archive member: {}".format(bad))
                manager = bundle.read("Development/Scripts/manage-local-system.sh")
                bundle.getinfo("Development/Scripts/program-fpga-ram.py")
            self.ParentWorkThread._distributionZip = archive
            with tempfile.TemporaryDirectory(prefix="iobeam-stop-") as temporary:
                script = Path(temporary) / "Development/Scripts/manage-local-system.sh"
                script.parent.mkdir(parents=True)
                script.write_bytes(manager)
                script.chmod(0o700)
                cmd = "env OPERATIONS_ROOT={} ./Development/Scripts/manage-local-system.sh stop".format(shlex.quote(root))
                self.info("[stopLocalSystem] {} (archive={})".format(cmd, archive))
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(cmd, temporary, verbose=True),
                    timeout=float(config.get("timeout", 120)))
                if not self._success:
                    self.error("[stopLocalSystem] failed: {}".format(
                        (self._stderr or b"").decode(errors="replace")))
            self.ParentWorkThread._localSystemStopped = self._success
        except Exception as exc:
            self.error("[stopLocalSystem] {}".format(exc))
