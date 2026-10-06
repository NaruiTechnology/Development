"""Install Google Chrome when absent and register it as the default browser."""
import asyncio
import shlex

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class installGoogleChrome_state(distributionDeploy_state):
    def __init__(self, parent):
        super(installGoogleChrome_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 900.0) or 900.0)
            policyPath = str(actionData.get(
                "downloadPolicyPath", "/etc/opt/chrome/policies/managed/iobeam-downloads.json"))

            # Chrome duplicates are normally renamed by the browser. Enabling
            # the save-location prompt gives the native save dialog a chance
            # to ask before replacing a same-named file.
            script = r'''set -e
if ! command -v google-chrome >/dev/null 2>&1; then
  sudo -n true
  sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update
  sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ca-certificates curl gnupg xdg-utils
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | sudo gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg
  sudo chmod 0644 /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 update
  sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y google-chrome-stable
fi
command -v google-chrome >/dev/null
if command -v xdg-settings >/dev/null 2>&1; then
  xdg-settings set default-web-browser google-chrome.desktop || true
fi
if command -v update-alternatives >/dev/null 2>&1 && [ -x /usr/bin/google-chrome ]; then
  sudo update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/bin/google-chrome 200
  sudo update-alternatives --set x-www-browser /usr/bin/google-chrome
fi
sudo install -d -m 0755 "$(dirname POLICY_PATH)"
printf '{"PromptForDownloadLocation":true}\n' | sudo tee POLICY_PATH >/dev/null
sudo chmod 0644 POLICY_PATH
'''.replace("POLICY_PATH", shlex.quote(policyPath))
            command = "bash -c {}".format(shlex.quote(script))
            self.info("[{}] checking/installing Google Chrome and configuring download prompts"
                      .format(type(self).__name__))
            try:
                self._success = await asyncio.wait_for(
                    self.commandAsyncio(command, self.deployRoot(), verbose=True),
                    timeout=timeout)
            except asyncio.TimeoutError:
                self.error("[{}] TIMEOUT after {}s".format(type(self).__name__, timeout))
                self._success = False
            if not self._success:
                self.error("[{}] Chrome setup failed\n{}".format(
                    type(self).__name__,
                    self._stderr.decode(errors="replace") if self._stderr else "<no stderr>"))
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
