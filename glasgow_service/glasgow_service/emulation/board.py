"""Electrical model of the RPi5VacuumIO rev A.1 board.

Every net, part and value comes from
``GlasgowDataIO/Hardware/VacuumController/RPi5VacuumIO/tools/design.py``
(the board's single source of truth).  The board plugs into the 40-pin
header of a Raspberry Pi 4 Model B or a Raspberry Pi 5 (identical pin use).

Modelled behaviour:

* J1 24 V input, F1, +24V_AUX (F2) for sensors and the E-stop loop;
* K9 (E-stop loop relay) -> +24V_ESTOP; K10 (watchdog relay) -> +24V_SAFE;
* the GPIO19 heartbeat charge pump (C4/D6/C5/R3): a DC level on the pin, high
  or low, does not pump, so the gate bleeds through R3 and K10 drops after
  about 100 ms;
* U1 MCP23017 @0x20 (GPA -> ULN2803A -> K1..K8, GPB -> AO3400A -> V1..V8),
  U3 MCP23017 @0x21 (DI1..DI16 through TLP291 optos, active low, INTA ->
  GPIO27), both held in reset by R10 until the Pi drives GPIO22 high;
* JP1..JP8 relay-coil rail selection (K1 on +24V_ESTOP, K2..K8 on +24V_SAFE);
* G5LE relay operate (10 ms) / release (5 ms) times;
* U9/U10 ADS1115 @0x48/0x49 behind the 68k/22k divider, 100 nF anti-alias
  filter and BAT54S clamp; ALERT/RDY wired-AND to GPIO23;
* rail status optos (ESTOP_OK_N GPIO5, SAFE_OK_N GPIO6, low = OK);
* RS-485 (MAX3485, DE/RE on GPIO18, half duplex) and RS-232 (MAX3232);
* the indicator LEDs.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Protocol

from .chips import ADS1115, MCP23017
from .clock import VirtualClock
from .raspberry_pi import Drive, RaspberryPi, Resistor

# ------------------------------------------------------------------ constants

DIVIDER_RATIO = 22.0 / (68.0 + 22.0)        # R14x / (R14x + R15x)
AI_FILTER_TAU = (68e3 * 22e3 / 90e3) * 100e-9  # Thevenin R x C2x ~= 1.66 ms
DI_ON_VOLTS = 6.0   # opto + indicator LED forward voltage + CTR margin
CHARGE_PUMP_VMAX = 3.3 - 2 * 0.3   # BAT54S drops
CHARGE_PUMP_SHARE = 0.5            # C4 = C5 = 1 uF
WDT_BLEED_TAU = 100e3 * 1e-6       # R3 x C5 = 100 ms
Q9_ON_VOLTS = 1.6                  # AO3400A gate: K10 coil current on
Q9_OFF_VOLTS = 1.1                 # below this the coil releases
RELAY_OPERATE_S = 0.010            # Omron G5LE max operate time
RELAY_RELEASE_S = 0.005            # Omron G5LE max release time
RELAY_PICKUP_VOLTS = 18.0          # 75 % of 24 V nominal

# Pi BCM lines used by the board (identical on Pi 4B and Pi 5).
BCM_IO_RESET_N = 22
BCM_DI_INT = 27
BCM_ADC_ALRT = 23
BCM_ESTOP_OK_N = 5
BCM_SAFE_OK_N = 6
BCM_RS485_DE = 18
BCM_HEARTBEAT = 19
BCM_RUN_LED = 26

ADDR_OUTPUTS = 0x20
ADDR_INPUTS = 0x21
ADDR_ADC_LOW = 0x48
ADDR_ADC_HIGH = 0x49


class Relay:
    """G5LE SPDT relay with operate/release delay."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.closed = False      # COM-NO closed
        self.operations = 0
        self._coil = False
        self._since = 0.0

    def update(self, now: float, coil_volts: float) -> None:
        coil = coil_volts >= RELAY_PICKUP_VOLTS if not self.closed else coil_volts >= 2.4
        if coil != self._coil:
            self._coil = coil
            self._since = now
        delay = RELAY_OPERATE_S if coil else RELAY_RELEASE_S
        if coil != self.closed and now - self._since >= delay - 1e-9:
            self.closed = coil
            self.operations += 1

    @property
    def coil_energised(self) -> bool:
        return self._coil


class RS485Node(Protocol):
    def rs485_receive(self, data: bytes, now: float) -> bytes | None: ...


@dataclass
class _PendingReply:
    due: float
    data: bytes


@dataclass
class BoardFaults:
    """Fault injection hooks for tests and the emulator UI."""
    fuse_f1_blown: bool = False
    stuck_heartbeat: bool = False        # GPIO19 net shorted (no pumping)
    k10_welded: bool = False             # watchdog relay contact welded shut
    rs485_disconnected: bool = False


@dataclass
class Leds:
    d3_24v: bool = False
    d9_estop_rail: bool = False
    d10_output_rail: bool = False
    d11_run: bool = False
    relays: list[bool] = field(default_factory=lambda: [False] * 8)
    solenoids: list[bool] = field(default_factory=lambda: [False] * 8)
    inputs: list[bool] = field(default_factory=lambda: [False] * 16)


class RPi5VacuumIOBoard:
    """The populated PCB, attached to an emulated Raspberry Pi header."""

    def __init__(self, clock: VirtualClock, pi: RaspberryPi) -> None:
        self.clock = clock
        self.pi = pi
        self.faults = BoardFaults()

        # Field side ------------------------------------------------------
        self.supply_volts = 24.0              # J1
        self.estop_loop_closed = True         # J2 (NC loop / safety relay)
        #: JPn: "estop" or "safe" - the coil rail of relay Kn.
        self.coil_rail = ["estop"] + ["safe"] * 7
        self.rs485_termination = False        # JP9
        #: DI1..DI16 terminal sources: volts between DIn and its group COM.
        self.di_sources: list[Callable[[], float]] = [lambda: 0.0] * 16
        #: AI1..AI8 terminal sources: volts between AIn and 0V.
        self.ai_sources: list[Callable[[], float]] = [lambda: 0.0] * 8
        self.rs485_nodes: list[RS485Node] = []
        self.rs232_device: Callable[[bytes], bytes | None] | None = None

        # Internal state ---------------------------------------------------
        self.k9 = Relay("K9")
        self.k10 = Relay("K10")
        self.relays = [Relay(f"K{n}") for n in range(1, 9)]
        self.wdt_gate_volts = 0.0
        self._q9_on = False
        self._ai_nodes = [0.0] * 8
        self._rs485_pending: list[_PendingReply] = []
        self.rs485_dropped_bytes = 0
        self.rs485_tx_log: list[bytes] = []
        self.leds = Leds()

        # Chips ------------------------------------------------------------
        reset_n = lambda: self.pi.pin_level(BCM_IO_RESET_N)  # noqa: E731
        powered = lambda: self.pi.rail_3v3                   # noqa: E731
        self.u1 = MCP23017("U1", pin_inputs=lambda: 0, powered=powered, reset_n=reset_n)
        self.u3 = MCP23017("U3", pin_inputs=self._u3_pins, powered=powered, reset_n=reset_n)
        vdd = lambda: 3.3 if self.pi.rail_3v3 else 0.0       # noqa: E731
        self.u9 = ADS1115("U9", analog_inputs=lambda: self._ai_nodes[0:4], vdd=vdd,
                          now=clock.now)
        self.u10 = ADS1115("U10", analog_inputs=lambda: self._ai_nodes[4:8], vdd=vdd,
                           now=clock.now)
        pi.i2c1.attach(ADDR_OUTPUTS, self.u1)
        pi.i2c1.attach(ADDR_INPUTS, self.u3)
        pi.i2c1.attach(ADDR_ADC_LOW, self.u9)
        pi.i2c1.attach(ADDR_ADC_HIGH, self.u10)

        # Nets onto the Pi header ---------------------------------------------
        pi.connect(BCM_IO_RESET_N, lambda: Resistor(False, 10e3))       # R10
        pi.connect(BCM_RS485_DE, lambda: Resistor(False, 10e3))         # R14
        pi.connect(BCM_DI_INT, self._di_int_net)                        # R12 + INTA
        pi.connect(BCM_ADC_ALRT, self._adc_alert_net)                   # R13 + ALERT
        pi.connect(BCM_ESTOP_OK_N, lambda: self._status_net(self.estop_rail_live))
        pi.connect(BCM_SAFE_OK_N, lambda: self._status_net(self.safe_rail_live))
        pi.uart0.on_tx = self._rs485_from_pi
        pi.uart_gpio12.on_tx = self._rs232_from_pi

        clock.subscribe(self)

    # ------------------------------------------------------------- rails
    @property
    def v24(self) -> float:
        if self.faults.fuse_f1_blown:
            return 0.0
        return max(0.0, self.supply_volts - 0.45)   # D1 Schottky drop

    @property
    def v_aux(self) -> float:
        """+24V_AUX: sensor supply on J31-J34 pin 6 and the E-stop loop."""
        return self.v24

    @property
    def estop_rail_live(self) -> bool:
        return self.k9.closed and self.v24 >= RELAY_PICKUP_VOLTS

    @property
    def safe_rail_live(self) -> bool:
        return self.estop_rail_live and (self.k10.closed or self.faults.k10_welded)

    def _rail_volts(self, rail: str) -> float:
        live = self.estop_rail_live if rail == "estop" else self.safe_rail_live
        return self.v24 if live else 0.0

    # ------------------------------------------------------------- nets
    def _status_net(self, rail_live: bool):
        if not self.pi.rail_3v3:
            return None
        items = [Resistor(True, 10e3)]          # R8 / R9
        if rail_live:
            items.append(Drive(False))          # opto transistor on
        return items

    def _di_int_net(self):
        items = [Resistor(True, 10e3)] if self.pi.rail_3v3 else []
        level = self.u3.int_pin(0)
        if level is not None:
            items.append(Drive(level))
        return items

    def _adc_alert_net(self):
        items = [Resistor(True, 10e3)] if self.pi.rail_3v3 else []
        for adc in (self.u9, self.u10):
            level = adc.alert_pin()
            if level is False:
                items.append(Drive(False))
        return items

    def _u3_pins(self) -> int:
        """DI_N1..16 at the U3 pins: opto on pulls low, else R12x pull-up."""
        if not self.pi.rail_3v3:
            return 0
        word = 0
        for n in range(16):
            if not self.di_active(n + 1):
                word |= 1 << n
        return word

    # ------------------------------------------------------------- field I/O
    def di_volts(self, n: int) -> float:
        try:
            return float(self.di_sources[n - 1]())
        except Exception:
            return 0.0

    def di_active(self, n: int) -> bool:
        return self.di_volts(n) >= DI_ON_VOLTS

    def relay_closed(self, n: int) -> bool:
        """Kn COM-NO contact closed (Jn+10 pins 1-2)."""
        return self.relays[n - 1].closed

    def relay_input(self, n: int) -> bool:
        return bool(self.u1.output_word() & (1 << (n - 1)))

    def solenoid_input(self, n: int) -> bool:
        return bool(self.u1.output_word() & (1 << (8 + n - 1)))

    def solenoid_on(self, n: int) -> bool:
        """Vn low-side switch conducting with +24V_SAFE present."""
        return self.safe_rail_live and self.solenoid_input(n)

    def set_dry_contact(self, n: int, closed: Callable[[], bool] | bool) -> None:
        """Wire a potential-free contact between +24 (pin 6) and DIn."""
        fn = closed if callable(closed) else (lambda value=closed: value)
        self.di_sources[n - 1] = lambda: self.v_aux if fn() else 0.0

    def set_ai(self, n: int, volts: Callable[[], float] | float) -> None:
        fn = volts if callable(volts) else (lambda value=volts: value)
        self.ai_sources[n - 1] = fn

    # ------------------------------------------------------------- serial
    def _rs485_from_pi(self, data: bytes) -> None:
        if not self.pi.pin_level(BCM_RS485_DE):
            self.rs485_dropped_bytes += len(data)   # driver disabled: nothing on A/B
            return
        self.rs485_tx_log.append(bytes(data))
        if self.faults.rs485_disconnected:
            return
        now = self.clock.now()
        for node in self.rs485_nodes:
            reply = node.rs485_receive(bytes(data), now)
            if reply:
                # Controller turnaround + transmission time at 9600 8N1.
                due = now + 0.002 + len(reply) * 10 / 9600
                self._rs485_pending.append(_PendingReply(due, reply))

    def _rs232_from_pi(self, data: bytes) -> None:
        if self.rs232_device is not None:
            reply = self.rs232_device(bytes(data))
            if reply:
                self.pi.uart_gpio12.deliver(reply)

    # ------------------------------------------------------------- dynamics
    def _charge_pump(self, dt: float) -> None:
        pumping_cycles = 0.0
        if self.pi.rail_3v3 and not self.faults.stuck_heartbeat:
            freq, duty = self.pi.pwm_of(BCM_HEARTBEAT)
            if freq > 0 and 2.0 <= duty <= 98.0:
                pumping_cycles = freq * dt
            else:
                pumping_cycles = self.pi.take_edges(BCM_HEARTBEAT) / 2.0
        else:
            self.pi.take_edges(BCM_HEARTBEAT)
        v = self.wdt_gate_volts
        if pumping_cycles > 0:
            v = CHARGE_PUMP_VMAX - (CHARGE_PUMP_VMAX - v) * (1 - CHARGE_PUMP_SHARE) ** pumping_cycles
        v *= math.exp(-dt / WDT_BLEED_TAU)
        self.wdt_gate_volts = v
        if self._q9_on and v < Q9_OFF_VOLTS:
            self._q9_on = False
        elif not self._q9_on and v > Q9_ON_VOLTS:
            self._q9_on = True

    def tick(self, now: float, dt: float) -> None:
        # E-stop relay: coil fed from +24V_AUX through the loop.
        self.k9.update(now, self.v_aux if self.estop_loop_closed else 0.0)
        self._charge_pump(dt)
        k10_coil = self._rail_volts("estop") if self._q9_on else 0.0
        self.k10.update(now, k10_coil)
        # Expanders and ADCs follow reset / supply.
        self.u1.tick(now, dt)
        self.u3.tick(now, dt)
        self.u9.tick(now, dt)
        self.u10.tick(now, dt)
        # Relay coils: rail via JPn, switched by ULN2803A channel n.
        for n, relay in enumerate(self.relays, start=1):
            volts = self._rail_volts(self.coil_rail[n - 1]) if self.relay_input(n) else 0.0
            relay.update(now, volts)
        # Analog front end: divider, RC filter, BAT54S clamp.
        alpha = 1 - math.exp(-dt / AI_FILTER_TAU)
        clamp_hi = (3.3 if self.pi.rail_3v3 else 0.0) + 0.3
        for i in range(8):
            try:
                v_in = float(self.ai_sources[i]())
            except Exception:
                v_in = 0.0
            target = min(clamp_hi, max(-0.3, v_in * DIVIDER_RATIO))
            self._ai_nodes[i] += (target - self._ai_nodes[i]) * alpha
        # RS-485 replies reach the Pi only while the receiver is enabled.
        if self._rs485_pending:
            due = [p for p in self._rs485_pending if p.due <= now]
            self._rs485_pending = [p for p in self._rs485_pending if p.due > now]
            for reply in due:
                if self.pi.pin_level(BCM_RS485_DE):
                    self.rs485_dropped_bytes += len(reply.data)
                else:
                    self.pi.uart0.deliver(reply.data)
        self._update_leds()

    def _update_leds(self) -> None:
        leds = self.leds
        leds.d3_24v = self.v24 > 5
        leds.d9_estop_rail = self.estop_rail_live
        leds.d10_output_rail = self.safe_rail_live
        leds.d11_run = self.pi.rail_3v3 and self.pi.pin_level(BCM_RUN_LED) and \
            self.pi.is_driven_output(BCM_RUN_LED)
        leds.relays = [r.coil_energised for r in self.relays]
        leds.solenoids = [self.solenoid_on(n) for n in range(1, 9)]
        leds.inputs = [self.di_active(n) for n in range(1, 17)]

    # ------------------------------------------------------------- reporting
    def snapshot(self) -> dict:
        self._update_leds()
        return {
            "supply_volts": self.supply_volts,
            "estop_loop_closed": self.estop_loop_closed,
            "rails": {"+24V": round(self.v24, 2),
                      "+24V_ESTOP": self.estop_rail_live,
                      "+24V_SAFE": self.safe_rail_live},
            "watchdog_gate_volts": round(self.wdt_gate_volts, 3),
            "expanders_in_reset": not self.pi.pin_level(BCM_IO_RESET_N),
            "relays": {f"K{n}": r.closed for n, r in enumerate(self.relays, start=1)},
            "solenoids": {f"V{n}": self.solenoid_on(n) for n in range(1, 9)},
            "inputs": {f"DI{n}": self.di_active(n) for n in range(1, 17)},
            "analog_volts": {f"AI{n}": round(self.ai_volts(n), 3) for n in range(1, 9)},
            "leds": {
                "D3_24V": self.leds.d3_24v, "D9_ESTOP": self.leds.d9_estop_rail,
                "D10_SAFE": self.leds.d10_output_rail, "D11_RUN": self.leds.d11_run,
            },
            "faults": self.faults.__dict__.copy(),
        }

    def ai_volts(self, n: int) -> float:
        try:
            return float(self.ai_sources[n - 1]())
        except Exception:
            return 0.0

    def led_panel(self) -> str:
        """Compact text rendering of the board's LEDs (for the CLI)."""
        s = self.snapshot()
        on = lambda b: "●" if b else "○"  # noqa: E731
        k = " ".join(f"K{n}{on(v)}" for n, v in enumerate(self.leds.relays, start=1))
        v = " ".join(f"V{n}{on(x)}" for n, x in enumerate(self.leds.solenoids, start=1))
        d = "".join(on(x) for x in self.leds.inputs)
        return (f"24V{on(s['leds']['D3_24V'])} ESTOP{on(s['leds']['D9_ESTOP'])} "
                f"SAFE{on(s['leds']['D10_SAFE'])} RUN{on(s['leds']['D11_RUN'])} | {k} | {v} | DI {d}")
