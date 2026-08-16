"""Verify the Glasgow Python and FPGA toolchain runtime on Windows."""
import asyncio
import os
import sys

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class setupGlasgow_state(distributionDeploy_state):
    def __init__(self, parent):
        super(setupGlasgow_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 300.0) or 300.0)
            deployRoot = self.resolveDeployPath(actionData.get("deployRoot") or ".")
            venvDir = self.resolveDeployPath(actionData.get("venvDir", ".venv"))
            pythonExe = os.path.join(venvDir, "Scripts", "python.exe")
            if not os.path.isfile(pythonExe):
                pythonExe = sys.executable
            icepackExe = os.path.join(
                os.path.dirname(pythonExe), "yowasp-icepack.exe")
            os.environ["GLASGOW_TOOLCHAIN"] = str(
                actionData.get("toolchain", "builtin"))

            commands = actionData.get("verifyCommands") or [
                [pythonExe, "-c",
                 "import fx2, usb1, usb.core, amaranth, yowasp_yosys"],
                ["yowasp-yosys.exe", "--version"],
                ["yowasp-nextpnr-ice40.exe", "--version"],
                ["powershell.exe", "-NoProfile", "-Command",
                 "if (Test-Path -LiteralPath '{}') {{ exit 0 }} else {{ exit 1 }}"
                 .format(icepackExe.replace("'", "''"))],
            ]
            self.info(
                "[{}] Windows USB note: associate the Glasgow device with "
                "a WinUSB/libusb-compatible driver if PyUSB cannot open it."
                .format(type(self).__name__))
            for raw in commands:
                argv = ([str(part) for part in raw]
                        if isinstance(raw, (list, tuple))
                        else ["cmd.exe", "/d", "/s", "/c", str(raw)])
                if not await self._run(argv, deployRoot, timeout):
                    self._success = False
                    return
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False

    async def _run(self, argv, cwd, timeout):
        self.info("[{}] >> {}".format(type(self).__name__, " ".join(argv)))
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy())
        try:
            self._stdout, self._stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            return False
        return proc.returncode == 0
