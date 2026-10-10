"""Build the full desktop app (emulated Glasgow + mock backend) for UI tests and CI smoke runs."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path


class Harness:
    def __init__(self, tmp: Path, *, signed_in: bool = True, production: bool = True, time_scale: float = 1.0):
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        os.environ["XDG_CONFIG_HOME"] = str(tmp / "xdg")
        os.environ["IONBEAM_DEVICE_LOCK"] = str(tmp / "device.lock")
        from PyQt6.QtWidgets import QApplication

        from ionbeam_native.backend.client import Backend
        from ionbeam_native.engine.artifacts import ArtifactWorker
        from ionbeam_native.engine.engine import Engine
        from ionbeam_native.paths import stream_config_path
        from ionbeam_native.testing import fake_glasgow
        from ionbeam_native.testing.mock_backend import MockBackend
        from ionbeam_native.ui import common, theme
        from ionbeam_native.ui.common import UiPoster, prefs
        from ionbeam_native.ui.controller import ADMIN_USER_KEY, AppController
        from ionbeam_native.ui.main_window import MainWindow

        self.app = QApplication.instance() or QApplication(["ionbeam-test"])
        common.PREFS = None
        cfg = json.load(open(stream_config_path()))
        cfg["IsProduction"] = production
        cfg["DumpData"] = False
        self.config_path = tmp / "stream.json"
        self.config_path.write_text(json.dumps(cfg))
        self.backend_mock = MockBackend().start()
        if signed_in:
            prefs().set_json(ADMIN_USER_KEY, self.backend_mock.signed_in_user())
        else:
            prefs().remove(ADMIN_USER_KEY)
        theme.apply("navy")
        cls = fake_glasgow.emulated_service_cls()
        cls.connection_cls.fake_kwargs = {"time_scale": time_scale}
        self.poster = UiPoster()
        self.artifacts = ArtifactWorker(str(self.config_path))
        self.engine = Engine(str(self.config_path), post=self.poster.post, dump_sink=self.artifacts.dump,
                             service_cls=cls)
        self.ctl = AppController(self.engine, Backend(self.backend_mock.url), self.artifacts, cfg)
        self.win = MainWindow(self.ctl)
        self.win.resize(1600, 1000)
        self.win.show()
        self.ctl.start()
        self.pump(0.5)

    def pump(self, seconds: float = 0.1) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.app.processEvents()
            time.sleep(0.005)

    def wait(self, pred, timeout: float = 20.0, what: str = "condition") -> None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.app.processEvents()
            if pred():
                return
            time.sleep(0.01)
        raise TimeoutError(f"timed out waiting for {what}")

    def shot(self, path) -> None:
        self.pump(0.2)
        self.win.grab().save(str(path))

    def close(self) -> None:
        self.win.close()
        try:
            self.ctl.shutdown()
            from ionbeam_native.ui.common import shutdown_bg
            shutdown_bg()
        finally:
            self.engine.shutdown()
            self.artifacts.shutdown()
            self.backend_mock.stop()
            self.win.deleteLater()
            self.pump(0.1)
