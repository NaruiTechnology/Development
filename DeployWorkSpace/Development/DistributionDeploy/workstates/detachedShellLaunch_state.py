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
import signal
import subprocess
import time

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
            port = actionData.get("port")
            stopPatterns = actionData.get("stopPatterns") or []
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

            if not self._stopExisting(pidPath, port, stopPatterns):
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

            launched = False
            if spawnTerminal:
                launched = self._launchTerminal(title, shellCommand, logPath, pidPath)
            if not launched:
                self._launchDetached(shellCommand, runDir, logPath, pidPath)

            if port and not self._waitForPort(port, actionData.get("readinessTimeout", 20.0)):
                self.error("[{}] service did not listen on port {}. log={}"
                           .format(type(self).__name__, port, logPath))
                self._success = False
                return

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

    def _stopExisting(self, pidPath, port, stopPatterns):
        pids = set()
        pidFilePids = set()
        if pidPath and os.path.isfile(pidPath):
            try:
                with open(pidPath, "r", encoding="utf-8") as f:
                    raw = f.read().strip()
                if raw.isdigit():
                    pidFilePids.add(int(raw))
                    pids.update(pidFilePids)
            except OSError as e:
                self.warn("[{}] could not read pid file {}: {}"
                          .format(type(self).__name__, pidPath, e))

        if port:
            pids.update(self._portPids(port))
        for pattern in stopPatterns:
            pids.update(self._patternPids(str(pattern)))

        pids = self._expandProcessTreePids(pids)
        pids.discard(os.getpid())
        if not pids:
            return True

        self.info("[{}] stopping existing process(es): {}"
                  .format(type(self).__name__, ", ".join(str(pid) for pid in sorted(pids))))
        for sig, attempts in ((signal.SIGTERM, 20), (signal.SIGKILL, 6)):
            pids = self._expandProcessTreePids(pids)
            for pid in sorted(pids):
                self._killProcessGroupOrPid(pid, sig)
            for _ in range(attempts):
                alive = {pid for pid in pids if self._pidAlive(pid)}
                if port:
                    alive.update(self._portPids(port))
                for pattern in stopPatterns:
                    alive.update(self._patternPids(str(pattern)))
                alive = self._expandProcessTreePids(alive)
                alive.discard(os.getpid())
                if not alive:
                    if pidPath:
                        try:
                            os.remove(pidPath)
                        except OSError:
                            pass
                    return True
                pids = alive
                time.sleep(0.25)

        servicePids = set()
        if port:
            servicePids.update(self._portPids(port))
        for pattern in stopPatterns:
            servicePids.update(self._patternPids(str(pattern)))
        servicePids = self._expandProcessTreePids(servicePids)
        servicePids.discard(os.getpid())
        if not servicePids and pids.issubset(pidFilePids):
            self.warn("[{}] ignoring stale pid file {}; pid(s) no longer match service: {}"
                      .format(type(self).__name__, pidPath,
                              ", ".join(str(pid) for pid in sorted(pids))))
            if pidPath:
                try:
                    os.remove(pidPath)
                except OSError:
                    pass
            return True

        self.error("[{}] existing process(es) did not stop: {}"
                   .format(type(self).__name__, ", ".join(str(pid) for pid in sorted(pids))))
        return False

    def _expandProcessTreePids(self, pids):
        expanded = {int(pid) for pid in pids if self._pidAlive(pid)}
        pending = list(expanded)
        while pending:
            pid = pending.pop()
            for childPid in self._childPids(pid):
                if childPid not in expanded:
                    expanded.add(childPid)
                    pending.append(childPid)
        return expanded

    def _childPids(self, pid):
        try:
            proc = subprocess.run(
                ["pgrep", "-P", str(int(pid))],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False)
        except Exception:
            return set()

        return {
            int(line.strip())
            for line in proc.stdout.splitlines()
            if line.strip().isdigit()
        }

    def _killProcessGroupOrPid(self, pid, sig):
        try:
            pgid = os.getpgid(pid)
            if pgid != os.getpgrp():
                os.killpg(pgid, sig)
                return
        except ProcessLookupError:
            return
        except OSError:
            pass

        try:
            os.killpg(pid, sig)
            return
        except ProcessLookupError:
            return
        except OSError:
            pass
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            return
        except OSError as e:
            self.warn("[{}] could not signal pid {}: {}"
                      .format(type(self).__name__, pid, e))

    def _pidAlive(self, pid):
        statPath = "/proc/{}/stat".format(int(pid))
        try:
            with open(statPath, "r", encoding="utf-8") as f:
                fields = f.read().split()
            if len(fields) > 2 and fields[2] == "Z":
                return False
        except FileNotFoundError:
            return False
        except OSError:
            pass

        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except OSError:
            return True

    def _portPids(self, port):
        try:
            proc = subprocess.run(
                ["bash", "-lc", "ss -ltnp 'sport = :{}' 2>/dev/null".format(int(port))],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False)
        except Exception:
            return set()

        pids = set()
        for token in proc.stdout.replace(",", " ").split():
            if token.startswith("pid="):
                raw = token.split("=", 1)[1]
                if raw.isdigit():
                    pids.add(int(raw))
        if not pids:
            pids.update(self._fuserPortPids(port))
        return pids

    def _fuserPortPids(self, port):
        commands = [
            ["fuser", "-n", "tcp", str(int(port))],
            ["sudo", "-n", "fuser", "-n", "tcp", str(int(port))],
        ]
        for cmd in commands:
            try:
                proc = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False)
            except Exception:
                continue
            pids = {
                int(token)
                for token in proc.stdout.replace(":", " ").split()
                if token.isdigit()
            }
            if pids:
                return pids
        return set()

    def _patternPids(self, pattern):
        pattern = pattern.strip()
        if not pattern:
            return set()
        try:
            proc = subprocess.run(
                ["pgrep", "-f", pattern],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False)
        except Exception:
            return set()

        pids = set()
        for line in proc.stdout.splitlines():
            raw = line.strip()
            if raw.isdigit():
                pids.add(int(raw))
        pids.discard(os.getpid())
        return pids

    def _waitForPort(self, port, timeout):
        deadline = time.monotonic() + float(timeout or 0.0)
        while time.monotonic() <= deadline:
            if self._portListening(port):
                return True
            time.sleep(0.25)
        return False

    def _portListening(self, port):
        try:
            proc = subprocess.run(
                ["bash", "-lc", "ss -ltn 'sport = :{}' 2>/dev/null".format(int(port))],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False)
        except Exception:
            return False
        return ":{}".format(int(port)) in proc.stdout

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
