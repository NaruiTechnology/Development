"""Complete emulated test rig: Raspberry Pi + RPi5VacuumIO board + DB235.

Field wiring follows ``RPi5VacuumIO/WIRING.md`` exactly (relay contacts to
the pump controllers' remote inputs, dry contacts into the opto inputs,
gauge outputs into AI1..AI4, turbo speed into AI5..AI7, the three turbo
drives daisy-chained on RS-485 at addresses 1/2/3).

``tool_connected=False`` reproduces the commissioning set-up of WIRING.md
step 12: only J1 (24 V), J2 (E-stop) and J3 (Pi) are plugged in, and inputs
are exercised with jumper wires (:meth:`VacuumRig.jumper`).
"""
from __future__ import annotations

from .board import RPi5VacuumIOBoard
from .clock import RealtimeRunner, VirtualClock
from .db235 import DB235Plant, PneumaticValve
from .raspberry_pi import (
    EmulatedGpioHAL,
    EmulatedSerial,
    EmulatedSMBus,
    PiSpec,
    RaspberryPi,
)


class VacuumRig:
    def __init__(self, *, spec: PiSpec | None = None, realtime: bool = False,
                 speed: float = 1.0, boot: bool = True, tool_connected: bool = True,
                 plant: DB235Plant | None = None) -> None:
        # Coarser integration when time is compressed keeps CPU use sane.
        self.clock = VirtualClock(max_step=0.002 if speed <= 4 else 0.005)
        self.pi = RaspberryPi(self.clock, spec or PiSpec(boot_order=0xF14))
        self.board = RPi5VacuumIOBoard(self.clock, self.pi)
        self.plant = plant or DB235Plant()
        self.tool_connected = tool_connected
        self.jumpers: set[int] = set()
        self._wire()
        self.clock.subscribe(self.plant)
        self.clock.subscribe(self)
        self.runner = RealtimeRunner(self.clock, speed=speed) if realtime else None
        if boot:
            self.pi.boot_now()
            # Let the 24 V side settle (K9 operate time) as on a powered rack.
            self.clock.advance(0.1)
        if self.runner is not None:
            self.runner.start()

    # ------------------------------------------------------------- wiring
    def _wire(self) -> None:
        b, p = self.board, self.plant
        relay = lambda n: (lambda: self.tool_connected and b.relay_closed(n))  # noqa: E731
        sol = lambda n: (lambda: self.tool_connected and b.solenoid_on(n))      # noqa: E731

        # Relay contacts -> pump controller remote inputs (WIRING.md step 5)
        p.mechanical.enable = relay(1)
        p.turbo.remote_start = relay(2)
        p.uh_turbos[0].remote_start = relay(3)
        p.uh_turbos[1].remote_start = relay(4)

        # Solenoids (step 7)
        p.vent_valve_open = sol(3)
        p.gate_valve = PneumaticValve("V2 chamber gate", solenoid=sol(2),
                                      air_ok=lambda: p.utilities.compressed_air_ok)
        p.uh_isolation = [
            PneumaticValve("V4 UH isolation 1", solenoid=sol(4),
                           air_ok=lambda: p.utilities.compressed_air_ok),
            PneumaticValve("V5 UH isolation 2", solenoid=sol(5),
                           air_ok=lambda: p.utilities.compressed_air_ok),
        ]

        # Dry contacts into the opto inputs (steps 6 and 8)
        contacts = {
            1: lambda: p.mechanical.ready_contact(p.p_fore),
            2: p.turbo.at_speed_contact,
            3: p.uh_turbos[0].at_speed_contact,
            4: p.uh_turbos[1].at_speed_contact,
            5: p.mechanical.healthy_contact,
            6: p.turbo.healthy_contact,
            7: p.uh_turbos[0].healthy_contact,
            8: p.uh_turbos[1].healthy_contact,
            9: lambda: p.gate_valve.is_open,
            10: lambda: p.gate_valve.is_closed,
            11: lambda: p.uh_isolation[0].is_open,
            12: lambda: p.uh_isolation[0].is_closed,
            13: lambda: p.utilities.door_closed,
            14: lambda: p.utilities.compressed_air_ok,
            15: lambda: p.utilities.n2_ok,
            16: lambda: p.utilities.cooling_water_ok,
        }
        for n, contact in contacts.items():
            b.set_dry_contact(n, lambda n=n, contact=contact: (
                n in self.jumpers or (self.tool_connected and contact())))

        # Analog inputs (step 9)
        analog = {
            1: p.gauges["fore"].output_volts,
            2: p.gauges["chamber"].output_volts,
            3: p.gauges["uh1"].output_volts,
            4: p.gauges["uh2"].output_volts,
            5: p.turbo.speed_volts,
            6: p.uh_turbos[0].speed_volts,
            7: p.uh_turbos[1].speed_volts,
        }
        for n, source in analog.items():
            b.set_ai(n, lambda source=source: source() if self.tool_connected else 0.0)

        # RS-485 daisy chain (step 10)
        b.rs485_nodes = [self._rs485_guard(t) for t in p.all_turbos]

    def _rs485_guard(self, node):
        rig = self

        class _Guard:
            def rs485_receive(self, data: bytes, now: float):
                return node.rs485_receive(data, now) if rig.tool_connected else None
        return _Guard()

    def tick(self, now: float, dt: float) -> None:
        self.plant.hv_permitted = self.tool_connected and self.board.relay_closed(5)

    # ------------------------------------------------------------- operator actions
    def jumper(self, di: int, on: bool = True) -> None:
        """Commissioning jumper from J3x pin 6 (+24) to DIn."""
        with self.clock.lock:
            (self.jumpers.add if on else self.jumpers.discard)(di)

    def gauge_key_of(self, pump: str) -> str:
        """Gauge (volume) that belongs to a pump, following the AI wiring."""
        p = self.plant
        if pump == p.mechanical.name:
            return "fore"
        if pump == p.turbo.name:
            return "chamber"
        for i, turbo in enumerate(p.uh_turbos):
            if pump == turbo.name:
                return f"uh{i + 1}"
        raise KeyError(pump)

    def set_excursion(self, pump: str, mbar: float | None = None, *,
                      release: bool = False, recovery_s: float | None = None) -> None:
        """Raise (hold) or release a pressure excursion on ``pump``'s gauge."""
        with self.clock.lock:
            self.plant.set_excursion(self.gauge_key_of(pump), mbar,
                                     release=release, recovery_s=recovery_s)

    def set_estop(self, pressed: bool) -> None:
        with self.clock.lock:
            self.board.estop_loop_closed = not pressed

    def set_supply(self, on: bool) -> None:
        with self.clock.lock:
            self.board.supply_volts = 24.0 if on else 0.0

    def connect_tool(self, connected: bool = True) -> None:
        with self.clock.lock:
            self.tool_connected = connected

    # ------------------------------------------------------------- time
    def advance(self, seconds: float) -> None:
        if self.runner is not None:
            raise RuntimeError("advance() is for deterministic rigs; this one runs in real time")
        self.clock.advance(seconds)

    def sleep(self, seconds: float) -> None:
        """Injected into the driver as its ``sleep``."""
        if self.runner is not None:
            self.runner.sleep(seconds)
        else:
            self.clock.sleep(seconds)

    def monotonic(self) -> float:
        return self.clock.now()

    def close(self) -> None:
        if self.runner is not None:
            self.runner.stop()

    # ------------------------------------------------------------- Linux facades
    def smbus(self, bus: int = 1) -> EmulatedSMBus:
        return EmulatedSMBus(self.pi, bus)

    def gpio_hal(self) -> EmulatedGpioHAL:
        return EmulatedGpioHAL(self.pi)

    def serial(self, device: str, baudrate: int = 9600, timeout: float = 0.2) -> EmulatedSerial:
        return EmulatedSerial(self.pi, device, baudrate, timeout, wait=self.sleep)

    # ------------------------------------------------------------- reporting
    def snapshot(self) -> dict:
        with self.clock.lock:
            return {
                "time_s": round(self.clock.now(), 3),
                "pi": {"model": self.pi.profile.name, "ram_gb": self.pi.spec.ram_gb,
                       "state": self.pi.state.value, "boot_device": self.pi.boot_device},
                "tool_connected": self.tool_connected,
                "jumpers": sorted(self.jumpers),
                "board": self.board.snapshot(),
                "plant": self.plant.snapshot(),
            }
