"""Fail the deployment early if the FPGA gateware toolchain cannot run.

Every scan launch rebuilds the bitstream (IobeamLauncher -> Amaranth ->
yosys / nextpnr-ice40 / icepack), and the gateware changes shipped with a
release change the bitstream, so a machine that cannot build gets an
"nextpnr-ice40: not found" error at the first scan instead of at deploy time.

The check must run in the same interpreter the service runs in (the deployed
venv), because Glasgow's "builtin" toolchain is the yowasp-* packages installed
into *that* interpreter; when they are missing Glasgow silently falls back to
the "system" toolchain, which needs apt's yosys AND nextpnr-ice40 AND icepack
on PATH (the apt list installs yosys only).

actionData:
  venvActivate   activate script of the service venv (default .venv/bin/activate)
  pythonPath     list of deploy-relative dirs put on PYTHONPATH
  tools          tools that must run (default yosys, nextpnr-ice40, icepack)
"""
import asyncio
import os
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state

DEFAULT_TOOLS = ("yosys", "nextpnr-ice40", "icepack")

# Runs inside the deployed venv.  Exit codes: 0 ok, 2 no toolchain, 3 a tool
# is present but cannot report a version (missing or crashing).
CHECK_SCRIPT = r'''
import sys
from GlasgowDataIO.IobeamControl.glasgowLib.glasgow.hardware.toolchain import (
    find_toolchain, ToolchainNotFound)
tools = tuple(sys.argv[1:])
try:
    toolchain = find_toolchain(tools, quiet=True)
except ToolchainNotFound as exc:
    print("FPGA toolchain NOT FOUND: %s" % exc)
    sys.exit(2)
missing = list(toolchain.missing)
if missing:
    print("FPGA toolchain incomplete, cannot run: %s" % ", ".join(missing))
    sys.exit(3)
print("FPGA toolchain OK (%s): %s" % (type(toolchain.tools[0]).__name__, toolchain))
'''


class verifyFpgaToolchain_state(distributionDeploy_state):
    def __init__(self, parent):
        super(verifyFpgaToolchain_state, self).__init__(parent)

    @staticmethod
    def buildCommand(activate, pythonPath, tools):
        """Shell command running CHECK_SCRIPT in the venv (pure, unit-testable)."""
        for tool in tools:
            if not tool or not all(c.isalnum() or c in "-_." for c in str(tool)):
                raise ValueError("invalid tool name: {!r}".format(tool))
        py_path = ":".join(shlex.quote(str(p)) for p in pythonPath)
        return (
            ". {act} && PYTHONPATH={pp}${{PYTHONPATH:+:$PYTHONPATH}} "
            "python -c {script} {tools}"
        ).format(
            act=shlex.quote(activate), pp=py_path,
            script=shlex.quote(CHECK_SCRIPT),
            tools=" ".join(shlex.quote(str(t)) for t in tools))

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 120.0) or 120.0)

            activate = self.resolveDeployPath(
                actionData.get("venvActivate", ".venv/bin/activate"))
            if not os.path.isfile(activate):
                raise FileNotFoundError(
                    "venv activate script not found: {} (run setupVirtualEnv first)"
                    .format(activate))
            pythonPath = [self.resolveDeployPath(p)
                          for p in actionData.get("pythonPath", ["Development"])]
            tools = list(actionData.get("tools", DEFAULT_TOOLS))

            command = "bash -c {}".format(
                shlex.quote(self.buildCommand(activate, pythonPath, tools)))
            self.info("[{}] checking FPGA toolchain ({}) in {}"
                      .format(type(self).__name__, ", ".join(tools), activate))
            self._success = await asyncio.wait_for(
                self.commandAsyncio(command, self.deployRoot(), verbose=True),
                timeout=timeout)
            if not self._success:
                self.error(
                    "[{n}] The FPGA gateware toolchain is not usable in the deployed "
                    "venv, so the first scan would fail to build the bitstream. Install "
                    "yowasp-yosys and yowasp-nextpnr-ice40 into the venv (they are pinned "
                    "in Development/requirements.txt), or install apt yosys + "
                    "nextpnr-ice40 + fpga-icestorm and set GLASGOW_TOOLCHAIN=system."
                    .format(n=type(self).__name__))
        except asyncio.TimeoutError:
            self.error("[{}] TIMEOUT after {}s".format(type(self).__name__, timeout))
            self._success = False
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
