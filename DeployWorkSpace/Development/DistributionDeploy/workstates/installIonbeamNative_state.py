"""Install the native desktop client (Development/ionbeam-native) on the instrument PC.

The Python requirements are installed into the deployment venv by the
installPipRequirements action (ionbeam-native/requirements.txt is one of its
extraRequirements). This action adds the Qt runtime libraries, then runs the
app's own installer against that venv: launcher (~/.local/bin/ionbeam-native),
applications-menu entry and a smoke test that starts the app offscreen
against the built-in Glasgow emulator (no hardware is touched).

Remote production hosts have no instrument attached, so the action is a no-op
there.
"""
import asyncio
import os
import re
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state

DEFAULT_APT_PACKAGES = [
    "libegl1", "libgl1", "libxkbcommon0", "libxkbcommon-x11-0", "libfontconfig1",
    "libdbus-1-3", "libxcb-cursor0", "libxcb-icccm4", "libxcb-keysyms1", "libxcb-shape0",
]


class installIonbeamNative_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installIonbeamNative_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        name = type(self).__name__
        if self.isProduction():
            self.info("[{}] production deployment: no instrument, native client not installed"
                      .format(name))
            self._success = True
            return
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = self.resolvedActionData(stateConfig)
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 900.0) or 900.0)

            if os.name == "nt":
                installer = self.resolveDeployPath(actionData.get(
                    "installer", "Development/ionbeam-native/scripts/install_windows.ps1"))
                venv = self.resolveDeployPath(actionData.get("venvDir", ".venv"))
                args = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                        "-File", installer, "-Venv", venv, "-SkipPip"]
                if not actionData.get("desktopEntry", True):
                    args.append("-NoDesktopEntry")
                if not actionData.get("runSmokeTest", True):
                    args.append("-SkipSmoke")
                self._success = await self.runArguments(args, timeout)
                if not self._success:
                    self.error(self._stderr.decode(errors="replace"))
                return

            installer = self.resolveDeployPath(actionData.get(
                "installer", "Development/ionbeam-native/scripts/install_linux.sh"))
            if not os.path.isfile(installer):
                raise FileNotFoundError("ionbeam-native installer not found: {}".format(installer))
            venvDir = self.resolveDeployPath(actionData.get(
                "venvDir", getattr(self.ParentWorkThread, "venvDir", ".venv")))
            if not os.path.isfile(os.path.join(venvDir, "bin", "python")):
                raise FileNotFoundError("deployment venv not found: {}".format(venvDir))

            packages = actionData.get("aptPackages", DEFAULT_APT_PACKAGES) or []
            invalid = [p for p in packages if not re.fullmatch(r"[A-Za-z0-9.+-]+", str(p))]
            if invalid:
                raise ValueError("invalid apt package names: {}".format(invalid))
            if packages and not await self._ensureAptPackages(packages, timeout):
                self._success = False
                return

            args = ["bash", installer, "--venv", venvDir, "--skip-pip"]
            if not actionData.get("desktopEntry", True):
                args.append("--no-desktop-entry")
            if not actionData.get("runSmokeTest", True):
                args.append("--skip-smoke")
            command = " ".join(shlex.quote(str(a)) for a in args)
            self.info("[{}] >> {}".format(name, command))
            self._success = await self._run(command, timeout)
            if not self._success:
                self.error("[{}] ionbeam-native installation failed\nstdout:\n{}\nstderr:\n{}".format(
                    name,
                    self._stdout.decode(errors="replace") if self._stdout else "<no stdout>",
                    self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
        except Exception as exc:
            self.error("[{}] error: {}".format(name, exc))
            self._success = False

    async def _ensureAptPackages(self, packages, timeout):
        packageArgs = " ".join(shlex.quote(str(p)) for p in packages)
        verify = (
            "for package in {packages}; do "
            "dpkg-query -W -f='${{Status}}' \"$package\" 2>/dev/null | "
            "grep -qx 'install ok installed' || exit 1; "
            "done"
        ).format(packages=packageArgs)
        if await self._run(verify, 30.0):
            self.info("[{}] Qt runtime libraries already installed".format(type(self).__name__))
            return True
        command = self.aptInstallCommand(packages, verify)
        self.info("[{}] installing Qt runtime libraries: {}"
                  .format(type(self).__name__, ", ".join(packages)))
        ok = await self._run(command, timeout)
        if not ok:
            # apt prints the actual unmet-dependency list on stdout; stderr only
            # carries the one-line "E: Unmet dependencies" summary.
            stdout = self._stdout.decode(errors="replace") if self._stdout else ""
            self.error("[{}] Qt runtime library installation failed\nstderr:\n{}\nstdout (tail):\n{}"
                       "\nDiagnose on the host with: sudo apt-get --fix-broken install; "
                       "apt-mark showhold; apt-cache policy {}".format(
                           type(self).__name__,
                           self._stderr.decode(errors="replace") if self._stderr else "<no stderr>",
                           "\n".join(stdout.splitlines()[-40:]) or "<no stdout>",
                           packageArgs))
        return ok

    async def _run(self, command, timeout):
        try:
            return await asyncio.wait_for(
                self.commandAsyncio(command, self.deployRoot(), verbose=True),
                timeout=timeout)
        except asyncio.TimeoutError:
            self.error("[{}] timed out after {}s".format(type(self).__name__, timeout))
            return False
