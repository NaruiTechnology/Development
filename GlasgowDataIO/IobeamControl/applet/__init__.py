"""
IobeamControl/applet/__init__.py
================================

Shared signatures for the iobeam applet, plus a *dynamic* iobeam_resources
builder that reads its pin assignments from streamData.json instead of
hard-coding them.

Why "dynamic"?
--------------
Previously this file had a fixed `iobeam_resources = [...]` list with the
data-bus pin string commented out and the control strobes missing. That
forced two impossible choices: either ship placeholder pins that fail
during PCF generation (ERROR: package does not have a pin named
'TODO_ADC_CLK'), or hard-code real pins that don't yet exist on the
IobeamTech sub-target PCB.

The new flow:

    1. Host loads streamData.json -> action.pins dict
    2. Host calls build_iobeam_resources(pin_config)
    3. Subtarget calls platform.add_resources(resources_list)

If a Subsignal is *absent* from the pin_config, no Resource constraint
is emitted for it - the FPGA-internal signal still toggles, it just
doesn't fan out to a physical pad. Combined with FakeAdcSimulator
(applet/fakeAdcSimulator.py), that means the design synthesises and
routes successfully on a Glasgow C3 with NO sub-target board attached.
"""

from amaranth import *
from amaranth.build import *
from amaranth.lib import enum, data, io, wiring
from amaranth.lib.wiring import In, Out, flipped
from dataclasses import dataclass


# ---------------------------------------------------------------------------- #
# Default fallback resources.
#
# These run whenever no pin_config is supplied (e.g. simulation-only builds
# under `pytest unittest/applet/`). They contain ONLY the LED, which the
# Glasgow platform itself defines, plus an empty data Resource so existing
# `platform.request("data")` calls don't raise. The control strobes are
# absent on purpose - FakeAdcSimulator in loopback mode never needs them
# routed externally.
#
# Real builds always supply pin_config and ignore this default.
# ---------------------------------------------------------------------------- #
iobeam_resources = []


# ---------------------------------------------------------------------------- #
# build_iobeam_resources(pin_config) -> list[Resource]
#
# pin_config schema (mirrors streamData.json -> action.pins):
#
#   {
#     "control": {                  # optional
#       "subsignals": [
#         { "name": "adc_clk", "pin": "A1", "direction": "o", "invert": false },
#         { "name": "adc_oe",  "pin": "B3", "direction": "o" },
#         ...
#       ],
#       "attrs": { "IO_STANDARD": "SB_LVCMOS33" }   # optional
#     },
#     "data": {                     # optional
#       "pins": "B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2",
#       "direction": "io",
#       "attrs": { "IO_STANDARD": "SB_LVCMOS33" }
#     }
#   }
#
# Rules:
#   - any missing top-level key (control / data) -> that Resource is omitted
#   - any missing strobe in control.subsignals -> that Subsignal is omitted
#     (the FPGA-internal signal still drives FakeAdcSimulator; it just
#      doesn't escape to a pin)
#   - empty pin string ("") -> entry skipped (would fail PCF generation)
#   - direction defaults to "o" for control strobes, "io" for data
#
# Returns a list ready to pass to platform.add_resources().
# ---------------------------------------------------------------------------- #
def build_iobeam_resources(pin_config):
    """
    Build an Amaranth `Resource` list from a JSON-derived dict.

    See module docstring for the schema.
    """
    if not pin_config:
        return []

    resources = []

    # -- control resource ---------------------------------------------------- #
    ctrl = pin_config.get("control")
    if ctrl:
        subsignals = []
        for entry in ctrl.get("subsignals", []):
            name = entry.get("name")
            pin  = (entry.get("pin") or "").strip()
            if not name or not pin:
                # Skip entries with empty pin strings - they would crash
                # nextpnr-ice40 with "package does not have a pin named ''".
                continue
            direction = entry.get("direction", "o")
            invert    = entry.get("invert", False)
            subsignals.append(
                Subsignal(name, Pins(pin, dir=direction, invert=invert))
            )
        if subsignals:
            attrs = ctrl.get("attrs", {"IO_STANDARD": "SB_LVCMOS33"})
            resources.append(
                Resource("control", 0, *subsignals, Attrs(**attrs))
            )

    # -- data resource ------------------------------------------------------- #
    dat = pin_config.get("data")
    if dat:
        pins_str = (dat.get("pins") or "").strip()
        if pins_str:
            direction = dat.get("direction", "io")
            attrs     = dat.get("attrs", {"IO_STANDARD": "SB_LVCMOS33"})
            resources.append(
                Resource("data", 0,
                         Pins(pins_str, dir=direction),
                         Attrs(**attrs))
            )

    return resources


def validate_obi_pin_config(pin_config):
    """Validate the physical OBI bus before a non-loopback build.

    The upstream design has six control strobes and one 14-bit shared bus.
    Silently omitting one of these resources still produces a valid FPGA image
    with incomplete physical I/O. Simulation may deliberately omit resources, so this helper is
    called only for the real-board path.
    """
    cfg = pin_config or {}
    control = cfg.get("control") or {}
    entries = control.get("subsignals", [])
    names = {s.get("name") for s in entries if (s.get("pin") or "").strip()}
    required = {"adc_clk", "adc_le_clk", "adc_oe", "dac_clk",
                "dac_x_le_clk", "dac_y_le_clk"}
    missing = sorted(required - names)
    data = cfg.get("data") or {}
    data_pins = (data.get("pins") or "").split()
    expected = {
        "adc_clk": ("G1", True), "adc_le_clk": ("H2", False),
        "adc_oe": ("G3", True), "dac_clk": ("F3", True),
        "dac_x_le_clk": ("H3", False), "dac_y_le_clk": ("H1", False),
    }
    if missing or len(data_pins) != 14:
        problems = []
        if missing:
            problems.append("missing control strobes: " + ", ".join(missing))
        if len(data_pins) != 14:
            problems.append(f"shared data bus has {len(data_pins)} pins; expected 14")
        raise ValueError("Invalid OBI pin configuration: " + "; ".join(problems))
    for name, (pin, invert) in expected.items():
        matches = [s for s in entries if s.get("name") == name]
        if len(matches) != 1 or (
            matches[0].get("pin", "").strip(), matches[0].get("direction", "o"),
            matches[0].get("invert", False),
        ) != (pin, "o", invert):
            raise ValueError(f"Invalid OBI pin configuration for {name}: "
                             f"expected {pin}, output, invert={invert}")
    if data_pins != "B2 C4 B1 C3 C2 C1 D3 D1 F4 G2 E3 F1 E2 F2".split() or data.get("direction", "io") != "io":
        raise ValueError("Invalid OBI pin configuration: shared bus order/direction differs from upstream")


# ---------------------------------------------------------------------------- #
# Bus signature shared by BusController <-> IobeamDataSubtarget.
#
# data_i is 16 bits so simulation and serializer output can carry a
# full 16-bit grayscale sample. The physical data pins are still 14
# bits, so the subtarget expands the external port into this internal
# bus when real hardware is present.
# ---------------------------------------------------------------------------- #
BusSignature = wiring.Signature({
    "adc_clk":      Out(1),
    "adc_le_clk":   Out(1),
    "adc_oe":       Out(1),

    "dac_clk":      Out(1),
    "dac_x_le_clk": Out(1),
    "dac_y_le_clk": Out(1),

    "data_i":       In(16),
    "data_o":       Out(14),
    "data_oe":      Out(1),
})


def StreamSignature(data_layout):
    return wiring.Signature({
        "payload": Out(data_layout),
        "valid":   Out(1),
        "ready":   In(1),
    })


@dataclass
class BIG_ENDIAN:
    xflip: bool
    yflip: bool
    rotate90: bool


class BlankRequest(data.Struct):
    enable:  1
    request: 1


class DACStream(data.Struct):
    dac_x_code: 14
    padding_x:  2
    dac_y_code: 14
    padding_y:  2
    dwell_time: 16
    blank:      BlankRequest
    delay:      3


class SuperDACStream(data.Struct):
    dac_x_code: 14
    padding_x:  2
    dac_y_code: 14
    padding_y:  2
    blank:      BlankRequest
    last:       1
    delay:      3


class RasterRegion(data.Struct):
    x_start:         14  # UQ(14,0)
    padding_x_start: 2
    x_count:         14  # UQ(14,0)
    padding_x_count: 2
    x_step:          16  # UQ(8,8)
    y_start:         14  # UQ(14,0)
    padding_y_start: 2
    y_count:         14  # UQ(14,0)
    padding_y_count: 2
    y_step:          16  # UQ(8,8)
