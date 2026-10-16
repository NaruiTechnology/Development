"""Minimal systemd notification protocol (no external dependency).

``notify("READY=1")`` tells systemd a ``Type=notify`` service finished
starting; ``notify("WATCHDOG=1")`` resets the ``WatchdogSec=`` timer.  Both
are no-ops outside systemd (``NOTIFY_SOCKET`` unset), so the service runs
unchanged from a shell or in tests.
"""
from __future__ import annotations

import logging
import os
import socket

log = logging.getLogger("glasgow_service.sd_notify")


def notify(state: str) -> bool:
    """Send one notification; return whether it was delivered."""
    address = os.environ.get("NOTIFY_SOCKET")
    if not address:
        return False
    if address[0] == "@":  # abstract namespace socket
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM | socket.SOCK_CLOEXEC) as sock:
            sock.connect(address)
            sock.sendall(state.encode("utf-8"))
        return True
    except OSError as exc:
        log.warning("systemd notification %r failed: %s", state, exc)
        return False


def watchdog_interval() -> float | None:
    """Seconds between watchdog pings systemd expects, or None if disabled.

    systemd sets ``WATCHDOG_USEC`` (and ``WATCHDOG_PID`` for the process it
    applies to).  Pinging at half the interval leaves one missed ping of
    slack before systemd acts.
    """
    usec = os.environ.get("WATCHDOG_USEC")
    if not usec:
        return None
    pid = os.environ.get("WATCHDOG_PID")
    try:
        if pid and int(pid) != os.getpid():
            return None
        seconds = int(usec) / 1_000_000
    except ValueError:
        return None
    return seconds / 2 if seconds > 0 else None
