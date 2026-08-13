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
import re
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
            aptPackages  = list(dict.fromkeys(actionData.get("aptPackages", []) or []))
            pipxBoot     = list(actionData.get("pipxBootstrap", []) or [])
            pipPackages  = list(dict.fromkeys(actionData.get("pipPackages", []) or []))
            useVenv      = bool(actionData.get("useVenv", True))
            venvActivate = actionData.get("venvActivate", "")
            if venvActivate:
                venvActivate = self.resolveDeployPath(venvActivate)
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

            invalidApt = [
                package for package in aptPackages
                if not re.fullmatch(r"[A-Za-z0-9.+-]+", str(package))
            ]
            if invalidApt:
                raise ValueError("invalid apt package names: {}".format(invalidApt))
            if aptPackages:
                packageArgs = " ".join(
                    shlex.quote(str(package)) for package in aptPackages)
                commands.append(("apt", (
                    "missing=''; "
                    "for package in {packages}; do "
                    "dpkg-query -W -f='${{Status}}' \"$package\" 2>/dev/null | "
                    "grep -qx 'install ok installed' || missing=\"$missing $package\"; "
                    "done; "
                    "if [ -n \"$missing\" ]; then "
                    "sudo -n true || {{ "
                    "echo 'sudo credentials are required; run sudo -v in the launching terminal, then retry' >&2; "
                    "exit 1; }}; "
                    "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update && "
                    "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install {options} $missing; "
                    "else echo 'all apt toolchain packages already installed'; fi"
                ).format(packages=packageArgs, options=aptOptions)))

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
                      "(apt batches={}, pipx={}, pip={})..."
                      .format(type(self).__name__, len(commands),
                              1 if aptPackages else 0, len(pipxBoot), len(pipPackages)))

            allOk = True
            for kind, cmd in commands:
                self.info("[{}][{}] >> {}".format(type(self).__name__, kind, cmd))
                ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
                if not ok:
                    stdout = (self._stdout.decode(errors="replace")
                              if self._stdout else "<no stdout>")
                    stderr = (self._stderr.decode(errors="replace")
                              if self._stderr else "<no stderr>")
                    self.error("[{}][{}] FAILED: {}\nstdout:\n{}\nstderr:\n{}".format(
                        type(self).__name__, kind, cmd,
                        stdout, stderr))
                    allOk = False
                    if stopOnError:
                        break

            self._success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

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
