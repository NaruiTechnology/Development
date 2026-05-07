#-------------------------------------------------------------------------------
# verifyIonbeamWeb_state.py
#
# Confirm the ionbeam-web backend and frontend are reachable after launch.
#-------------------------------------------------------------------------------
import asyncio
import time
import urllib.error
import urllib.request

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class verifyIonbeamWeb_state(distributionDeploy_state):
    def __init__(self, parent):
        super(verifyIonbeamWeb_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            urls = actionData.get("urls") or [
                "http://127.0.0.1:4000/healthz",
                "http://127.0.0.1:5173/",
            ]
            delay = float(actionData.get("initialDelay", 3.0))
            pollInterval = float(actionData.get("pollInterval", 1.0))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 30.0) or 30.0)

            if delay > 0:
                await asyncio.sleep(delay)

            deadline = time.monotonic() + timeout
            pending = set(urls)
            lastErrors = {}
            while pending and time.monotonic() < deadline:
                for url in list(pending):
                    ok, detail = self._checkUrl(url)
                    if ok:
                        self.info("[{}] OK {}".format(type(self).__name__, url))
                        pending.remove(url)
                    else:
                        lastErrors[url] = detail
                if pending:
                    await asyncio.sleep(pollInterval)

            if pending:
                self.error("[{}] web service readiness failed:\n{}"
                           .format(type(self).__name__, "\n".join(
                               "{} -> {}".format(url, lastErrors.get(url, "not ready"))
                               for url in sorted(pending))))
                self._success = False
                return

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _checkUrl(self, url):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "DistributionDeploy"})
            with urllib.request.urlopen(req, timeout=3.0) as response:
                status = getattr(response, "status", response.getcode())
                return 200 <= status < 500, "HTTP {}".format(status)
        except urllib.error.HTTPError as e:
            return e.code < 500, "HTTP {}".format(e.code)
        except Exception as e:
            return False, str(e)
