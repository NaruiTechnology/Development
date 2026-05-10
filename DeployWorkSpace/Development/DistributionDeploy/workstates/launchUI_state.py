#-------------------------------------------------------------------------------
# launchUI_state.py
#
# Final deploy step: open the deployed web UI in the user's default browser.
#
# This is intentionally a custom-DoWork state rather than a shell template:
# webbrowser.open() handles the per-platform launcher (xdg-open on Linux,
# `open` on macOS, the registered protocol handler on Windows) so we don't
# have to embed three OS branches into the JSON commandFormat.
#
# Because launchIonbeamWebFrontend just kicked off `npm run dev` in a
# detached shell and Vite's first-compile takes a few seconds, opening the
# browser immediately would land on a "connection refused" page. The state
# polls the URL for readiness first and only opens the browser once a real
# HTTP response comes back (or the readinessTimeout elapses).
#-------------------------------------------------------------------------------
import asyncio
import urllib.error
import urllib.request
import webbrowser

from buildingblocks.decorators import overrides
from buildingblocks.definitions import Consts

from .distributionDeploy_state import distributionDeploy_state


class launchUI_state(distributionDeploy_state):
    """Open the deployed UI URL in the user's default browser."""

    def __init__(self, parent):
        super(launchUI_state, self).__init__(parent)

    @overrides(distributionDeploy_state)
    async def DoWork(self):
        try:
            stateConfig = self.ParentWorkThread.GetStateConfig(self)
            actionData = (stateConfig or {}).get(Consts.ACTION_DATA, {}) or {}

            url = actionData.get("url", "http://127.0.0.1:5173")
            readinessTimeout = float(actionData.get("readinessTimeout", 30.0))
            pollInterval = float(actionData.get("pollInterval", 0.5))
            failOnNotReady = bool(actionData.get("failOnNotReady", False))

            self.info("[{}] waiting up to {:.1f}s for {} ..."
                      .format(type(self).__name__, readinessTimeout, url))

            ready = await self._waitForReady(url, readinessTimeout, pollInterval)
            if ready:
                self.info("[{}] {} is responding".format(
                    type(self).__name__, url))
            else:
                msg = ("[{}] {} did not respond within {:.1f}s"
                       .format(type(self).__name__, url, readinessTimeout))
                if failOnNotReady:
                    self.error(msg)
                    self._success = False
                    return
                self.warn(msg + " -- opening the browser anyway.")

            try:
                # new=2 = open in a new tab if the browser is already running.
                opened = webbrowser.open(url, new=2)
            except Exception as e:
                # Headless box / no DISPLAY / no registered browser -- log and
                # carry on rather than failing the whole deploy at the very
                # last step. The UI is still reachable at `url` for the user.
                self.warn("[{}] webbrowser.open raised: {}"
                          .format(type(self).__name__, e))
                opened = False

            if opened:
                self.info("[{}] opened {} in default browser"
                          .format(type(self).__name__, url))
            else:
                self.warn("[{}] no browser launched (webbrowser.open returned "
                          "False). UI is still reachable at {}."
                          .format(type(self).__name__, url))

            self._success = True
        except Exception as e:
            self.error("[{}] error: {}".format(type(self).__name__, e))
            self._success = False

    # ---- helpers ---------------------------------------------------------
    async def _waitForReady(self, url, timeout, interval):
        """Poll `url` until any HTTP response comes back, or timeout elapses."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + max(0.0, timeout)
        # First probe immediately -- the frontend may already be up from a
        # prior run, in which case we shouldn't wait `interval` for nothing.
        while True:
            ok = await loop.run_in_executor(None, self._probeOnce, url)
            if ok:
                return True
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(max(0.05, interval))

    @staticmethod
    def _probeOnce(url):
        """Return True if the server at `url` is alive.

        Any HTTP response -- including 4xx/5xx -- counts as "alive" because
        it proves the server is bound and accepting connections. Connection
        refused / DNS / socket errors are treated as "not yet ready".
        """
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=2.0):
                return True
        except urllib.error.HTTPError:
            # Server returned 4xx/5xx -- still alive.
            return True
        except (urllib.error.URLError, OSError):
            return False
        except Exception:
            return False
