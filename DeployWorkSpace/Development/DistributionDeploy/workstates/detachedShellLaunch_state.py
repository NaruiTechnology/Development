#-------------------------------------------------------------------------------
# detachedShellLaunch_state.py
#
# Launch a long-running service in its own shell/session and return immediately.
# This is for workflow steps such as uvicorn and npm dev servers where the
# child process is expected to stay alive after the deploy state completes.
#-------------------------------------------------------------------------------
import os
import shlex
import shutil
import subprocess

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class detachedShellLaunch_state(distributionDeploy_state):
    """Start a long-running command in a separate shell/session."""

    def __init__(self, parent):
        super(detachedShellLaunch_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            runDir = actionData.get("dir") or actionData.get("root")
            if runDir:
                runDir = self.resolveDeployPath(runDir)
            command = actionData.get("command")
            logPath = actionData.get("log", "/tmp/distribution-deploy-service.log")
            pidPath = actionData.get("pid")
            venvActivate = actionData.get("venvActivate", "")
            if venvActivate:
                venvActivate = self.resolveDeployPath(venvActivate)
            exports = actionData.get("exports", {}) or {}
            useNvm = bool(actionData.get("useNvm", False))
            nvmDir = actionData.get("nvmDir", "$HOME/.nvm")
            title = actionData.get("title", type(self).__name__)
            spawnTerminal = bool(actionData.get("spawnTerminal", False))

            if not runDir or not command:
                self.error("[{}] actionData must include 'dir'/'root' and 'command'."
                           .format(type(self).__name__))
                self.Success = False
                return
            if not os.path.isdir(runDir):
                self.error("[{}] run directory does not exist: {}"
                           .format(type(self).__name__, runDir))
                self.Success = False
                return

            shellParts = ["cd {}".format(shlex.quote(runDir))]
            if venvActivate:
                if not os.path.isfile(venvActivate):
                    self.error("[{}] venv activate script does not exist: {}"
                               .format(type(self).__name__, venvActivate))
                    self.Success = False
                    return
                shellParts.append(". {}".format(shlex.quote(venvActivate)))
            if useNvm:
                shellParts.append("export NVM_DIR={}".format(nvmDir))
                shellParts.append('if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi')
            for key, val in exports.items():
                shellParts.append("export {}={}".format(
                    key, shlex.quote(str(self.resolveEnvValue(val)))))
            shellParts.append(command)
            shellCommand = " && ".join(shellParts)

            if spawnTerminal and self._launchTerminal(title, shellCommand, logPath, pidPath):
                self._success = True
                return

            self._launchDetached(shellCommand, runDir, logPath, pidPath)
            self._success = True
            self.info("[{}] launched in detached shell. log={}"
                      .format(type(self).__name__, logPath))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self.Success = False

    def _launchDetached(self, shellCommand, runDir, logPath, pidPath):
        os.makedirs(os.path.dirname(logPath) or ".", exist_ok=True)
        logFile = open(logPath, "ab", buffering=0)
        proc = subprocess.Popen(
            ["bash", "-lc", shellCommand],
            cwd=runDir,
            stdin=subprocess.DEVNULL,
            stdout=logFile,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True)

        if pidPath:
            with open(pidPath, "w") as f:
                f.write("{}\n".format(proc.pid))

    def _launchTerminal(self, title, shellCommand, logPath, pidPath):
        if not os.environ.get("DISPLAY"):
            return False

        terminalCommand = self._wrapTerminalLogging(shellCommand, logPath, pidPath)
        keepOpen = "{}; echo; echo '[{} exited]'; exec bash".format(
            terminalCommand, title.replace("'", ""))
        terminals = [
            ("gnome-terminal", ["gnome-terminal", "--title", title, "--",
                                "bash", "-lc", keepOpen]),
            ("xfce4-terminal", ["xfce4-terminal", "--title", title, "--command",
                                "bash -lc {}".format(shlex.quote(keepOpen))]),
            ("konsole", ["konsole", "--new-tab", "-p", "tabtitle={}".format(title),
                         "-e", "bash", "-lc", keepOpen]),
            ("xterm", ["xterm", "-T", title, "-e", "bash", "-lc", keepOpen]),
        ]

        for executable, cmd in terminals:
            if shutil.which(executable):
                subprocess.Popen(cmd, start_new_session=True, close_fds=True)
                self.info("[{}] launched in terminal: {}"
                          .format(type(self).__name__, executable))
                return True
        return False

    def _wrapTerminalLogging(self, shellCommand, logPath, pidPath):
        os.makedirs(os.path.dirname(logPath) or ".", exist_ok=True)
        parts = []
        if pidPath:
            parts.append("echo $$ > {}".format(shlex.quote(pidPath)))
        parts.append("exec > >(tee -a {}) 2>&1".format(shlex.quote(logPath)))
        parts.append(shellCommand)
        return "; ".join(parts)
