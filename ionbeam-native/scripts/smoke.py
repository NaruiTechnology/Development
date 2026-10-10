#!/usr/bin/env python3
"""Launch the real desktop app (``python -m ionbeam_native``) offscreen against
the Glasgow emulator and the mock control-plane backend, let it run, quit, and
check the log. Exit code 0 = healthy. Used by CI and after installs.

    python scripts/smoke.py [--seconds 6] [--keep-logs DIR]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_ROOT))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=6.0)
    ap.add_argument("--keep-logs", help="copy the run log here")
    args = ap.parse_args()

    from ionbeam_native.testing.mock_backend import MockBackend

    backend = MockBackend().start()
    with tempfile.TemporaryDirectory(prefix="ionbeam-smoke-") as tmp:
        env = dict(os.environ)
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        env["XDG_CONFIG_HOME"] = str(Path(tmp) / "xdg")         # fresh preferences
        env["IONBEAM_DEVICE_LOCK"] = str(Path(tmp) / "device.lock")
        env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(APP_ROOT), env.get("PYTHONPATH")]))
        cmd = [sys.executable, "-m", "ionbeam_native", "--emulator", "--api-url", backend.url,
               "--log-dir", tmp, "--smoke-test", str(args.seconds)]
        print("+", " ".join(cmd), flush=True)
        proc = subprocess.run(cmd, env=env, cwd=tmp, capture_output=True, text=True,
                              timeout=args.seconds + 120)
        backend.stop()
        log_file = Path(tmp) / "ionbeam-native.log"
        log = log_file.read_text(encoding="utf-8", errors="replace") if log_file.exists() else ""
        output = proc.stdout + proc.stderr
        if args.keep_logs:
            Path(args.keep_logs).mkdir(parents=True, exist_ok=True)
            (Path(args.keep_logs) / "ionbeam-native.log").write_text(log, encoding="utf-8")
            (Path(args.keep_logs) / "console.txt").write_text(output, encoding="utf-8")
        checks = {
            "exit code 0": proc.returncode == 0,
            "app started": "ionbeam-native started" in log,
            "Glasgow session opened (emulator)": "opening Glasgow (persistent)" in log,
            "control plane reached": any(r["path"] == "/api/status" for r in backend.requests),
            "clean shutdown": "shutting down" in log,
            "no tracebacks": "Traceback" not in output and "Traceback" not in log,
        }
    width = max(map(len, checks))
    for name, ok in checks.items():
        print(f"  {name:<{width}}  {'ok' if ok else 'FAILED'}")
    if not all(checks.values()):
        print(output[-4000:])
        return 1
    print("smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
