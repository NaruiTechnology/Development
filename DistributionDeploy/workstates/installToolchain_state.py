#-------------------------------------------------------------------------------
# installToolchain_state.py
#
# Iterates over three lists in actionData and runs each as its own command:
#
#   aptPackages  -> sudo apt install <aptOptions> <pkg>
#   pipxBootstrap -> bare commands run as-is (e.g. "pipx ensurepath")
#   pipPackages  -> python3 -m pip install <pkg> [--break-system-packages]
#
# pip installs run inside the project venv when 'useVenv' is true and the
# venv activate script exists, otherwise against the system Python (with
# --break-system-packages on Ubuntu 24.04 unless explicitly disabled).
#
# Action data fields recognised:
#   aptOptions               default '-y --no-install-recommends'
#   aptPackages              list of package names
#   pipxBootstrap            list of literal shell commands
#   pipPackages              list of pip package specs
#   useVenv                  bool, default True
#   venvActivate             absolute path to <venv>/bin/activate
#   useBreakSystemPackages   bool, default True (used only when useVenv=False
#                            or activate script missing)
#   stopOnError              bool, abort on first failure (default False)
#-------------------------------------------------------------------------------
import asyncio
import os

from AutomationPy.buildingblocks.decorators import overrides
from AutomationPy.buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installToolchain_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installToolchain_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            aptOptions   = actionData.get("aptOptions", "-y --no-install-recommends")
            aptPackages  = list(actionData.get("aptPackages", []) or [])
            pipxBoot     = list(actionData.get("pipxBootstrap", []) or [])
            pipPackages  = list(actionData.get("pipPackages", []) or [])
            useVenv      = bool(actionData.get("useVenv", True))
            venvActivate = actionData.get("venvActivate", "")
            breakSys     = bool(actionData.get("useBreakSystemPackages", True))
            stopOnError  = bool(actionData.get("stopOnError", False))

            # ---- decide whether the venv path is actually usable ----------
            venvOk = useVenv and venvActivate and os.path.isfile(venvActivate)
            if useVenv and not venvOk:
                self.warn("[{}] venv activate '{}' not found; falling back to "
                          "system python."
                          .format(type(self).__name__, venvActivate))

            # ---- assemble command list -----------------------------------
            commands = []

            for pkg in aptPackages:
                commands.append(("apt", "sudo apt install {} {}"
                                 .format(aptOptions, pkg)))

            for raw in pipxBoot:
                commands.append(("pipx", raw))

            for spec in pipPackages:
                if venvOk:
                    cmd = "bash -c '. \"{act}\" && python -m pip install {p}'".format(
                        act=venvActivate, p=spec)
                else:
                    cmd = "python3 -m pip install {}".format(spec)
                    if breakSys:
                        cmd += " --break-system-packages"
                commands.append(("pip", cmd))

            if not commands:
                self.info("[{}] nothing to install.".format(type(self).__name__))
                self.Success = True
                return

            self.info("[{}] running {} install commands "
                      "(apt={}, pipx={}, pip={})..."
                      .format(type(self).__name__, len(commands),
                              len(aptPackages), len(pipxBoot), len(pipPackages)))

            allOk = True
            for kind, cmd in commands:
                self.info("[{}][{}] >> {}".format(type(self).__name__, kind, cmd))
                ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
                if not ok:
                    self.error("[{}][{}] FAILED: {}\n{}".format(
                        type(self).__name__, kind, cmd,
                        self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
                    allOk = False
                    if stopOnError:
                        break

            self.Success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self.Success = False

    async def _runWithTimeout(self, cmd, runDir, timeout):
        if timeout and timeout > 0:
            try:
                return await asyncio.wait_for(
                    self.commandAsyncio(cmd, runDir, verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s on: {}"
                           .format(type(self).__name__, timeout, cmd))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
