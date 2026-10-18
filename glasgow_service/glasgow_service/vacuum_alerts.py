"""Webhook alerts for unattended (24/7) vacuum operation.

The controller reports state changes that need a person -- the cascade
stopping, alarms, the controller itself stopping -- to an HTTP webhook, and
repeats a reminder while the cascade stays stopped.  Delivery runs on a
background thread with a bounded queue: a slow or unreachable webhook never
blocks or breaks the control loop, and a failed delivery is only logged.

Configuration (environment):

``SBC_VACUUM_ALERT_WEBHOOK``         URL that receives a JSON POST per alert.
                                     Unset: alerts are disabled.
``SBC_VACUUM_ALERT_TOKEN``           Optional bearer token for the webhook.
``SBC_VACUUM_ALERT_REMIND_SECONDS``  Repeat interval while the cascade stays
                                     stopped (default 1800; 0 disables).

The payload carries a ready-to-post ``text`` line (accepted as-is by Slack,
Mattermost and most chat webhooks) plus structured fields for other tools.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import socket
import threading
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Optional

log = logging.getLogger("glasgow_service.vacuum.alerts")

WEBHOOK_ENV = "SBC_VACUUM_ALERT_WEBHOOK"
TOKEN_ENV = "SBC_VACUUM_ALERT_TOKEN"
REMIND_ENV = "SBC_VACUUM_ALERT_REMIND_SECONDS"
DEFAULT_REMIND_SECONDS = 1800.0

SEVERITIES = ("info", "warning", "critical")

Sender = Callable[[dict[str, Any]], None]


class VacuumAlerts:
    """Non-blocking alert sink.  ``emit`` never raises."""

    QUEUE_SIZE = 100

    def __init__(
        self,
        url: Optional[str] = None,
        *,
        token: Optional[str] = None,
        remind_seconds: float = DEFAULT_REMIND_SECONDS,
        timeout: float = 5.0,
        sender: Optional[Sender] = None,
        synchronous: bool = False,
    ) -> None:
        if remind_seconds < 0:
            raise ValueError(f"{REMIND_ENV} must be 0 (disabled) or positive")
        self.url = url
        self.token = token
        self.remind_seconds = float(remind_seconds)
        self.timeout = timeout
        self._custom_sender = sender is not None
        self._sender = sender or self._post
        self._synchronous = synchronous
        self._host = socket.gethostname()
        self._queue: queue.Queue[Optional[dict[str, Any]]] = queue.Queue(self.QUEUE_SIZE)
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(self.url) or self._custom_sender

    # ----------------------------------------------------------------- emit
    def emit(self, event: str, severity: str, message: str, **fields: Any) -> None:
        if not self.enabled:
            return
        try:
            payload = self._payload(event, severity, message, fields)
            if self._synchronous:
                self._deliver(payload)
                return
            self._ensure_thread()
            try:
                self._queue.put_nowait(payload)
            except queue.Full:
                log.error("vacuum alert queue full; dropped alert %s", event)
        except Exception:  # noqa: BLE001 - alerting must never affect control
            log.exception("vacuum alert %s could not be queued", event)

    def _payload(self, event: str, severity: str, message: str,
                 fields: dict[str, Any]) -> dict[str, Any]:
        if severity not in SEVERITIES:
            severity = "warning"
        device = fields.get("device_id") or "vacuum"
        return {
            "text": f"[sbc-vacuum {device} @ {self._host}] {severity.upper()}: {message}",
            "service": "sbc-vacuum",
            "host": self._host,
            "event": event,
            "severity": severity,
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **fields,
        }

    # -------------------------------------------------------------- delivery
    def _ensure_thread(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._run, name="vacuum-alerts", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            payload = self._queue.get()
            if payload is None:
                return
            self._deliver(payload)

    def _deliver(self, payload: dict[str, Any]) -> None:
        try:
            self._sender(payload)
        except Exception as exc:  # noqa: BLE001 - log and carry on
            log.error("vacuum alert %s delivery failed: %s", payload.get("event"), exc)

    def _post(self, payload: dict[str, Any]) -> None:
        request = urllib.request.Request(
            self.url, data=json.dumps(payload, default=str).encode("utf-8"),
            method="POST", headers={"Content-Type": "application/json"})
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            if response.status >= 300:
                raise RuntimeError(f"webhook answered HTTP {response.status}")

    def close(self, timeout: float = 2.0) -> None:
        """Flush queued alerts (bounded wait) and stop the delivery thread."""
        thread = self._thread
        if thread is None or not thread.is_alive():
            return
        try:
            self._queue.put(None, timeout=timeout)
        except queue.Full:
            return
        thread.join(timeout)


def alerts_from_environment() -> VacuumAlerts:
    url = os.environ.get(WEBHOOK_ENV, "").strip() or None
    raw = os.environ.get(REMIND_ENV, "").strip()
    try:
        remind = float(raw) if raw else DEFAULT_REMIND_SECONDS
    except ValueError as exc:
        raise ValueError(f"{REMIND_ENV} must be a number of seconds") from exc
    return VacuumAlerts(
        url, token=os.environ.get(TOKEN_ENV, "").strip() or None, remind_seconds=remind)
