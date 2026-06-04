#-------------------------------------------------------------------------------
# longRunShellLaunch_state.py
#
# Host a long-running service from a persistent shell and return immediately.
# On Windows this differs from a simple detached process: the service command is
# written to a .cmd wrapper and launched under `cmd.exe /k`, so the shell remains
# the owning host for uvicorn/npm dev servers after this deploy state completes.
#-------------------------------------------------------------------------------
import os
import re
import subprocess
from types import SimpleNamespace

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .detachedShellLaunch_state import detachedShellLaunch_state


class longRunShellLaunch_state(detachedShellLaunch_state):
    """Start a service command in a persistent host shell."""

    def __init__(self, parent):
        super(longRunShellLaunch_state, self).__init__(parent)

    @overrides(detachedShellLaunch_state)
    async def DoWork(self):
        if os.name != "nt":
            await super(longRunShellLaunch_state, self).DoWork()
            return

        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            runDir = actionData.get("dir") or actionData.get("root")
            command = actionData.get("command")
            logPath = actionData.get("log", r"C:\Project\Iobeam\Deploy\Logs\service.log")
            pidPath = actionData.get("pid")
            venvActivate = actionData.get("venvActivate", "")
            exports = actionData.get("exports", {}) or {}
            title = actionData.get("title", type(self).__name__)
            spawnTerminal = bool(actionData.get("spawnTerminal", True))

            if not runDir or not command:
                self.error("[{}] actionData must include 'dir'/'root' and 'command'."
                           .format(type(self).__name__))
                self._success = False
                return
            if not os.path.isdir(runDir):
                self.error("[{}] run directory does not exist: {}"
                           .format(type(self).__name__, runDir))
                self._success = False
                return

            scriptPath = self._writeWindowsHostScript(
                runDir, command, logPath, venvActivate, exports, title, spawnTerminal)
            proc = self._launchWindowsHostShell(scriptPath, title, spawnTerminal)

            if pidPath:
                os.makedirs(os.path.dirname(pidPath) or ".", exist_ok=True)
                with open(pidPath, "w") as f:
                    f.write("{}\n".format(proc.pid))

            self._success = True
            self.info("[{}] launched long-running Windows shell. pid={} log={} host={}"
                      .format(type(self).__name__, proc.pid, logPath, scriptPath))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _writeWindowsHostScript(self, runDir, command, logPath, venvActivate, exports, title,
                                showOutput):
        logDir = os.path.dirname(logPath) or "."
        os.makedirs(logDir, exist_ok=True)

        scriptName = "{}.cmd".format(self._safeFileStem(title or type(self).__name__))
        scriptPath = os.path.join(logDir, scriptName)

        lines = [
            "@echo off",
            "title {}".format(title),
            "setlocal",
            "cd /d {}".format(self._cmdQuote(runDir)),
            "set \"IONBEAM_SERVICE_TITLE={}\"".format(title),
        ]

        scriptsDir = self._scriptsDirFromActivate(venvActivate)
        if scriptsDir:
            venvDir = os.path.dirname(scriptsDir)
            lines.append("set \"VIRTUAL_ENV={}\"".format(venvDir))
            lines.append("set \"PATH={};%PATH%\"".format(scriptsDir))

        for key, value in exports.items():
            lines.append("set \"{}={}\"".format(str(key), str(value)))

        lines.extend([
            "echo ================================================== > {}".format(self._cmdQuote(logPath)),
            "echo [%DATE% %TIME%] Starting %IONBEAM_SERVICE_TITLE% >> {}".format(self._cmdQuote(logPath)),
            "echo Working directory: %CD% >> {}".format(self._cmdQuote(logPath)),
            "echo Command: {} >> {}".format(command, self._cmdQuote(logPath)),
            "echo ==================================================",
            "echo [%DATE% %TIME%] Starting %IONBEAM_SERVICE_TITLE%",
            "echo Working directory: %CD%",
            "echo Command: {}".format(command),
            "echo.",
            self._hostCommand(command, logPath, showOutput),
            "set \"IONBEAM_EXITCODE=%ERRORLEVEL%\"",
            "echo [%DATE% %TIME%] %IONBEAM_SERVICE_TITLE% exited with %IONBEAM_EXITCODE% >> {}".format(self._cmdQuote(logPath)),
            "echo.",
            "echo [%DATE% %TIME%] %IONBEAM_SERVICE_TITLE% exited with %IONBEAM_EXITCODE%",
            "echo This host shell remains open for diagnostics. Close this window to stop reviewing it.",
        ])

        with open(scriptPath, "w", newline="\r\n") as f:
            f.write("\n".join(lines) + "\n")
        return scriptPath

    def _hostCommand(self, command, logPath, showOutput):
        return "call {} >> {} 2>&1".format(command, self._cmdQuote(logPath))

    def _launchWindowsHostShell(self, scriptPath, title, spawnTerminal):
        creationFlags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        if spawnTerminal:
            return self._startVisibleWindowsConsole(scriptPath, title)

        creationFlags |= getattr(subprocess, "CREATE_NO_WINDOW", 0)

        # Hidden cmd.exe (CREATE_NO_WINDOW): there is no console to display
        # anything anyway, and the wrapper redirects everything to the log
        # file via `>> {logPath} 2>&1`. DEVNULL the parent-side handles to
        # keep them from dangling.
        return subprocess.Popen(
            ["cmd.exe", "/d", "/k", scriptPath],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationFlags)

    def _startVisibleWindowsConsole(self, scriptPath, title):
        # Shelling through Start-Process is more reliable than CREATE_NEW_CONSOLE
        # when the deploy app was itself started from a hidden/non-interactive
        # parent. It asks Windows Explorer/session shell to create a normal
        # visible console window and gives us the cmd.exe PID for the pid file.
        script = self._psQuote(scriptPath)
        ps = (
            "$p = Start-Process -FilePath 'cmd.exe' "
            "-ArgumentList @('/d','/k', {script}) "
            "-WindowStyle Normal "
            "-PassThru; "
            "Write-Output $p.Id"
        ).format(script=script)
        completed = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True)
        pidText = completed.stdout.strip().splitlines()[-1]
        return SimpleNamespace(pid=int(pidText))

    def _scriptsDirFromActivate(self, venvActivate):
        if not venvActivate:
            return ""
        scriptsDir = os.path.dirname(venvActivate)
        if os.path.isdir(scriptsDir):
            return scriptsDir
        return ""

    def _safeFileStem(self, title):
        stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(title)).strip(".-")
        return stem or type(self).__name__

    def _cmdQuote(self, value):
        return '"{}"'.format(str(value).replace('"', r'\"'))

    def _psQuote(self, value):
        return "'{}'".format(str(value).replace("'", "''"))
