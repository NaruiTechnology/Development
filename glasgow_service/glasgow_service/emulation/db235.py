"""Behavioural model of the FEI DB235 vacuum system, as wired to the board.

This is a plant for exercising controller logic, not a vacuum-physics
reference.  Orders of magnitude follow the DB235 documentation used for the
shopping list (mechanical backing pump, turbo on the specimen chamber, UH
pumps on the column stages; "Vac OK" below ~1e-4 mbar).

Volumes and gas flows (mbar, litres, L/s)::

    atmosphere --vent V3--> CHAMBER --(turbo / open rotor)--> FORE-LINE --> mechanical pump
                              |  ^
                aperture C_ap |  | aperture
                              v  |
                            UH1   UH2 --(UH turbo / open rotor)--> FORE-LINE

Each pump controller exposes what the real one does: a remote start input
(fed by a board relay contact), dry "ready" / "no error" contacts, a 0-10 V
speed output and, for turbos, the Pfeiffer RS-485 protocol.  Gauges output
the Pirani (TPR 280) and full-range (PKR 251) voltage laws.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

from .. import pfeiffer

ATM = 1013.0
#: Gauge keys, in AI order: AI1 fore-line, AI2 chamber, AI3/AI4 UH stages.
GAUGE_KEYS = ("fore", "chamber", "uh1", "uh2")


# ------------------------------------------------------------------ gauges

@dataclass
class Gauge:
    """Gauge head with an analog output.

    ``law`` is ``"pirani"`` (U = log10 p + 5.5, 5e-4 .. 1000 mbar, 2.2-8.5 V)
    or ``"fullrange"`` (PKR 251: U = (log10 p + 11.33) / 1.667, 5e-9 .. 1000).
    """
    name: str
    law: str
    pressure: Callable[[], float]
    powered: bool = True
    failed: bool = False

    RANGES = {"pirani": (5e-4, 1000.0), "fullrange": (5e-9, 1000.0)}

    def output_volts(self) -> float:
        if not self.powered:
            return 0.0
        if self.failed:
            return 0.3          # below 0.5 V: sensor error
        lo, hi = self.RANGES[self.law]
        p = min(hi, max(lo, self.pressure()))
        if self.law == "pirani":
            return math.log10(p) + 5.5
        return (math.log10(p) + 11.33) / 1.667


# ------------------------------------------------------------------ pumps

@dataclass
class MechanicalPump:
    """Rotary-vane backing pump behind a contactor / remote-enable input."""
    name: str = "MechanicalVacuumPump"
    speed_lps: float = 3.0          # ~11 m3/h
    ultimate_mbar: float = 2e-3
    ready_setpoint_mbar: float = 1e-1
    enable: Callable[[], bool] = lambda: False
    thermal_trip: bool = False
    running: bool = False

    def step(self, p_fore: float) -> None:
        self.running = self.enable() and not self.thermal_trip

    def throughput(self, p_fore: float) -> float:
        if not self.running:
            return 0.0
        return self.speed_lps * max(0.0, p_fore - self.ultimate_mbar)

    def ready_contact(self, p_fore: float) -> bool:
        return self.running and p_fore <= self.ready_setpoint_mbar

    def healthy_contact(self) -> bool:
        return not self.thermal_trip


@dataclass
class TurboController:
    """Turbomolecular pump with a Pfeiffer-style drive unit."""
    name: str
    address: int
    nominal_hz: float = 1000.0
    speed_lps: float = 250.0
    accel_seconds: float = 120.0        # 0 -> nominal
    coast_seconds: float = 600.0        # nominal -> 0 without braking
    at_speed_fraction: float = 0.8      # speed switch point
    max_fore_mbar: float = 5.0          # no run-up above this
    trip_fore_mbar: float = 10.0        # fore-vacuum failure while running
    open_conductance_lps: float = 5.0   # gas path through a stopped rotor
    remote_start: Callable[[], bool] = lambda: False
    hz: float = 0.0
    error: str = ""
    serial_on: bool = True              # parameter 010 via RS-485
    runup_elapsed: float = 0.0

    @property
    def fraction(self) -> float:
        return self.hz / self.nominal_hz

    @property
    def commanded(self) -> bool:
        return self.remote_start() and self.serial_on and not self.error

    def step(self, dt: float, p_fore: float) -> None:
        if self.commanded:
            if self.hz > 0.2 * self.nominal_hz and p_fore > self.trip_fore_mbar:
                self.error = "Err006"       # fore-vacuum / overload
            elif p_fore <= self.max_fore_mbar:
                self.hz = min(self.nominal_hz,
                              self.hz + self.nominal_hz * dt / self.accel_seconds)
            if self.hz < self.at_speed_fraction * self.nominal_hz:
                self.runup_elapsed += dt
                if self.runup_elapsed > 4 * self.accel_seconds:
                    self.error = "Err002"   # run-up time exceeded
            else:
                self.runup_elapsed = 0.0
        else:
            self.runup_elapsed = 0.0
            self.hz = max(0.0, self.hz - self.nominal_hz * dt / self.coast_seconds)

    def at_speed_contact(self) -> bool:
        return not self.error and self.hz >= self.at_speed_fraction * self.nominal_hz

    def healthy_contact(self) -> bool:
        return not self.error

    def speed_volts(self) -> float:
        return 10.0 * self.fraction

    def flow(self, p_high: float, p_fore: float) -> float:
        """Gas throughput (mbar L/s) from the high-vacuum side to the fore-line."""
        f = self.fraction
        # Molecular-flow pumping falls off above ~1e-2 mbar.
        s = self.speed_lps * f / (1.0 + p_high / 1e-2)
        compression = 1.0 + 1e7 * f * f
        return s * (p_high - p_fore / compression) + \
            self.open_conductance_lps * (1 - f) * (p_high - p_fore)

    def reset_error(self) -> None:
        self.error = ""

    # RS-485 -----------------------------------------------------------
    def rs485_receive(self, data: bytes, now: float) -> bytes | None:
        try:
            telegram = pfeiffer.decode(data)
        except pfeiffer.PfeifferProtocolError:
            return None
        if telegram.address != self.address:
            return None
        p = telegram.parameter
        if telegram.is_query:
            if p == pfeiffer.P_ACTUAL_SPD:
                value = pfeiffer.u_integer(round(self.hz))
            elif p == pfeiffer.P_SET_ROT_SPD:
                value = pfeiffer.u_integer(round(self.nominal_hz))
            elif p == pfeiffer.P_ERROR_CODE:
                value = self.error or "no Err"
            elif p == pfeiffer.P_PUMPG_STATN:
                value = pfeiffer.boolean_old(self.serial_on)
            elif p == pfeiffer.P_MOTOR_PUMP:
                value = pfeiffer.boolean_old(self.commanded)
            elif p == pfeiffer.P_DRV_CURRENT:
                value = pfeiffer.u_real(0.4 + (1.6 if 0 < self.fraction < 1 and self.commanded else 0))
            elif p == pfeiffer.P_ELEC_NAME:
                value = "TC 400"
            else:
                value = "NO_DEF"
            return pfeiffer.encode(self.address, 10, p, value)
        if telegram.action == 10 and p == pfeiffer.P_PUMPG_STATN:
            self.serial_on = telegram.data == "111111"
            return pfeiffer.encode(self.address, 10, p, telegram.data)
        return pfeiffer.encode(self.address, 10, p, "NO_DEF")


# ------------------------------------------------------------------ valves

@dataclass
class PneumaticValve:
    """Spring-return (normally closed) valve with open/closed reed switches."""
    name: str
    solenoid: Callable[[], bool] = lambda: False
    air_ok: Callable[[], bool] = lambda: True
    travel_seconds: float = 0.8
    position: float = 0.0           # 0 closed .. 1 open

    def step(self, dt: float) -> None:
        target = 1.0 if (self.solenoid() and self.air_ok()) else 0.0
        rate = dt / self.travel_seconds
        if self.position < target:
            self.position = min(target, self.position + rate)
        elif self.position > target:
            self.position = max(target, self.position - rate)

    @property
    def is_open(self) -> bool:
        return self.position >= 0.999

    @property
    def is_closed(self) -> bool:
        return self.position <= 0.001


# ------------------------------------------------------------------ plant

@dataclass
class Utilities:
    door_closed: bool = True
    compressed_air_ok: bool = True
    n2_ok: bool = True
    cooling_water_ok: bool = True


@dataclass
class DB235Plant:
    """The vacuum system.  ``step`` integrates with exact exponential updates
    per volume (operator splitting), so it is stable for any ``dt``."""

    v_fore: float = 2.0
    v_chamber: float = 30.0
    v_uh: float = 2.0
    aperture_lps: float = 0.5
    chamber_gas_load: float = 2e-5      # mbar L/s outgassing + leaks
    uh_gas_load: float = 1e-7
    fore_gas_load: float = 1e-4
    vent_conductance_lps: float = 1.0
    #: When False (default) the gate/isolation valves only move and report
    #: position; gas paths stay open.  The controller does not sequence
    #: valves yet, so this keeps the cascade pumpable with all valves off.
    gate_valves_affect_flow: bool = False
    step_seconds: float = 0.02
    #: Test-only pressure excursion added to one gauge's reading (mbar), by
    #: gauge key.  While "held" it stays put; once released it decays with
    #: ``excursion_recovery_s`` but only while that gauge's pump is running,
    #: modelling the pump working the excursion back down.  It is local to
    #: the gauge, so it does not load the fore-line (see vacuum-emulator.md).
    excursion: dict[str, float] = field(default_factory=lambda: dict.fromkeys(GAUGE_KEYS, 0.0))
    excursion_held: dict[str, bool] = field(default_factory=lambda: dict.fromkeys(GAUGE_KEYS, False))
    excursion_recovery_s: dict[str, float] = field(
        default_factory=lambda: dict.fromkeys(GAUGE_KEYS, 120.0))

    p_fore: float = ATM
    p_chamber: float = ATM
    p_uh: list[float] = field(default_factory=lambda: [ATM, ATM])
    utilities: Utilities = field(default_factory=Utilities)
    hv_permitted: bool = False

    mechanical: MechanicalPump = field(default_factory=MechanicalPump)
    turbo: TurboController = field(default_factory=lambda: TurboController(
        "TurboVacuumPump", address=1, speed_lps=250.0))
    uh_turbos: list[TurboController] = field(default_factory=lambda: [
        TurboController("UHVacuumPump_1", address=2, speed_lps=60.0, nominal_hz=1500.0,
                        accel_seconds=90.0),
        TurboController("UHVacuumPump_2", address=3, speed_lps=60.0, nominal_hz=1500.0,
                        accel_seconds=90.0),
    ])
    vent_valve_open: Callable[[], bool] = lambda: False
    gate_valve: PneumaticValve | None = None        # V2
    uh_isolation: list[PneumaticValve] = field(default_factory=list)  # V4, V5
    _acc: float = 0.0

    def __post_init__(self) -> None:
        x = self.excursion
        self.gauges = {
            "fore": Gauge("fore-line Pirani", "pirani", lambda: self.p_fore + x["fore"]),
            "chamber": Gauge("chamber PKR 251", "fullrange",
                             lambda: self.p_chamber + x["chamber"]),
            "uh1": Gauge("UH stage 1 PKR 251", "fullrange", lambda: self.p_uh[0] + x["uh1"]),
            "uh2": Gauge("UH stage 2 PKR 251", "fullrange", lambda: self.p_uh[1] + x["uh2"]),
        }

    def gauge_pump_running(self, key: str) -> bool:
        """Is the pump that works the volume behind gauge ``key`` running?"""
        if key == "fore":
            return self.mechanical.running
        pump = self.turbo if key == "chamber" else self.uh_turbos[GAUGE_KEYS.index(key) - 2]
        return pump.commanded and not pump.error and self.mechanical.running

    def set_excursion(self, key: str, mbar: float | None = None, *,
                      release: bool = False, recovery_s: float | None = None) -> None:
        if key not in self.excursion:
            raise KeyError(key)
        if mbar is not None:
            self.excursion[key] = max(0.0, float(mbar))
        if recovery_s is not None:
            self.excursion_recovery_s[key] = max(0.1, float(recovery_s))
        self.excursion_held[key] = not release

    def _step_excursions(self, dt: float) -> None:
        for key, value in self.excursion.items():
            if value <= 0.0 or self.excursion_held[key] or not self.gauge_pump_running(key):
                continue
            decayed = value * math.exp(-dt / self.excursion_recovery_s[key])
            self.excursion[key] = 0.0 if decayed < 1e-12 else decayed

    @property
    def all_turbos(self) -> list[TurboController]:
        return [self.turbo, *self.uh_turbos]

    def tick(self, now: float, dt: float) -> None:
        self._acc += dt
        while self._acc >= self.step_seconds:
            self._acc -= self.step_seconds
            self.step(self.step_seconds)

    def step(self, dt: float) -> None:
        u = self.utilities
        self._step_excursions(dt)
        self.mechanical.step(self.p_fore)
        for pump in self.all_turbos:
            pump.step(dt, self.p_fore)
        for valve in [v for v in [self.gate_valve, *self.uh_isolation] if v is not None]:
            valve.step(dt)

        if not u.door_closed:
            self.p_chamber = ATM

        gate = 1.0
        if self.gate_valves_affect_flow and self.gate_valve is not None:
            gate = self.gate_valve.position
        iso = [1.0, 1.0]
        if self.gate_valves_affect_flow:
            for i, valve in enumerate(self.uh_isolation[:2]):
                iso[i] = valve.position

        # Linearised flows into each volume: dp/dt = (A - B p) / V
        # Fore-line
        q_from_chamber = self.turbo.flow(self.p_chamber, self.p_fore) * gate
        q_from_uh = sum(t.flow(p, self.p_fore) * iso[i]
                        for i, (t, p) in enumerate(zip(self.uh_turbos, self.p_uh)))
        a_fore = self.fore_gas_load + max(0.0, q_from_chamber) + max(0.0, q_from_uh)
        b_fore = self.mechanical.speed_lps if self.mechanical.running else 0.0
        a_fore += b_fore * self.mechanical.ultimate_mbar
        self.p_fore = self._relax(self.p_fore, a_fore, b_fore, self.v_fore, dt)

        # Chamber
        vent = self.vent_valve_open() and u.n2_ok
        a_ch = self.chamber_gas_load + sum(
            self.aperture_lps * p for p in self.p_uh)
        b_ch = 2 * self.aperture_lps
        if vent:
            a_ch += self.vent_conductance_lps * ATM
            b_ch += self.vent_conductance_lps
        # Turbo removes gas proportionally to p_chamber (and back-streams).
        k_turbo = max(0.0, q_from_chamber) / max(self.p_chamber, 1e-12)
        b_ch += k_turbo
        self.p_chamber = min(ATM, self._relax(self.p_chamber, a_ch, b_ch, self.v_chamber, dt))

        # UH stages
        for i, turbo in enumerate(self.uh_turbos):
            p = self.p_uh[i]
            q = max(0.0, turbo.flow(p, self.p_fore) * iso[i])
            a = self.uh_gas_load + self.aperture_lps * self.p_chamber
            b = self.aperture_lps + q / max(p, 1e-12)
            self.p_uh[i] = min(ATM, self._relax(p, a, b, self.v_uh, dt))

    @staticmethod
    def _relax(p: float, a: float, b: float, volume: float, dt: float) -> float:
        if b <= 1e-15:
            return max(1e-11, p + a * dt / volume)
        p_eq = a / b
        return max(1e-11, p_eq + (p - p_eq) * math.exp(-b * dt / volume))

    def vent_to_atmosphere(self) -> None:
        self.p_fore = self.p_chamber = ATM
        self.p_uh = [ATM, ATM]
        for pump in self.all_turbos:
            pump.hz = 0.0

    def snapshot(self) -> dict:
        return {
            "pressure_mbar": {
                "fore": self.p_fore, "chamber": self.p_chamber,
                "uh1": self.p_uh[0], "uh2": self.p_uh[1],
            },
            "excursion_mbar": {k: v for k, v in self.excursion.items() if v > 0.0},
            "mechanical": {"running": self.mechanical.running,
                           "thermal_trip": self.mechanical.thermal_trip},
            "turbos": {t.name: {"hz": round(t.hz, 1), "at_speed": t.at_speed_contact(),
                                "error": t.error or None, "remote_start": t.remote_start()}
                       for t in self.all_turbos},
            "hv_permitted": self.hv_permitted,
            "utilities": self.utilities.__dict__.copy(),
        }
