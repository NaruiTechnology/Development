#-------------------------------------------------------------------------------
# installPipRequirements_state.py
#
# Install deployed Python requirements inside the project venv.
# The distribution requirements can contain an editable dependency pointing back
# to the private NaruiTechnology/Development repository. In a deploy zip that
# source is already present locally, so cloning it again over HTTPS is both
# unnecessary and likely to fail without a token.
#-------------------------------------------------------------------------------
import asyncio
import os
import shlex
import tempfile
import re

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installPipRequirements_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installPipRequirements_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        tempFiles = []
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            root = self.resolveDeployPath(actionData.get("root") or "Development")
            requirementsName = actionData.get("requirementsName", "requirements.txt")
            venvDir = self.resolveDeployPath(actionData.get(
                "venvDir",
                getattr(self.ParentWorkThread, "venvDir", ".venv")))
            stopOnError = bool(actionData.get("stopOnError", True))
            skipPrivateGit = bool(actionData.get("skipPrivateGitEditable", True))
            breakSys = bool(actionData.get("useBreakSystemPackages", False))
            editableInstall = bool(actionData.get("editableInstall", False))
            editableTarget = actionData.get("editableTarget", ".")
            verifyImports = actionData.get("verifyImports", []) or []
            requiredExecutables = actionData.get("requiredExecutables", {}) or {}

            reqFiles = [os.path.join(root, requirementsName)]
            extraReqs = actionData.get("extraRequirements")
            if extraReqs is None:
                extraReqs = [os.path.join(root, "glasgow_service", "requirements.txt")]
            for req in extraReqs:
                reqFiles.append(req if os.path.isabs(req) else os.path.join(root, req))

            reqFiles = [req for req in reqFiles if os.path.isfile(req)]
            if not reqFiles:
                self.error("[{}] no requirements files found under {}"
                           .format(type(self).__name__, root))
                self._success = False
                return

            pythonExe = os.path.join(venvDir, "bin", "python")
            if os.path.isfile(pythonExe):
                pipPrefix = "{} -m pip".format(pythonExe)
            else:
                self.warn("[{}] venv python not found at {}; using python3"
                          .format(type(self).__name__, pythonExe))
                pipPrefix = "python3 -m pip"

            self.info("[{}] found {} requirement file(s):"
                      .format(type(self).__name__, len(reqFiles)))
            for req in reqFiles:
                self.info("   - {}".format(req))

            allOk = True
            for req in reqFiles:
                installReq = req
                if skipPrivateGit:
                    installReq = self._writeFilteredRequirements(req)
                    tempFiles.append(installReq)

                cmd = "{} install -r {}".format(pipPrefix, installReq)
                if pipPrefix.startswith("python3 ") and breakSys:
                    cmd += " --break-system-packages"

                self.info("[{}] >> {}".format(type(self).__name__, cmd))
                ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
                if not ok:
                    self.error("[{}] pip install failed for {}\n{}"
                               .format(type(self).__name__, req,
                                       self._stderr.decode(errors="replace")
                                       if self._stderr else "<no stderr>"))
                    allOk = False
                    if stopOnError:
                        break

            if allOk and editableInstall:
                targetPath = editableTarget
                if not os.path.isabs(targetPath):
                    targetPath = os.path.join(root, targetPath)
                targetPath = os.path.abspath(targetPath)
                cmd = "{} install -e {}".format(pipPrefix, shlex.quote(targetPath))
                if pipPrefix.startswith("python3 ") and breakSys:
                    cmd += " --break-system-packages"

                self.info("[{}] >> {}".format(type(self).__name__, cmd))
                ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
                if not ok:
                    self.error("[{}] editable pip install failed for {}\n{}"
                               .format(type(self).__name__, targetPath,
                                       self._stderr.decode(errors="replace")
                                       if self._stderr else "<no stderr>"))
                    allOk = False

            if allOk and requiredExecutables:
                if not isinstance(requiredExecutables, dict):
                    self.error("[{}] requiredExecutables must be an object"
                               .format(type(self).__name__))
                    allOk = False
                else:
                    for executable, packageSpec in requiredExecutables.items():
                        if not re.fullmatch(r"[A-Za-z0-9_.+-]+", str(executable)):
                            self.error("[{}] invalid required executable: {}"
                                       .format(type(self).__name__, executable))
                            allOk = False
                            break
                        executablePath = os.path.join(venvDir, "bin", str(executable))
                        if os.path.isfile(executablePath) and os.access(executablePath, os.X_OK):
                            self.info("[{}] verified venv executable: {}"
                                      .format(type(self).__name__, executablePath))
                            continue
                        cmd = "{} install --ignore-installed {}".format(
                            pipPrefix, shlex.quote(str(packageSpec)))
                        self.info("[{}] materializing venv executable {} >> {}"
                                  .format(type(self).__name__, executable, cmd))
                        ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
                        if not ok or not (os.path.isfile(executablePath) and
                                          os.access(executablePath, os.X_OK)):
                            self.error("[{}] required venv executable missing after install: {}"
                                       .format(type(self).__name__, executablePath))
                            allOk = False
                            if stopOnError:
                                break

            if allOk and verifyImports:
                invalidImports = [
                    name for name in verifyImports
                    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", str(name))
                ]
                if invalidImports:
                    self.error("[{}] invalid verifyImports entries: {}"
                               .format(type(self).__name__, invalidImports))
                    allOk = False
                else:
                    imports = ", ".join(str(name) for name in verifyImports)
                    verifyCode = (
                        "import {imports}; "
                        "print('verified runtime imports: {imports}')"
                    ).format(imports=imports)
                    cmd = "{} -c {}".format(
                        pythonExe if os.path.isfile(pythonExe) else "python3",
                        shlex.quote(verifyCode))
                    self.info("[{}] >> {}".format(type(self).__name__, cmd))
                    ok = await self._runWithTimeout(
                        cmd, self.deployRoot(), timeout)
                    if not ok:
                        self.error(
                            "[{}] runtime dependency verification failed for {}\n{}"
                            .format(
                                type(self).__name__, imports,
                                self._stderr.decode(errors="replace")
                                if self._stderr else "<no stderr>"))
                        allOk = False

            self._success = allOk
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False
        finally:
            for path in tempFiles:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def _writeFilteredRequirements(self, reqPath):
        skipped = []
        kept = []
        with open(reqPath, "r") as src:
            for line in src:
                normalized = line.strip().lower()
                if ("git+https://github.com/naruitechnology/development.git" in normalized or
                        "#egg=iobeam_development" in normalized):
                    skipped.append(line.rstrip())
                    continue
                kept.append(line)

        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix="-requirements.txt", prefix="distribution-deploy-",
            delete=False)
        with tmp:
            tmp.writelines(kept)

        for line in skipped:
            self.warn("[{}] skipped private editable dependency already present "
                      "in deploy tree: {}".format(type(self).__name__, line))
        return tmp.name

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
