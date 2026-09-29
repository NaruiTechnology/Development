"""Translate explicit instrument configuration to the vendored Glasgow API."""
import math

from .glasgowLib.glasgow.abstract import GlasgowPin
from .glasgowLib.glasgow.applet import PinArgument
from .commands.structs import Transforms


BEAM_PORTS = tuple(f"{beam}_{role}" for beam in ("ebeam", "ibeam")
                   for role in ("scan_enable", "blank_enable", "blank"))


def configure_scan_args(config, action, args):
    """Resolve pin roles, transforms and timing once, before building hardware.

    Read beam pin roles, transforms and timing from JSON actionData. CLI pin
    lists remain supported. Modern A/B pins are translated to indices relative
    to port_spec for the legacy multiplexer and configurable-pull API.
    """
    instrument = action

    modern = {}
    for beam, local in (("electron", "ebeam"), ("ion", "ibeam")):
        pinout = instrument.get("beam", {}).get(beam, {}).get("pinout", {})
        unknown = set(pinout) - {"scan_enable", "blank_enable", "blank"}
        if unknown:
            raise ValueError(f"unknown {beam} pin roles: {sorted(unknown)}")
        for role, spec in pinout.items():
            if not isinstance(spec, str):
                raise ValueError(f"{beam}.{role}: use explicit A/B pin strings, e.g. A2#,A3")
            modern[f"{local}_{role}"] = list(GlasgowPin.parse(spec))

    claimed_ports = {str(pin.port) for pins in modern.values() for pin in pins}
    # The OBI analog interface uses both Glasgow VIO rails even when the
    # microscope-control pins happen to live entirely on port A. The shared
    # ADC/DAC bus is added as raw FPGA resources later, so the legacy
    # multiplexer cannot infer its VIO dependency from the beam PinArguments.
    # Upstream OBI consequently claims and powers A+B explicitly. Do the same
    # for a physical scan; otherwise port B is only alive when some previous
    # process happened to leave it powered.
    if bool(getattr(config, "IsProduction", False)) and action.get("pins"):
        claimed_ports.update(("A", "B"))
    port_spec = "".join(sorted(claimed_ports))
    seen = set()
    for name, pins in modern.items():
        if not 1 <= len(pins) <= 2:
            raise ValueError(f"{name} requires one or two pins")
        for pin in pins:
            key = (pin.port, pin.number)
            if not 0 <= pin.number <= 7 or key in seen:
                raise ValueError(f"invalid or duplicate beam pin: {pin}")
            seen.add(key)
        setattr(args, name, [PinArgument(port_spec.index(str(p.port)) * 8 + p.number,
                                        invert=p.invert) for p in pins])
    if modern:
        args.port_spec = port_spec
    else:
        args.port_spec = getattr(args, "port_spec", "")
    for name in BEAM_PORTS:
        if not hasattr(args, name):
            setattr(args, name, None)

    transforms = instrument.get("transforms", {})
    for name in ("xflip", "yflip", "rotate90"):
        value = transforms.get(name, getattr(args, name, False))
        if not isinstance(value, bool):
            raise ValueError(f"{name} must be boolean")
        setattr(args, name, value)
    args.transforms = Transforms(args.xflip, args.yflip, args.rotate90)
    delay = float(instrument.get("timings", {}).get(
        "ext_switch_delay_ms", getattr(args, "ext_switch_delay", 0)))
    if not math.isfinite(delay) or not 0 <= delay * 48000 < 2**24:
        raise ValueError("external switch delay must fit the 24-bit 48 MHz counter")
    args.ext_switch_delay_cycles = round(delay * 48000)
    args.beam_pull_high = [pin for name in BEAM_PORTS for pin in (getattr(args, name) or [])]
    # This driver consumes voltage, not the newer assembly API's voltage_map.
    voltage = float(action.get("voltage", getattr(args, "voltage", 3.3)))
    if not math.isfinite(voltage) or not 1.8 <= voltage <= 5.0:
        raise ValueError("Glasgow I/O voltage must be between 1.8 and 5.0 V")
    args.voltage = voltage if args.port_spec else None
    return args
