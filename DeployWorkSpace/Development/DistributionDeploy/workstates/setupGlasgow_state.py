#-------------------------------------------------------------------------------
# setupGlasgow_state.py
#
# Bring up the Glasgow toolchain on a fresh Ubuntu host:
#
#   1. Ensure the 'plugdev' group exists; if not, create it and add the
#      current user to it.
#   2. Under the deploy root, clone GlasgowEmbedded/glasgow if it isn't
#      there already.
#   3. Patch Glasgow's pyproject.toml Python floor when requested.
#   4. Install the udev rules: cp config/70-glasgow.rules into /etc/udev/rules.d
#      then `udevadm control --reload && udevadm trigger ...` for the
#      configured idVendor/idProduct.
#   5. pipx install -e 'glasgow/software[builtin-toolchain]'
#
# Each step is its own subprocess so a clean stop-on-error point exists at
# every boundary. Step 1 and step 3 require sudo; step 2 and step 4 don't.
#
# Action data fields recognised:
#   deployRoot     where the glasgow repo lives / will be cloned into
#   repoUrl        upstream URL (default: GlasgowEmbedded/glasgow)
#   repoDir        local repo directory name
#   rulesSrc       udev rules path inside the repo
#   rulesDst       /etc/udev/rules.d
#   idVendor       USB vendor id used for udevadm trigger
#   idProduct      USB product id
#   pipxTarget     argument to `pipx install -e ...`
#   pipxPython     optional Python executable for pipx --python
#   pipxRequired   fail workflow when pipx install fails (default False)
#   pyprojectPath  pyproject.toml to patch inside deploy root
#   pythonRequires replacement requires-python value (empty disables patch)
#   stopOnError    abort on first failure (default True; this whole sequence
#                  doesn't tolerate skipping a step)
#-------------------------------------------------------------------------------
import asyncio
import os

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
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            deployRoot  = self.resolveDeployPath(actionData.get("deployRoot") or ".")
            repoUrl     = actionData.get("repoUrl",
                                          "https://github.com/GlasgowEmbedded/glasgow")
            repoDir     = actionData.get("repoDir", "glasgow")
            rulesSrc    = actionData.get("rulesSrc", "glasgow/config/70-glasgow.rules")
            rulesDst    = actionData.get("rulesDst", "/etc/udev/rules.d")
            idVendor    = actionData.get("idVendor", "20b7")
            idProduct   = actionData.get("idProduct", "9db1")
            pipxTarget  = actionData.get("pipxTarget", "glasgow/software[builtin-toolchain]")
            pipxPython  = actionData.get("pipxPython", "python3.13")
            pipxRequired = bool(actionData.get("pipxRequired", False))
            pyprojectPath = actionData.get("pyprojectPath", "glasgow/software/pyproject.toml")
            pythonRequires = actionData.get("pythonRequires", ">=3.12.3,<4")
            stopOnError = bool(actionData.get("stopOnError", True))

            steps = []

            # 1. plugdev group: create if missing, add current user.
            steps.append((
                "plugdev",
                "bash -c 'getent group plugdev >/dev/null || sudo groupadd plugdev; "
                "sudo usermod -aG plugdev \"$USER\"'"
            ))

            # 2. clone repo only if it doesn't exist
            steps.append((
                "clone",
                "bash -c 'cd \"{root}\" && [ -d \"{dir}/.git\" ] "
                "|| git clone {url} {dir}'".format(
                    root=deployRoot, url=repoUrl, dir=repoDir)
            ))

            # 3. Patch the cloned Glasgow package metadata for this host.
            if pythonRequires:
                pyprojectPathForPy = pyprojectPath.replace("\\", "\\\\").replace('"', '\\"')
                pythonRequiresForPy = pythonRequires.replace("\\", "\\\\").replace('"', '\\"')
                steps.append((
                    "patch-pyproject-python",
                    "bash -c 'cd \"{root}\" && python3 -c \""
                    "from pathlib import Path; import re; "
                    "p=Path(\\\"{path}\\\"); "
                    "s=p.read_text(); "
                    "ns,n=re.subn(r\\\"requires-python\\\\s*=\\\\s*[^\\\\n]+\\\", "
                    "\\\"requires-python = \\\\\\\"{requires}\\\\\\\"\\\", s, count=1); "
                    "assert n, f\\\"requires-python not found in {{p}}\\\"; "
                    "p.write_text(ns)\"'".format(
                        root=deployRoot, path=pyprojectPathForPy,
                        requires=pythonRequiresForPy)
                ))
                steps.append((
                    "show-pyproject-python",
                    "bash -c 'cd \"{root}\" && grep -n \"requires-python\" \"{path}\"'".format(
                        root=deployRoot, path=pyprojectPath)
                ))

            # 4. udev rules + trigger (the user's verbatim command)
            steps.append((
                "udev",
                "bash -c 'cd \"{root}\" && sudo cp {src} {dst} "
                "&& sudo udevadm control --reload "
                "&& sudo udevadm trigger -v -c add -s usb "
                "-a idVendor={v} -a idProduct={p}'".format(
                    root=deployRoot, src=rulesSrc, dst=rulesDst,
                    v=idVendor, p=idProduct)
            ))

            # 5. pipx install of the glasgow software
            steps.append((
                "pipx-install",
                "bash -c 'cd \"{root}\" && "
                "if command -v {py} >/dev/null 2>&1; then "
                "pipx install --python {py} -e \"{tgt}\"; "
                "else pipx install -e \"{tgt}\"; fi'".format(
                    root=deployRoot, py=pipxPython, tgt=pipxTarget)
            ))

            if not os.path.isdir(deployRoot):
                self.error("[{}] deploy root '{}' does not exist."
                           .format(type(self).__name__, deployRoot))
                self.Success = False
                return

            allOk = True
            for label, cmd in steps:
                self.info("[{}][{}] >> {}"
                          .format(type(self).__name__, label, cmd))
                ok = await self._runWithTimeout(cmd, deployRoot, timeout)
                if not ok:
                    self.error("[{}][{}] FAILED.\n{}".format(
                        type(self).__name__, label,
                        self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
                    if label == "pipx-install" and not pipxRequired:
                        self.warn("[{}][{}] continuing because pipxRequired=false. "
                                  "The Glasgow service uses the deploy virtualenv; "
                                  "pipx only provides the standalone Glasgow CLI."
                                  .format(type(self).__name__, label))
                        continue
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
