#-------------------------------------------------------------------------------
# installToolchain_state.py
#
# Iterates over dependency lists in actionData and runs each as its own command:
#
#   aptPackages  -> sudo apt install <aptOptions> <pkg>
#   pipxBootstrap -> bare commands run as-is (e.g. "pipx ensurepath")
#   pipPackages  -> python -m pip install <pkg>
#   verifyCommands -> commands that must exist/run after install
#
# pip installs run inside the project venv when 'useVenv' is true and the
# venv Python exists, otherwise against the system Python.
#
# Action data fields recognised:
#   aptOptions               default '-y --no-install-recommends'
#   aptPackages              list of package names
#   pipxBootstrap            list of literal shell commands
#   pipPackages              list of pip package specs
#   useVenv                  bool, default True
#   venvActivate             absolute path to <venv>/bin/activate or Scripts/activate
#   venvDir                  virtualenv directory; used to find Scripts/python.exe on Windows
#   useBreakSystemPackages   bool, default True (used only when useVenv=False
#                            or activate script missing)
#   verifyCommands           list of command arrays/strings to run after installs
#   stopOnError              bool, abort on first failure (default False)
#-------------------------------------------------------------------------------
import asyncio
import os
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

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
            venvDir      = actionData.get("venvDir", "")
            if venvActivate:
                venvActivate = self.resolveDeployPath(venvActivate)
            if venvDir:
                venvDir = self.resolveDeployPath(venvDir)
            breakSys     = bool(actionData.get("useBreakSystemPackages", True))
            verifyCmds   = list(actionData.get("verifyCommands", []) or [])
            stopOnError  = bool(actionData.get("stopOnError", False))

            # ---- decide whether the venv path is actually usable ----------
            pythonExe = self._pythonForVenv(venvDir, venvActivate) if useVenv else None
            venvOk = bool(pythonExe)
            if useVenv and not venvOk:
                self.warn("[{}] venv python not found for '{}'/'{}'; falling back to "
                          "system python."
                          .format(type(self).__name__, venvDir, venvActivate))
            pipPrefix = self._quote(pythonExe) + " -m pip" if pythonExe else self._systemPythonPip()

            # ---- assemble command list -----------------------------------
            commands = []

            if os.name == "nt" and aptPackages:
                self.info("[{}] skipping apt packages on Windows: {}"
                          .format(type(self).__name__, ", ".join(aptPackages)))
            else:
                for pkg in aptPackages:
                    commands.append(("apt", "sudo apt install {} {}"
                                     .format(aptOptions, pkg)))

            if os.name == "nt" and pipxBoot:
                self.info("[{}] skipping pipx bootstrap on Windows: {}"
                          .format(type(self).__name__, ", ".join(pipxBoot)))
            else:
                for raw in pipxBoot:
                    commands.append(("pipx", raw))

            for spec in pipPackages:
                cmd = "{} install {}".format(pipPrefix, self._quote(spec))
                if not pythonExe and os.name != "nt" and breakSys:
                    cmd += " --break-system-packages"
                commands.append(("pip", cmd))

            for raw in verifyCmds:
                commands.append(("verify", self._formatVerifyCommand(raw)))

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

            self._success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _pythonForVenv(self, venvDir, venvActivate):
        candidates = []
        if venvDir:
            candidates.extend([
                os.path.join(venvDir, "Scripts", "python.exe"),
                os.path.join(venvDir, "Scripts", "python"),
                os.path.join(venvDir, "bin", "python"),
            ])
        if venvActivate:
            scriptsDir = os.path.dirname(venvActivate)
            venvRoot = os.path.dirname(scriptsDir)
            candidates.extend([
                os.path.join(scriptsDir, "python.exe"),
                os.path.join(scriptsDir, "python"),
                os.path.join(venvRoot, "bin", "python"),
            ])
        for candidate in candidates:
            if candidate and os.path.isfile(candidate):
                return candidate
        return None

    def _systemPythonPip(self):
        return "py -3 -m pip" if os.name == "nt" else "python3 -m pip"

    def _quote(self, value):
        value = str(value)
        if os.name == "nt":
            return '"{}"'.format(value.replace('"', r'\"'))
        return shlex.quote(value)

    def _formatVerifyCommand(self, raw):
        if isinstance(raw, (list, tuple)):
            return " ".join(self._quote(part) for part in raw)
        return str(raw)

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
