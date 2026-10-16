"""Wired connection map and preflight checks for the SBC vacuum controller.

The connection map (``deploy/sbc/wiring-map.json``, installed on the Pi as
``/etc/sbc-vacuum/wiring-map.json``) is the site record of how the Raspberry
Pi, the RPi5VacuumIO board and the DB235 devices are wired.  This module:

* checks a vacuum profile (``vacuumSystem.json``) against that map, so a
  profile can never drive a relay or read an input the cabinet isn't wired to;
* checks the Pi itself: model, ``config.txt``, serial console, device nodes,
  service-user groups;
* optionally probes the board (``--probe``): the four I2C chips answer and
  are in their power-on state, and the E-stop / output rails are read back.
  The probe only reads registers.  It refuses to run while the controller
  service is active, and never resets expanders that are already running
  (a latched backing pump survives it).

Command line (run on the Pi; ``sbc-vacuum-preflight`` wraps it)::

    python -m glasgow_service.sbc_wiring show
    python -m glasgow_service.sbc_wiring check --profile /etc/sbc-vacuum/vacuumSystem.json
    python -m glasgow_service.sbc_wiring preflight [--probe]
    python -m glasgow_service.sbc_wiring preflight --emulator   # same checks on the emulated rig
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

INSTALLED_MAP = Path("/etc/sbc-vacuum/wiring-map.json")
INSTALLED_PROFILE = Path("/etc/sbc-vacuum/vacuumSystem.json")
REPO_MAP = Path(__file__).resolve().parents[1] / "deploy" / "sbc" / "wiring-map.json"
SERVICE_USER = "vacuum"
SERVICE_GROUPS = ("gpio", "i2c", "dialout")
SERIAL_CONSOLE_RE = re.compile(r"(?:^|\s)console=(?:serial0|serial1|ttyAMA\d+|ttyS0)(?:,\S*)?")

# Power-on register values used by the probe.
MCP23017_IODIR_RESET = 0xFF          # IODIRA / IODIRB: all pins inputs
ADS1115_CONFIG_RESET = 0x8583        # config register after power-on / general-call reset


# --------------------------------------------------------------------------- results

@dataclass
class Finding:
    level: str          # "ok" | "warn" | "error" | "info"
    check: str
    message: str


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)

    def add(self, level: str, check: str, message: str) -> None:
        self.findings.append(Finding(level, check, message))

    def ok(self, check, message):
        self.add("ok", check, message)

    def warn(self, check, message):
        self.add("warn", check, message)

    def error(self, check, message):
        self.add("error", check, message)

    def info(self, check, message):
        self.add("info", check, message)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.level == "error"]

    @property
    def passed(self) -> bool:
        return not self.errors

    def extend(self, other: "Report") -> "Report":
        self.findings.extend(other.findings)
        return self

    def render(self) -> str:
        mark = {"ok": "PASS", "warn": "WARN", "error": "FAIL", "info": "INFO"}
        lines = [f"[{mark[f.level]}] {f.check}: {f.message}" for f in self.findings]
        verdict = "PASS" if self.passed else f"FAIL ({len(self.errors)} error(s))"
        lines.append(f"preflight: {verdict}")
        return "\n".join(lines)

    def as_dict(self) -> dict:
        return {"passed": self.passed,
                "findings": [f.__dict__ for f in self.findings]}


# --------------------------------------------------------------------------- map

class WiringMap:
    def __init__(self, data: dict, path: Path | None = None) -> None:
        if data.get("schema") != "sbc-wiring-map/1":
            raise ValueError(f"{path or 'wiring map'}: unsupported schema {data.get('schema')!r}")
        self.data = data
        self.path = path

    @classmethod
    def load(cls, path: Path | None = None) -> "WiringMap":
        if path is None:
            path = INSTALLED_MAP if INSTALLED_MAP.is_file() else REPO_MAP
        return cls(json.loads(Path(path).read_text()), Path(path))

    @property
    def board(self) -> str:
        return self.data["board"]

    @property
    def devices(self) -> dict:
        return self.data["devices"]

    @property
    def terminals(self) -> dict:
        return self.data["terminals"]

    def header_line(self, net: str) -> dict:
        for row in self.data["header"]:
            if row.get("net") == net:
                return row
        raise KeyError(net)

    @property
    def board_bcm_lines(self) -> dict[int, str]:
        return {row["bcm"]: row["net"] for row in self.data["header"] if row.get("bcm") is not None}

    def i2c_addresses(self) -> dict[int, dict]:
        return {int(d["address"], 16): d for d in self.data["i2c"]["devices"]}

    def config_txt_lines(self, model: str) -> list[str]:
        return list(self.data["config_txt"][model])

    def serial_node(self, port: str, model: str) -> str | None:
        return self.data["serial"][port]["models"][model].get("node")

    def terminal_text(self, name: str) -> str:
        """``K2`` -> ``J12 (COM 1, NO 2, NC 3)``."""
        t = self.terminals.get(name)
        if t is None:
            return "?"
        pins = ", ".join(f"{k} {v}" for k, v in t["pins"].items())
        return f"{t['connector']} ({pins})"

    def render(self) -> str:
        out = [f"{self.board} rev {self.data['revision']} - wired connection map", "",
               "Raspberry Pi header -> J3"]
        for row in self.data["header"]:
            if row["kind"] in ("ground",):
                continue
            out.append(f"  pin {row['pin']:2d}  {row['name']:<7} {str(row.get('net') or '-'):<11} "
                       f"{row['function']}")
        out += ["", "I2C bus 1"]
        for addr, d in self.i2c_addresses().items():
            out.append(f"  0x{addr:02x}  {d['ref']:<4} {d['chip']:<9} {d['role']}")
        out += ["", "Devices -> terminals"]
        for name, dev in self.devices.items():
            out.append(f"  {name}")
            for role in ("output", "ready", "fault", "gauge", "speed", "valve"):
                if dev.get(role):
                    out.append(f"    {role:<7} {dev[role]:<5} {self.terminal_text(dev[role])}")
            if dev.get("rs485_address") is not None:
                out.append(f"    rs485   address {dev['rs485_address']} on J4")
            out.append(f"    wire to {dev.get('wire_to', '-')}")
        out += ["", "Other field I/O"]
        for key, text in {**self.data.get("field_inputs", {}), **self.data.get("field_outputs", {})}.items():
            out.append(f"  {key:<5} {self.terminal_text(key):<34} {text}")
        return "\n".join(out)


def render_markdown(wmap: WiringMap) -> str:
    """The same map as Markdown tables (installed as WIRING-MAP.md)."""
    lines = [f"# {wmap.board} rev {wmap.data['revision']}: wired connection map", "",
             wmap.data.get("note", ""), "", "## Raspberry Pi header -> J3", "",
             "| Pin | Pi | Net | Function |", "|---|---|---|---|"]
    for row in wmap.data["header"]:
        lines.append(f"| {row['pin']} | {row['name']} | {row.get('net') or '-'} | {row['function']} |")
    lines += ["", "## Devices -> board terminals", "",
              "| Device | Output | Ready | Fault | Gauge | Valve | Speed | RS-485 |", "|---|---|---|---|---|---|---|---|"]
    for name, dev in wmap.devices.items():
        cell = lambda key: f"{dev[key]} {wmap.terminal_text(dev[key])}" if dev.get(key) else "-"  # noqa: E731
        lines.append(f"| {name} | {cell('output')} | {cell('ready')} | {cell('fault')} | {cell('gauge')} | "
                     f"{cell('valve')} | {cell('speed')} | {dev.get('rs485_address', '-')} |")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- model / files

def model_from_string(text: str) -> str | None:
    """``/proc/device-tree/model`` text -> ``"4B"``, ``"5"`` or None."""
    t = text.strip("\x00 \n")
    if re.search(r"Raspberry Pi 5\b", t):
        return "5"
    if re.search(r"Raspberry Pi 4 Model B\b", t):
        return "4B"
    return None


class Host:
    """The Pi's filesystem, optionally under a root prefix (tests, image builds)."""

    def __init__(self, root: Path | str = "/") -> None:
        self.root = Path(root)

    def path(self, absolute: str) -> Path:
        return self.root / absolute.lstrip("/")

    def read(self, absolute: str) -> str | None:
        try:
            return self.path(absolute).read_bytes().decode(errors="replace")
        except OSError:
            return None

    def exists(self, absolute: str) -> bool:
        return self.path(absolute).exists()

    def glob(self, pattern: str) -> list[str]:
        prefix = str(self.root).rstrip("/")
        return sorted("/" + str(Path(p).relative_to(self.root))
                      for p in glob.glob(prefix + "/" + pattern.lstrip("/")))

    def model_text(self) -> str | None:
        return self.read("/proc/device-tree/model")

    def model(self) -> str | None:
        text = self.model_text()
        return model_from_string(text) if text else None

    def boot_dir(self) -> str:
        return "/boot/firmware" if self.exists("/boot/firmware/config.txt") else "/boot"

    def group_members(self, group: str) -> set[str] | None:
        text = self.read("/etc/group")
        if text is None:
            return None
        for line in text.splitlines():
            parts = line.split(":")
            if len(parts) >= 4 and parts[0] == group:
                return {m for m in parts[3].split(",") if m}
        return None

    def primary_group_of(self, user: str) -> str | None:
        passwd, groups = self.read("/etc/passwd"), self.read("/etc/group")
        if not passwd or not groups:
            return None
        gid = next((ln.split(":")[3] for ln in passwd.splitlines() if ln.split(":")[0] == user), None)
        return next((ln.split(":")[0] for ln in groups.splitlines()
                     if len(ln.split(":")) > 2 and ln.split(":")[2] == gid), None)

    def resolve_dt_tty(self, dt_node: str) -> str | None:
        """Find ``/dev/ttyAMAx`` whose device-tree node ends with ``dt_node``."""
        for of_node in self.glob("/sys/class/tty/ttyAMA*/device/of_node"):
            try:
                target = os.path.realpath(self.path(of_node))
            except OSError:
                continue
            if target.rstrip("/").endswith(dt_node):
                return "/dev/" + of_node.split("/")[4]
        return None


def active_config_lines(text: str, model: str | None = None) -> list[str]:
    """config.txt lines that apply on this board: no filter, [all], or [pi4]/[pi5]."""
    own = {"4B": "[pi4]", "5": "[pi5]"}.get(model or "", None)
    out, applies = [], True
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            applies = line.lower() == "[all]" or (own is not None and line.lower() == own)
            continue
        if applies:
            out.append(line.replace(" ", ""))
    return out


# --------------------------------------------------------------------------- profile vs map

def check_profile(wmap: WiringMap, payload: dict, model: str | None = None) -> Report:
    """Check a ``vacuumSystem.json`` payload against the connection map."""
    r = Report()
    sbc = payload.get("SBC") or {}
    pumps = payload.get("VacuumPumps") or []

    try:
        from .vacuum import VacuumConfig
        VacuumConfig.model_validate(payload)
        r.ok("profile", "validates against the controller's schema")
    except Exception as exc:  # pydantic ValidationError or ValueError
        r.error("profile", f"does not validate: {str(exc).splitlines()[0]}")

    if "GPIO" in sbc and sbc.get("GPIO"):
        board_lines = wmap.board_bcm_lines
        clashes = []
        for logical, raw in sbc["GPIO"].items():
            m = re.fullmatch(r"(?:GPIO|BCM)?(\d+)", str(raw).strip(), re.IGNORECASE)
            if m and int(m.group(1)) in board_lines:
                clashes.append(f"{logical}=GPIO{m.group(1)} ({board_lines[int(m.group(1))]})")
        r.error("profile.mode",
                "direct-GPIO profile (SBC.GPIO) on a board installation"
                + (f"; it would drive the board's own lines: {', '.join(clashes)}" if clashes else "")
                + f". Use an SBC.Board profile (\"Board\": \"{wmap.board}\").")
        return r
    if sbc.get("Board") != wmap.board:
        r.error("profile.board", f"SBC.Board is {sbc.get('Board')!r}, the map is for {wmap.board!r}")
        return r

    channels = sbc.get("Channels") or {}
    faults = sbc.get("Faults") or {}
    valves = sbc.get("Valves") or {}
    gauges = sbc.get("Gauges") or {}

    def compare(device: str, role: str, actual: str | None, path: str) -> None:
        expected = wmap.devices.get(device, {}).get(role)
        if expected is None and actual is None:
            return
        if expected is None:
            r.warn("wiring", f"{device}: {path} = {actual}, but the map has no {role} for {device} "
                             "(add it to the wiring map if it is wired)")
        elif actual is None:
            r.warn("wiring", f"{device}: the map wires its {role} to {expected} "
                             f"({wmap.terminal_text(expected)}) but the profile does not use it")
        elif actual != expected:
            r.error("wiring", f"{device}: {path} = {actual} ({wmap.terminal_text(actual)}), "
                              f"but it is wired to {expected} ({wmap.terminal_text(expected)})")
        else:
            r.ok("wiring", f"{device} {role} {actual} -> {wmap.terminal_text(actual)}")

    for pump in pumps:
        name, a, b = pump.get("name"), pump.get("write"), pump.get("read")
        if name not in wmap.devices:
            r.warn("wiring", f"{name}: not in the wiring map; its terminals are not checked")
            continue
        compare(name, "output", channels.get(a), f"SBC.Channels.{a}")
        compare(name, "ready", channels.get(b), f"SBC.Channels.{b}")
        compare(name, "fault", faults.get(b), f"SBC.Faults.{b}")
        compare(name, "valve", valves.get(b), f"SBC.Valves.{b}")
        gauge = gauges.get(b)
        compare(name, "gauge", gauge.get("AIN") if isinstance(gauge, dict) else None, f"SBC.Gauges.{b}.AIN")
        if isinstance(gauge, dict) and gauge.get("Interlock") is False:
            r.warn("gauges", f"{name}: Interlock is false (commissioning jumper test only; "
                             "set it back before connecting the tool)")
    hv = (payload.get("HighVoltageTransformer") or {}).get("write")
    if hv:
        compare("HighVoltageTransformer", "output", channels.get(hv), f"SBC.Channels.{hv}")

    if model is not None:
        if sbc.get("PiModel", "4B") != model:
            r.error("profile.model", f"SBC.PiModel is {sbc.get('PiModel', '4B')!r} but this is a Pi {model}")
        serial = sbc.get("Serial") or {}
        for port in ("RS485", "RS232"):
            expected = wmap.serial_node(port, model)
            actual = serial.get(port)
            if expected and actual and actual != expected:
                r.error("profile.serial", f"SBC.Serial.{port} = {actual}, expected {expected} on a Pi {model}")
    if sbc.get("KeepBackingPumpOnRestart"):
        r.info("profile", "KeepBackingPumpOnRestart is on: it only works if IO_RESET_N stays high with "
                          "no process holding it (pull-up instead of R10, or kernel GPIO persistence)")
    r.info("profile", f"Enable={payload.get('Enable', False)} IsProduction={payload.get('IsProduction', True)}")
    return r


def profile_for_model(template: dict, model: str, wmap: WiringMap, rs232_node: str | None = None) -> dict:
    """A board profile for ``model``, safe for a first start (control disabled)."""
    payload = json.loads(json.dumps(template))
    sbc = payload.setdefault("SBC", {})
    sbc["PiModel"] = model
    serial = sbc.setdefault("Serial", {})
    serial["RS485"] = wmap.serial_node("RS485", model)
    node = wmap.serial_node("RS232", model) or rs232_node
    if node:
        serial["RS232"] = node
    sbc.setdefault("KeepBackingPumpOnRestart", False)
    payload["Enable"] = False          # WIRING.md: keep control off until commissioning
    payload["IsProduction"] = True     # on the Pi: real hardware, never the emulator
    payload["Simulate"] = False
    msgs = [m for m in payload.get("Message", []) if "IsProduction" not in m and "Enable:" not in m
            and not m.startswith("    true") and not m.startswith("    false")
            and not m.startswith("    Read at service")]
    msgs.append("Enable/IsProduction: this SBC profile alone decides how the SBC runs. Installed with "
                "Enable false; set it true at WIRING.md step 12 and restart sbc-vacuum.")
    payload["Message"] = msgs
    return payload


# --------------------------------------------------------------------------- host checks

def check_host(wmap: WiringMap, host: Host, model: str | None = None) -> Report:
    r = Report()
    text = host.model_text()
    detected = model_from_string(text) if text else None
    if text is None:
        r.error("model", "not a Raspberry Pi (/proc/device-tree/model missing)")
    elif detected is None:
        r.error("model", f"unsupported board: {text.strip(chr(0))!r} (Pi 4 Model B or Pi 5)")
    else:
        r.ok("model", text.strip("\x00\n "))
    model = model or detected
    if model is None:
        return r

    boot = host.boot_dir()
    cfg = host.read(f"{boot}/config.txt")
    if cfg is None:
        r.error("config.txt", f"{boot}/config.txt not found")
    else:
        lines = active_config_lines(cfg, model)
        missing = [ln for ln in wmap.config_txt_lines(model) if ln.replace(" ", "") not in lines]
        if missing:
            r.error("config.txt", f"missing in {boot}/config.txt: {', '.join(missing)}")
        else:
            r.ok("config.txt", "I2C1, UARTs and overlays enabled for the board")
        if model == "4B" and "dtoverlay=uart4-pi5" in lines or model == "5" and "dtoverlay=disable-bt" in lines:
            r.warn("config.txt", "has an overlay for the other Pi model")
    cmdline = host.read(f"{boot}/cmdline.txt")
    if cmdline is not None and SERIAL_CONSOLE_RE.search(cmdline):
        r.error("console", f"{boot}/cmdline.txt puts a login console on the serial port "
                           "(it would talk on the RS-485 bus); remove console=serial0,...")
    elif cmdline is not None:
        r.ok("console", "no serial console on the RS-485 UART")

    for node, why in (("/dev/i2c-1", "I2C1 (reboot after enabling i2c_arm)"),):
        (r.ok if host.exists(node) else r.error)("devices", f"{node} {'present' if host.exists(node) else 'missing'}: {why}")
    chips = host.glob("/dev/gpiochip*")
    (r.ok if chips else r.error)("devices", f"GPIO chips: {', '.join(chips) or 'none'}")
    rs485 = wmap.serial_node("RS485", model)
    (r.ok if host.exists(rs485) else r.error)("serial", f"RS-485 {rs485} {'present' if host.exists(rs485) else 'missing'}")
    rs232 = wmap.serial_node("RS232", model)
    if rs232 is None:
        dt = wmap.data["serial"]["RS232"]["models"][model].get("dt_node")
        rs232 = host.resolve_dt_tty(dt) if dt else None
        if rs232:
            r.ok("serial", f"RS-232 resolved to {rs232} ({dt})")
        else:
            r.warn("serial", "RS-232 UART not found (only needed for a J5 gauge controller)")
    else:
        (r.ok if host.exists(rs232) else r.warn)(
            "serial", f"RS-232 {rs232} {'present' if host.exists(rs232) else 'missing (only needed for J5)'}")

    if host.read("/etc/passwd") is not None:
        missing = [g for g in SERVICE_GROUPS
                   if SERVICE_USER not in (host.group_members(g) or set())
                   and host.primary_group_of(SERVICE_USER) != g]
        if host.group_members("gpio") is None and host.group_members("i2c") is None:
            r.warn("user", "no gpio/i2c groups on this system (not Raspberry Pi OS?)")
        elif missing:
            r.error("user", f"service user {SERVICE_USER!r} is not in group(s): {', '.join(missing)}")
        else:
            r.ok("user", f"{SERVICE_USER} can open GPIO, I2C and the UARTs")
    return r


def check_serial_nodes(wmap: WiringMap, payload: dict, host: Host, model: str | None) -> Report:
    """Pi 4B: the uart5 tty number is only known on the running system."""
    r = Report()
    if model is None:
        return r
    entry = wmap.data["serial"]["RS232"]["models"][model]
    if entry.get("node") is not None or not entry.get("dt_node"):
        return r
    resolved = host.resolve_dt_tty(entry["dt_node"])
    configured = ((payload.get("SBC") or {}).get("Serial") or {}).get("RS232")
    if resolved and configured and resolved != configured:
        r.warn("profile.serial", f"SBC.Serial.RS232 = {configured} but uart5 is {resolved} on this Pi "
                                 "(only matters if J5 is used)")
    elif resolved and configured:
        r.ok("profile.serial", f"SBC.Serial.RS232 {configured} is uart5")
    return r


# --------------------------------------------------------------------------- hardware probe

@dataclass
class ProbeIO:
    """What the probe needs: the board driver's GPIO HAL and an SMBus."""
    gpio: object                        # GpioHAL: setup_output/setup_input/write/read/close
    bus: object                         # smbus2.SMBus-like
    sleep: Callable[[float], None]
    close: Callable[[], None] = lambda: None


def _acks(bus, addr: int) -> bool:
    try:
        bus.read_byte_data(addr, 0x00)
        return True
    except OSError:
        return False


def probe_board(wmap: WiringMap, io: ProbeIO) -> Report:
    r = Report()
    addrs = wmap.i2c_addresses()
    expanders = [a for a, d in addrs.items() if d["chip"] == "MCP23017"]
    adcs = [a for a, d in addrs.items() if d["chip"] == "ADS1115"]
    reset = wmap.header_line("IO_RESET_N")["bcm"]
    took_reset = False
    try:
        # Rails first: inputs only, nothing changes.
        for net, rail in (("ESTOP_OK_N", "E-stop rail (+24V_ESTOP, D9)"),
                          ("SAFE_OK_N", "output rail (+24V_SAFE, D10)")):
            bcm = wmap.header_line(net)["bcm"]
            io.gpio.setup_input(bcm, None)
            live = not io.gpio.read(bcm)
            r.info("rails", f"{rail}: {'live' if live else 'off'} (GPIO{bcm})")
        if any(_acks(io.bus, a) for a in expanders):
            # Expanders already out of reset: something is holding IO_RESET_N
            # high (a latched backing pump across a restart).  Read only.
            r.warn("probe", "expanders already out of reset (IO_RESET_N held high); reading without "
                            "touching IO_RESET_N so latched outputs stay as they are")
        else:
            io.gpio.setup_output(reset, True)
            took_reset = True
            io.sleep(0.01)
        for a in sorted(addrs):
            d = addrs[a]
            if not _acks(io.bus, a):
                r.error("i2c", f"0x{a:02x} {d['ref']} {d['chip']} does not answer "
                               "(ribbon orientation, i2c_arm, board 3V3)")
                continue
            if a in expanders:
                iodir = io.bus.read_i2c_block_data(a, 0x00, 2)
                if took_reset and iodir != [MCP23017_IODIR_RESET] * 2:
                    r.error("i2c", f"0x{a:02x} {d['ref']} IODIR={iodir}, expected power-on 0xff/0xff")
                else:
                    state = "power-on state (all pins inputs, relays and valves off)" if iodir == [0xFF, 0xFF] else f"IODIR={iodir}"
                    r.ok("i2c", f"0x{a:02x} {d['ref']} MCP23017 answers; {state}")
            elif a in adcs:
                hi, lo = io.bus.read_i2c_block_data(a, 0x01, 2)
                config = (hi << 8) | lo
                if config & 0x7FFF == ADS1115_CONFIG_RESET & 0x7FFF:
                    r.ok("i2c", f"0x{a:02x} {d['ref']} ADS1115 answers; config 0x{config:04x}")
                else:
                    r.warn("i2c", f"0x{a:02x} {d['ref']} ADS1115 config 0x{config:04x} "
                                  f"(not the reset value 0x{ADS1115_CONFIG_RESET:04x})")
    finally:
        if took_reset:
            try:
                io.gpio.write(reset, False)
            except Exception:
                pass
        io.close()
    return r


def real_probe_io(i2c_bus: int = 1) -> ProbeIO:  # pragma: no cover - hardware only
    from smbus2 import SMBus

    from .vacuum_io_board import LgpioHAL
    gpio = LgpioHAL()
    bus = SMBus(i2c_bus)

    def close():
        bus.close()
        gpio.close()
    return ProbeIO(gpio=gpio, bus=bus, sleep=time.sleep, close=close)


def emulated_probe_io(rig) -> ProbeIO:
    gpio = rig.gpio_hal()
    return ProbeIO(gpio=gpio, bus=rig.smbus(1), sleep=rig.sleep, close=gpio.close)


def service_active(unit: str = "sbc-vacuum") -> bool:  # pragma: no cover - systemd only
    try:
        return subprocess.run(["systemctl", "is-active", "--quiet", unit]).returncode == 0
    except FileNotFoundError:
        return False


# --------------------------------------------------------------------------- CLI

def _load_profile(path: Path) -> dict:
    return json.loads(Path(path).read_text())


def run_preflight(wmap: WiringMap, profile: Path | None, host: Host, *, probe: bool,
                  probe_io: Callable[[], ProbeIO] | None = None, model: str | None = None,
                  check_service: Callable[[], bool] = service_active) -> Report:
    report = Report()
    report.extend(check_host(wmap, host, model))
    model = model or host.model()
    if profile is not None:
        if Path(profile).is_file():
            payload = _load_profile(profile)
            report.extend(check_profile(wmap, payload, model))
            report.extend(check_serial_nodes(wmap, payload, host, model))
        else:
            report.error("profile", f"{profile} not found")
    if probe:
        if check_service():
            report.error("probe", "sbc-vacuum is running; stop it first (the probe needs the GPIO "
                                  "lines; stopping it switches the pumps off) or skip --probe")
        else:
            report.extend(probe_board(wmap, (probe_io or real_probe_io)()))
    return report


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sbc-vacuum-preflight", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map", type=Path, default=None, help=f"wiring map (default {INSTALLED_MAP})")
    sub = ap.add_subparsers(dest="cmd", required=True)
    show = sub.add_parser("show", help="print the connection map")
    show.add_argument("--markdown", action="store_true")
    chk = sub.add_parser("check", help="check a vacuum profile against the map (no hardware)")
    chk.add_argument("--profile", type=Path, default=INSTALLED_PROFILE)
    chk.add_argument("--model", choices=["4B", "5"], default=None)
    pf = sub.add_parser("preflight", help="check this Pi, the profile and optionally the board")
    pf.add_argument("--profile", type=Path, default=INSTALLED_PROFILE)
    pf.add_argument("--root", type=Path, default=Path("/"))
    pf.add_argument("--model", choices=["4B", "5"], default=None)
    pf.add_argument("--probe", action="store_true", help="read the board's I2C chips and rails")
    pf.add_argument("--emulator", action="store_true", help="probe the emulated rig instead of hardware")
    mk = sub.add_parser("make-profile", help="write a first board profile for this Pi (Enable false)")
    mk.add_argument("--template", type=Path, required=True)
    mk.add_argument("--model", choices=["4B", "5"], required=True)
    mk.add_argument("--root", type=Path, default=Path("/"))
    mk.add_argument("--out", type=Path, required=True)
    for p in (chk, pf):
        p.add_argument("--json", action="store_true")
    args = ap.parse_args(list(argv) if argv is not None else None)
    wmap = WiringMap.load(args.map)

    if args.cmd == "show":
        print(render_markdown(wmap) if args.markdown else wmap.render())
        return 0
    if args.cmd == "make-profile":
        rs232 = None
        entry = wmap.data["serial"]["RS232"]["models"][args.model]
        if entry.get("node") is None and entry.get("dt_node"):
            rs232 = Host(args.root).resolve_dt_tty(entry["dt_node"])
        payload = profile_for_model(_load_profile(args.template), args.model, wmap, rs232)
        report = check_profile(wmap, payload, args.model)
        if not report.passed:
            print(report.render())
            return 1
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"wrote {args.out} (PiModel {args.model}, Enable false, IsProduction true"
              + (f", RS232 {payload['SBC']['Serial'].get('RS232')}" if payload['SBC'].get('Serial') else "") + ")")
        return 0
    if args.cmd == "check":
        report = check_profile(wmap, _load_profile(args.profile), args.model)
    elif args.emulator:
        from .emulation.rig import VacuumRig
        rig = VacuumRig(tool_connected=False)
        report = Report()
        if args.profile and Path(args.profile).is_file():
            report.extend(check_profile(wmap, _load_profile(args.profile), args.model))
        report.extend(probe_board(wmap, emulated_probe_io(rig)))
    else:
        report = run_preflight(wmap, args.profile, Host(args.root), probe=args.probe, model=args.model)
    print(json.dumps(report.as_dict(), indent=2) if args.json else report.render())
    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
