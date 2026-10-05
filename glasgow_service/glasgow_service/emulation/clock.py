"""Virtual time base shared by every emulated component.

All emulated hardware (Pi peripherals, board relays and RC networks, the
DB235 plant) advances only through :meth:`VirtualClock.advance`.  Tests use
the clock deterministically; :class:`RealtimeRunner` drives it from wall time
for interactive use and for the emulator mode of ``sbc_vacuum_app``.
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Protocol


class Tickable(Protocol):
    def tick(self, now: float, dt: float) -> None: ...


class VirtualClock:
    """Monotonic emulated time in seconds, with ordered tick subscribers."""

    #: Largest integration step handed to subscribers.  Relay timing (5-10 ms)
    #: and the watchdog RC (100 ms) are resolved well at 2 ms.
    MAX_STEP = 0.002

    def __init__(self, max_step: float | None = None) -> None:
        if max_step is not None:
            self.MAX_STEP = max_step
        self._now = 0.0
        self._subscribers: list[Tickable] = []
        # Re-entrant: HAL calls made from a thread hold the lock while the
        # board model may call back into the clock.
        self.lock = threading.RLock()

    def now(self) -> float:
        return self._now

    # ``monotonic`` alias so the clock can be injected wherever
    # ``time.monotonic`` is expected.
    monotonic = now

    def subscribe(self, component: Tickable) -> None:
        with self.lock:
            self._subscribers.append(component)

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("cannot advance a clock backwards")
        with self.lock:
            remaining = seconds
            while remaining > 1e-12:
                dt = min(self.MAX_STEP, remaining)
                self._now += dt
                for component in self._subscribers:
                    component.tick(self._now, dt)
                remaining -= dt

    def sleep(self, seconds: float) -> None:
        """Deterministic replacement for ``time.sleep``: advances emulated time."""
        self.advance(max(0.0, seconds))


class RealtimeRunner:
    """Advance a :class:`VirtualClock` from wall time in a background thread.

    ``speed`` > 1 compresses time (for example 20 makes a 2-minute turbo
    spin-up take 6 s); the electrical timing of the board scales with it.
    """

    def __init__(self, clock: VirtualClock, *, speed: float = 1.0,
                 period: float = 0.005,
                 wall_clock: Callable[[], float] = time.monotonic) -> None:
        if speed <= 0:
            raise ValueError("speed must be positive")
        self.clock = clock
        self.speed = speed
        self.period = period
        self._wall = wall_clock
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="rpi5-emulator-clock", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    @property
    def running(self) -> bool:
        return self._thread is not None

    def _run(self) -> None:
        last = self._wall()
        while not self._stop.wait(self.period):
            now = self._wall()
            # Bound a single catch-up so a stalled host does not freeze the
            # GIL for seconds integrating physics.
            elapsed = min(now - last, 0.25)
            last = now
            self.clock.advance(elapsed * self.speed)

    def sleep(self, seconds: float) -> None:
        """Wait until the background runner advances the requested time.

        A wall sleep alone can return before the runner is scheduled, leaving
        an ADC conversion busy even after the driver's wall deadline expires.
        """
        with self.clock.lock:
            target = self.clock.now() + max(0.0, seconds)
        while True:
            with self.clock.lock:
                remaining = target - self.clock.now()
            if remaining <= 0:
                return
            if self._stop.wait(min(self.period, remaining / self.speed)):
                raise RuntimeError("emulator clock stopped during sleep")
