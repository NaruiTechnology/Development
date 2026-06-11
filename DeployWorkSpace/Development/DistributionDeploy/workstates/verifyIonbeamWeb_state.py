#-------------------------------------------------------------------------------
# verifyIonbeamWeb_state.py
#
# Confirm the ionbeam-web backend and frontend are reachable after launch.
#-------------------------------------------------------------------------------
import asyncio
import json
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
            stateConfig = self.resolvedStateConfig(stateConfig)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}
            mobilityOnly = self.deploymentValue("MobilityOnly", False)
            checks = actionData.get("checks") or actionData.get("urls") or [
                "http://127.0.0.1:4000/healthz",
                "http://127.0.0.1:5173/",
            ]
            if mobilityOnly:
                checks = [
                    "http://127.0.0.1:4000/healthz",
                    "http://127.0.0.1:5173/mobility",
                ]
            delay = float(actionData.get("initialDelay", 3.0))
            pollInterval = float(actionData.get("pollInterval", 1.0))
            timeout = float((stateConfig or {}).get(Consts.TIMEOUT, 30.0) or 30.0)

            if delay > 0:
                await asyncio.sleep(delay)

            deadline = time.monotonic() + timeout
            pending = [self._normalizeCheck(check) for check in checks]
            lastErrors = {}
            while pending and time.monotonic() < deadline:
                for check in list(pending):
                    ok, detail = self._checkUrl(check)
                    url = check["url"]
                    if ok:
                        self.info("[{}] OK {}".format(type(self).__name__, url))
                        pending.remove(check)
                    else:
                        lastErrors[url] = detail
                if pending:
                    await asyncio.sleep(pollInterval)

            if pending:
                self.error("[{}] web service readiness failed:\n{}"
                           .format(type(self).__name__, "\n".join(
                               "{} -> {}".format(check["url"], lastErrors.get(check["url"], "not ready"))
                               for check in sorted(pending, key=lambda item: item["url"]))))
                self._success = False
                return

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    def _normalizeCheck(self, check):
        if isinstance(check, dict):
            url = str(check.get("url", "")).strip()
            statuses = check.get("expectedStatuses") or check.get("expectedStatus") or [200]
            if isinstance(statuses, int):
                statuses = [statuses]
            contains = check.get("contains")
            jsonContains = check.get("jsonContains")
            return {
                "url": url,
                "expectedStatuses": {int(s) for s in statuses},
                "contains": str(contains) if contains is not None else None,
                "jsonContains": jsonContains if isinstance(jsonContains, dict) else None,
            }
        return {
            "url": str(check).strip(),
            "expectedStatuses": {200},
            "contains": None,
            "jsonContains": None,
        }

    def _checkUrl(self, check):
        url = check["url"]
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "DistributionDeploy"})
            with urllib.request.urlopen(req, timeout=3.0) as response:
                status = getattr(response, "status", response.getcode())
                body = response.read().decode("utf-8", errors="replace")
                return self._checkResponse(check, status, body)
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="replace")
            except Exception:
                body = ""
            return self._checkResponse(check, e.code, body)
        except Exception as e:
            return False, str(e)

    def _checkResponse(self, check, status, body):
        if status not in check["expectedStatuses"]:
            return False, "HTTP {}".format(status)
        contains = check.get("contains")
        if contains is not None and contains not in body:
            return False, "HTTP {} body missing {!r}".format(status, contains)
        jsonContains = check.get("jsonContains")
        if jsonContains:
            try:
                data = json.loads(body)
            except ValueError as e:
                return False, "HTTP {} invalid JSON: {}".format(status, e)
            for key, expected in jsonContains.items():
                if data.get(key) != expected:
                    return False, "HTTP {} JSON {}={!r}, expected {!r}".format(
                        status, key, data.get(key), expected)
        return True, "HTTP {}".format(status)
