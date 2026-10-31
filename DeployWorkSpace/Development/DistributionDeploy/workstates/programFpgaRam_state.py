"""Mandatory RAM programming gate before the remaining installation states."""
import asyncio
import os
import shlex

from .distributionDeploy_state import distributionDeploy_state


class programFpgaRam_state(distributionDeploy_state):
    async def DoWork(self):
        self._success = False
        try:
            if not getattr(self.ParentWorkThread, "_localSystemStopped", False):
                raise RuntimeError("services have not been stopped by this workflow")
            config = self.ParentWorkThread.GetStateConfig(self) or {}
            python = self.resolveDeployPath(os.path.join(self.ParentWorkThread.venvDir,
                "Scripts/python.exe" if os.name == "nt" else "bin/python"))
            script = self.resolveDeployPath("Development/Scripts/program-fpga-ram.py")
            scan_config = self.ParentWorkThread.glasgowConfig
            for path in (python, script, scan_config):
                if not os.path.isfile(path):
                    raise FileNotFoundError(path)
            # Do not use Python's isolated mode (-I) here: it hides the venv
            # site-packages and caused ModuleNotFoundError for amaranth.
            if os.name == "nt":
                arguments = [python, script, "--config", scan_config]
                self.info("[programFpgaRam] >> {}".format(arguments))
                self._success = await self.runArguments(
                    arguments, float(config.get("timeout", 900)))
                stdout = (self._stdout or b"").decode(errors="replace")
                stderr = (self._stderr or b"").decode(errors="replace")
                if stdout:
                    self.info("[programFpgaRam] output:\n{}".format(stdout))
                if not self._success:
                    self.error("[programFpgaRam] download/verification failed (exit {}):\n{}".format(
                        self._returncode, stderr or stdout or "No subprocess output captured"))
                elif stderr:
                    self.info("[programFpgaRam] diagnostics:\n{}".format(stderr))
                return
            command = "{} {} --config {}".format(
                shlex.quote(python), shlex.quote(script), shlex.quote(scan_config))
            self.info("[programFpgaRam] >> {}".format(command))
            self._success = await asyncio.wait_for(
                self.commandAsyncio(command, self.deployRoot(), verbose=True),
                timeout=float(config.get("timeout", 900)))
            if not self._success:
                self.error("[programFpgaRam] download/verification failed: {}".format(
                    (self._stderr or b"").decode(errors="replace")))
        except Exception as exc:
            self.error("[programFpgaRam] {}".format(exc))
