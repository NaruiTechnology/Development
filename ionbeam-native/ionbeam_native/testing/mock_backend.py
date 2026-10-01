"""Minimal stand-in for the Node backend control plane (tests, CI smoke runs, demos).

Implements only the endpoints the desktop client calls, with the same JSON
shapes as ionbeam-web/backend. Every request is recorded in ``requests`` so
tests can assert what the client sent (e.g. the operation input-setup /
output-data recording bodies).

    python -m ionbeam_native.testing.mock_backend --port 4000
"""
from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import urlparse

USER = {"id": 1, "login_name": "admin", "name": "Admin", "role": 2, "is_active": True,
        "phone": "", "email": "", "site": "Beijing(北京)", "expires_at": None}


class MockBackend:
    def __init__(self, port: int = 0, *, vacuum_enabled: bool = False, role: int = 2):
        self.requests: list = []
        self.vacuum_enabled = vacuum_enabled
        self.user = {**USER, "role": role}
        self.dim_cal: dict = {}
        self._activity = 0
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_a):
                pass

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    return json.loads(raw) if raw else None
                except ValueError:
                    return None

            def _send(self, code, obj):
                data = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                path = urlparse(self.path).path
                body = self._body() if method in ("POST", "PUT") else None
                with outer._lock:
                    outer.requests.append({"method": method, "path": path, "body": body,
                                           "auth": self.headers.get("X-Iobeam-Auth", "")})
                code, obj = outer.route(method, path, body)
                self._send(code, obj)

            def do_GET(self):  # noqa: N802
                self._handle("GET")

            def do_POST(self):  # noqa: N802
                self._handle("POST")

            def do_PUT(self):  # noqa: N802
                self._handle("PUT")

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread: Optional[threading.Thread] = None

    # signed-in user blob as the web app keeps it in localStorage
    def signed_in_user(self) -> dict:
        return {**self.user, "session_token": "mock-token"}

    def route(self, method: str, path: str, body):
        if path == "/api/status":
            return 200, {"ok": True, "vacuum_enabled": self.vacuum_enabled}
        if path == "/api/vacuum":
            return 200, {"isVacuumSystemReady": True, "high_voltage_power": False, "pumps": []}
        if path == "/api/admin/iobeam/auth/current-account":
            return 200, {"ok": True, "registered": True, "session_expired": False,
                         "login": self.user["login_name"], "user": self.user}
        if path == "/api/admin/iobeam/auth/users":
            return 200, {"ok": True, "users": [self.user]}
        if path == "/api/admin/iobeam/equipment":
            return 200, {"ok": True, "equipment": [{"id": 1, "name": "Mock FIB", "model": "IB-1", "site": ""}]}
        if path.startswith("/api/admin/iobeam/dimension-calibration/"):
            if method == "PUT":
                self.dim_cal = body or {}
                return 200, {"ok": True}
            return (200, {"ok": True, "calibration": self.dim_cal}) if self.dim_cal else (404, {"ok": False})
        if path == "/api/admin/scan-geometry":
            return 200, {"ok": True, "scan_geometry": {"enabled": False}}
        if path == "/api/admin/iobeam/db/status":
            return 200, {"ok": True, "connected": True}
        if path == "/api/admin/iobeam/config":
            return 200, {"ok": True, "config": {}}
        if path == "/api/admin/mag-calibration":
            return 200, {"ok": True, "calibration": None} if method == "GET" else {"ok": True}
        if path == "/api/admin/iobeam/operation/input-setup":
            with self._lock:
                self._activity += 1
                return 200, {"ok": True, "activity_id": self._activity}
        if path == "/api/admin/iobeam/operation/output-data":
            return 200, {"ok": True}
        if path == "/api/admin/iobeam/reports/activity":
            return 200, {"ok": True, "rows": [], "total": 0}
        if path == "/api/stage":
            return 200, {"ok": True, "enabled": False}
        return 404, {"ok": False, "error": f"mock backend: no route for {method} {path}"}

    def start(self) -> "MockBackend":
        self._thread = threading.Thread(target=self.server.serve_forever, name="mock-backend", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def paths(self, method: Optional[str] = None) -> list:
        return [r["path"] for r in self.requests if method is None or r["method"] == method]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4000)
    args = ap.parse_args()
    mb = MockBackend(args.port)
    print(f"mock backend on {mb.url} (sign in is pre-authorised as '{mb.user['login_name']}')")
    mb.server.serve_forever()


if __name__ == "__main__":
    main()
