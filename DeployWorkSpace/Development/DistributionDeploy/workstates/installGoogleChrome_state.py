"""Install Google Chrome, make it the default browser and pin it to the dock."""
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
# Run as the desktop user, never through sudo: favorites belong to that user.
# Do this even when Chrome was already installed, preserving all other pins.
python3 - <<'PIN_CHROME'
import ast
import os
import subprocess

if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
    bus = "/run/user/{}/bus".format(os.getuid())
    if os.path.exists(bus):
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + bus

def favorites():
    value = subprocess.check_output(
        ["gsettings", "get", "org.gnome.shell", "favorite-apps"], text=True).strip()
    # GVariant prints an empty string array with its type annotation.
    return ast.literal_eval(value.removeprefix("@as "))

desktop_id = "google-chrome.desktop"
apps = favorites()
if desktop_id not in apps:
    subprocess.run(
        ["gsettings", "set", "org.gnome.shell", "favorite-apps",
         repr(apps + [desktop_id])], check=True)
if desktop_id not in favorites():
    raise RuntimeError("Google Chrome could not be pinned to the toolbox panel")
print("Google Chrome is pinned to the toolbox panel")
PIN_CHROME
'''.replace("POLICY_PATH", shlex.quote(policyPath))
            command = "bash -c {}".format(shlex.quote(script))
            self.info("[{}] checking/installing Google Chrome, configuring download prompts and pinning to the toolbox panel"
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
