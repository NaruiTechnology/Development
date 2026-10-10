"""Stop the installed stack using the incoming distribution's manager."""
import asyncio
import os
import shlex
import tempfile
import zipfile
from pathlib import Path

import distributionManifest
from .distributionDeploy_state import distributionDeploy_state
from .unzipDistribution_state import unzipDistribution_state


class stopLocalSystem_state(distributionDeploy_state):
    def _manifestRequired(self):
        """Deployment.RequireDistributionManifest (default True).

        Read straight from this run's config: the base-class deploymentValue()
        helper looks for ``thread.Config``, which the real thread does not
        define, so it always returns its default.
        """
        deployment = getattr(self.Config, "Deployment", None)
        if isinstance(deployment, dict):
            return bool(deployment.get("RequireDistributionManifest", True))
        return True

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
            if self._manifestRequired():
                # Complete verification: every file against its recorded
                # hash, no unlisted or missing members, and (for bytecode)
                # an interpreter that can import it. A version-mismatched
                # archive is rejected here, while the old install is intact.
                manifest = distributionManifest.verify_zip(archive)
                self.info("[stopLocalSystem] distribution verified: {}".format(
                    distributionManifest.summarize(manifest)))
            else:
                self.warn("[stopLocalSystem] RequireDistributionManifest is false: "
                          "archive contents are NOT verified against a manifest")
            with zipfile.ZipFile(archive) as bundle:
                bad = bundle.testzip()
                if bad:
                    raise ValueError("corrupt archive member: {}".format(bad))
                manager_name = "manage-local-system.ps1" if os.name == "nt" else "manage-local-system.sh"
                manager = bundle.read("Development/Scripts/" + manager_name)
                bundle.getinfo("Development/Scripts/program-fpga-ram.py")
            self.ParentWorkThread._distributionZip = archive
            with tempfile.TemporaryDirectory(prefix="iobeam-stop-") as temporary:
                script = Path(temporary) / "Development/Scripts" / manager_name
                script.parent.mkdir(parents=True)
                script.write_bytes(manager)
                script.chmod(0o700)
                cmd = "env OPERATIONS_ROOT={} ./Development/Scripts/manage-local-system.sh stop".format(shlex.quote(root))
                self.info("[stopLocalSystem] {} (archive={})".format(cmd, archive))
                if os.name == "nt":
                    # The incoming manager operates on the installed stack, not the temporary folder.
                    env = dict(os.environ, IOBEAM_OPERATIONS_ROOT=root)
                    process = await asyncio.create_subprocess_exec(
                        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", str(script), "stop", cwd=temporary, env=env,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    try:
                        self._stdout, self._stderr = await asyncio.wait_for(
                            process.communicate(), timeout=float(config.get("timeout", 120)))
                    except (asyncio.TimeoutError, asyncio.CancelledError):
                        process.kill()
                        await process.communicate()
                        raise
                    self._success = process.returncode == 0
                else:
                    self._success = await asyncio.wait_for(
                        self.commandAsyncio(cmd, temporary, verbose=True),
                        timeout=float(config.get("timeout", 120)))
                if not self._success:
                    self.error("[stopLocalSystem] failed: {}".format(
                        (self._stderr or b"").decode(errors="replace")))
            self.ParentWorkThread._localSystemStopped = self._success
        except Exception as exc:
            self.error("[stopLocalSystem] {}".format(exc))
