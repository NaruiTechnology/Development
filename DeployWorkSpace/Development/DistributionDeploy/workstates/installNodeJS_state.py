#-------------------------------------------------------------------------------
# installNodeJS_state.py
#
# Install Node.js via nvm. The canonical one-liner -- 
#   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# -- only writes nvm config into ~/.bashrc; it does NOT install Node itself.
# So this state runs a 3-stage bash script:
#
#   1. Download + run the nvm installer.
#   2. Source ~/.bashrc (or the nvm.sh stub directly) inside the same bash
#      process so `nvm` is on PATH.
#   3. nvm install <nodeVersion> (default --lts) and `nvm alias default ...`.
#
# Reading nvm.sh directly is the more reliable path -- ~/.bashrc on a fresh
# Ubuntu shell early-exits for non-interactive shells, which would silently
# drop the nvm export.
#
# Action data fields recognised:
#   nvmInstaller     URL of the nvm install.sh
#   nodeVersion      version arg passed to `nvm install` (default '--lts')
#-------------------------------------------------------------------------------
import asyncio
import os
import stat
import tempfile

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


_DEFAULT_NVM_URL = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh"

# Standard system PATH guaranteed to contain curl, bash, etc.
# asyncio.create_subprocess_shell inherits the Python process env, which on
# some systems (systemd services, minimal containers) strips PATH down to
# nothing useful.  We re-export a sane default before running anything.
_SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class installNodeJS_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installNodeJS_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        script_path = None
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            nvmUrl  = actionData.get("nvmInstaller", _DEFAULT_NVM_URL)
            nodeVer = actionData.get("nodeVersion", "--lts")
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 0.0) or 0.0)

            # Write the install logic to a temp file so there are zero quoting
            # issues and PATH is explicitly bootstrapped before curl/nvm run.
            # nvm alias needs a concrete version (e.g. v22.1.0), not the flag
            # "--lts", so we resolve it with `nvm current` after install.
            script_lines = [
                "#!/usr/bin/env bash",
                "set -e",
                # Bootstrap PATH so standard tools are reachable even when this
                # process was spawned with a stripped environment (systemd, etc.)
                "export PATH={safe}:$PATH".format(safe=_SAFE_PATH),
                "if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then",
                "  echo 'Using existing Node.js/npm from PATH'",
                "  node --version",
                "  npm --version",
                "  exit 0",
                "fi",
                # curl may not be present on a fresh/minimal system -- install it
                # before attempting to fetch the nvm installer.
                "command -v curl >/dev/null 2>&1 || { "
                    "sudo apt-get -o DPkg::Lock::Timeout=600 update -qq && "
                    "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq curl; "
                "}",
                "curl -fsSL -o- {url} | bash".format(url=nvmUrl),
                'export NVM_DIR="$HOME/.nvm"',
                '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
                "set +e",
                "nvm install {ver}".format(ver=nodeVer),
                "install_status=$?",
                "set -e",
                "if [ \"$install_status\" -ne 0 ]; then",
                "  resolved=\"$(nvm version {ver} 2>/dev/null || true)\"".format(ver=nodeVer),
                "  if [ -n \"$resolved\" ] && [ \"$resolved\" != \"N/A\" ]; then",
                "    nvm use --delete-prefix \"$resolved\"",
                "  else",
                "    exit \"$install_status\"",
                "  fi",
                "fi",
                # $(nvm current) gives the concrete version string (e.g. v22.1.0)
                # that nvm alias requires -- passing {ver} directly fails when
                # nodeVer is a flag like --lts.
                "nvm alias default $(nvm current)",
                "node --version",
                "npm --version",
            ]

            with tempfile.NamedTemporaryFile(
                    mode="w", suffix=".sh", delete=False) as f:
                f.write("\n".join(script_lines) + "\n")
                script_path = f.name

            os.chmod(script_path, stat.S_IRWXU)

            cmd = "bash {}".format(script_path)
            self.info("[{}] installing Node.js via nvm ({})..."
                      .format(type(self).__name__, nodeVer))

            ok = await self._runWithTimeout(cmd, self.deployRoot(), timeout)
            self.Success = ok
            if not ok:
                self.error("[{}] nvm/node install failed.\n{}".format(
                    type(self).__name__,
                    self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self.Success = False
        finally:
            if script_path and os.path.exists(script_path):
                os.unlink(script_path)

    async def _runWithTimeout(self, cmd, runDir, timeout):
        if timeout and timeout > 0:
            try:
                return await asyncio.wait_for(
                    self.commandAsyncio(cmd, runDir, verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] timed out after {}s"
                           .format(type(self).__name__, timeout))
                return False
        return await self.commandAsyncio(cmd, runDir, verbose=True)
