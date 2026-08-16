"""Persist deployment environment variables for the current Windows user."""
import os
import winreg

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class exportEnv_state(distributionDeploy_state):
    def __init__(self, parent):
        super(exportEnv_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            exports = actionData.get("exports", {}) or {}
            if not exports:
                self.info("[{}] no environment values declared."
                          .format(type(self).__name__))
                self._success = True
                return

            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                for name, rawValue in exports.items():
                    value = str(self.resolveEnvValue(rawValue))
                    os.environ[str(name)] = value
                    valueType = (winreg.REG_EXPAND_SZ
                                 if "%" in value else winreg.REG_SZ)
                    winreg.SetValueEx(key, str(name), 0, valueType, value)
                    self.info("[{}] persisted {} for the current Windows user"
                              .format(type(self).__name__, name))
            self._success = True
        except Exception as exc:
            self.error("[{}] error: {}".format(type(self).__name__, exc))
            self._success = False
