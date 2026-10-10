"""Cross-process ownership lock for the Glasgow USB device.

The web stack (glasgow_service) and the native desktop app
(ionbeam-native) can both drive the same Glasgow. libusb only lets one
process claim the interface, and a second claim fails with an opaque
LIBUSB_ERROR_BUSY deep inside the launcher. This advisory lock turns that
into an immediate, explicit "device held by <owner>" error for whichever
side arrives second.

POSIX uses ``fcntl.flock`` (released automatically if the holder dies);
Windows uses ``msvcrt.locking`` on the same file. The lock file lives at
``$IONBEAM_DEVICE_LOCK`` or ``<tempdir>/ionbeam-glasgow-device.lock`` and
records the holder's pid and name for the error message.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

try:  # POSIX
    import fcntl  # type: ignore
except ImportError:  # pragma: no cover - Windows
    fcntl = None
try:  # Windows
    import msvcrt  # type: ignore
except ImportError:
    msvcrt = None


def default_lock_path() -> Path:
    override = os.environ.get("IONBEAM_DEVICE_LOCK", "").strip()
    if override:
        return Path(override)
    return Path(tempfile.gettempdir()) / "ionbeam-glasgow-device.lock"


class DeviceHeld(RuntimeError):
    """Another process owns the Glasgow device."""


class DeviceLock:
    """Non-blocking, re-entrant (per instance) exclusive device lock."""

    def __init__(self, owner: str, path: Optional[Path] = None):
        self.owner = owner
        self.path = Path(path) if path is not None else default_lock_path()
        self._fd: Optional[int] = None
        self._mutex = threading.Lock()

    @property
    def held(self) -> bool:
        return self._fd is not None

    def holder(self) -> str:
        try:
            info = json.loads(self.path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError):
            return "another process"
        name = info.get("owner") or "another process"
        pid = info.get("pid")
        return f"{name} (pid {pid})" if pid else name

    def acquire(self) -> None:
        """Take the lock or raise DeviceHeld. No-op if this instance already holds it."""
        with self._mutex:
            if self._fd is not None:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o666)
            try:
                os.chmod(self.path, 0o666)
            except OSError:
                pass
            try:
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except OSError:
                os.close(fd)
                raise DeviceHeld(f"Glasgow device is held by {self.holder()}") from None
            os.ftruncate(fd, 0)
            os.write(fd, json.dumps({"owner": self.owner, "pid": os.getpid()}).encode("utf-8"))
            self._fd = fd

    def release(self) -> None:
        with self._mutex:
            fd, self._fd = self._fd, None
            if fd is None:
                return
            try:
                os.ftruncate(fd, 0)
                if fcntl is not None:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            finally:
                os.close(fd)

    def __enter__(self) -> "DeviceLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()
