"""Entry point: ``python -m ionbeam_native`` (or the ``ionbeam-native`` launcher).

Acquisition runs in-process on a dedicated engine thread that keeps the
Glasgow session open between scans; the control plane (auth, equipment,
vacuum, HV, recording) still goes through the Node backend REST API.
"""
from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import signal
import sys
from pathlib import Path

from .paths import ensure_import_paths, stream_config_path


def _parse(argv):
    ap = argparse.ArgumentParser(prog="ionbeam-native", description="Ion Beam native desktop client")
    ap.add_argument("--config", help="streamData.json (default: GLASGOW_CONFIG or the service discovery rules)")
    ap.add_argument("--api-url", help="Node backend base URL (default: IONBEAM_API_URL or http://127.0.0.1:4000)")
    ap.add_argument("--force-reload", action="store_true", help="re-download the FPGA bitstream on first connect")
    ap.add_argument("--emulator", action="store_true",
                    help="use the built-in byte-level Glasgow emulator instead of USB hardware (demo/CI)")
    ap.add_argument("--log-dir", help="directory for ionbeam-native.log (default: ~/.ionbeam-native/logs)")
    ap.add_argument("--log-level", default=os.environ.get("IONBEAM_LOG_LEVEL", "INFO"))
    ap.add_argument("--smoke-test", type=float, metavar="SECONDS",
                    help="start, run the event loop for SECONDS, then quit (used by CI)")
    return ap.parse_args(argv)


def _setup_logging(args) -> Path:
    log_dir = Path(args.log_dir or Path.home() / ".ionbeam-native" / "logs").expanduser()
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(getattr(logging, str(args.log_level).upper(), logging.INFO))
    fh = logging.handlers.RotatingFileHandler(log_dir / "ionbeam-native.log", maxBytes=5_000_000, backupCount=3)
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(sh)
    return log_dir


def main(argv=None) -> int:
    # pythonw.exe (Windows Start-menu shortcut) has no console streams
    for name in ("stdout", "stderr"):
        if getattr(sys, name) is None:
            setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
    args = _parse(sys.argv[1:] if argv is None else argv)
    log_dir = _setup_logging(args)
    log = logging.getLogger("ionbeam_native")
    ensure_import_paths()
    if args.api_url:
        os.environ["IONBEAM_API_URL"] = args.api_url
    # glasgow_service loggers write their *.log files into the cwd; keep them with ours
    os.chdir(log_dir)

    import json

    from PyQt6.QtCore import QTimer
    from PyQt6.QtGui import QIcon
    from PyQt6.QtWidgets import QApplication

    from . import i18n
    from .backend.client import Backend
    from .engine.artifacts import ArtifactWorker
    from .engine.engine import Engine
    from .engine.service import DesktopDeviceService
    from .ui import theme
    from .ui.common import UiPoster, prefs, shutdown_bg
    from .ui.controller import LOCALE_KEY, THEME_KEY, AppController
    from .ui.main_window import MainWindow

    config_path = Path(args.config).expanduser().resolve() if args.config else stream_config_path()
    if not config_path.is_file():
        log.error("stream config not found: %s", config_path)
        return 2
    stream_config = json.loads(config_path.read_text(encoding="utf-8"))
    if args.emulator and stream_config.get("IsProduction") is not True:
        # the emulator replaces USB on the hardware path, so run that path
        stream_config["IsProduction"] = True
        config_path = log_dir / "emulator-streamData.json"
        config_path.write_text(json.dumps(stream_config, indent=2), encoding="utf-8")

    app = QApplication(sys.argv[:1])
    app.setApplicationName("Ion Beam")
    app.setOrganizationName("Narui Technology")
    icon_path = Path(__file__).parent / "resources" / "images" / "brand-logo.png"
    if icon_path.is_file():
        app.setWindowIcon(QIcon(str(icon_path)))
    p = prefs()
    theme.apply(p.get(THEME_KEY, "navy") or "navy")
    i18n.set_locale(p.get(LOCALE_KEY, "") or i18n.locale())

    service_cls = DesktopDeviceService
    if args.emulator:
        from .testing.fake_glasgow import emulated_service_cls
        service_cls = emulated_service_cls()
        log.warning("running against the Glasgow EMULATOR - no hardware is used")

    poster = UiPoster()
    artifacts = ArtifactWorker(str(config_path))
    engine = Engine(str(config_path), post=poster.post, force_reload=args.force_reload,
                    dump_sink=artifacts.dump, service_cls=service_cls)
    backend = Backend(args.api_url)
    ctl = AppController(engine, backend, artifacts, stream_config)
    window = MainWindow(ctl)
    window.show()
    ctl.start()
    log.info("ionbeam-native started (config=%s, api=%s, emulator=%s)", config_path, backend.base_url,
             args.emulator)

    def _shutdown():
        log.info("shutting down")
        try:
            ctl.shutdown()
            shutdown_bg()
        finally:
            try:
                engine.shutdown()
            finally:
                artifacts.shutdown()

    app.aboutToQuit.connect(_shutdown)
    signal.signal(signal.SIGINT, lambda *_: app.quit())
    # let Python see SIGINT while Qt spins
    tick = QTimer()
    tick.timeout.connect(lambda: None)
    tick.start(250)
    if args.smoke_test:
        QTimer.singleShot(int(args.smoke_test * 1000), app.quit)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
