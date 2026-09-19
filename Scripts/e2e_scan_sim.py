#!/usr/bin/env python3
"""End-to-end scan test without hardware.

    host macros (RasterScanCommand / VectorScanCommand)
      -> Connection.transfer_multiple           (the real host code path)
      -> BenchStream                            (bytes <-> simulator bridge)
      -> IobeamDataSubtarget in Amaranth's simulator (the real gateware)
      -> image, compared with what the scan should have measured.

Two data-path modes:

  sim       IsProduction=false behaviour. The gateware's FakeAdcSimulator returns
            a known image addressed by the DAC codes.

  physical  IsProduction=true behaviour. The subtarget is built with the real
            pin configuration from streamData.json and the real input buffer;
            a *pad-level board model* answers on the data pads:
              * DAC X/Y registers clocked by the X/Y latch pads,
              * an LTC2246-style ADC: converts on the ADC clock pad, N-cycle
                pipeline,
              * an SN74ALVCH16374-style output register clocked by the ADC
                latch pad, driven onto the shared bus while the active-low
                /OE pad is low,
              * bus-hold when nothing drives the bus.
            The model needs no latency tuning: an LTC2246-style 5-conversion
            pipeline plus the registered DAC and U6 stages add up to the 8
            conversions the FSM (and upstream OBI) assume. That is a property
            of this model of the board, not a measurement of the real one.
            This validates that the gateware, given a board that behaves like
            this model, captures correct samples. It does NOT validate the real
            board: a stuck /OE level, a dead clock, or a missing supply cannot
            be seen here.

Run it with the interpreter of the deployed virtualenv so the compiled deployed
code is what is tested:

    ~/IobeamPlatform/.venv/bin/python e2e_scan_sim.py --root ~/IobeamPlatform
"""
import argparse
import asyncio
import collections
import copy
import json
import os
import sys
import warnings
from types import SimpleNamespace

warnings.filterwarnings("ignore")

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--root", default=os.path.expanduser("~/IobeamPlatform"), help="deploy root")
parser.add_argument("--grid", type=int, default=256, help="DAC grid / image resolution (>=128)")
parser.add_argument("--roi", type=int, default=16, help="scan an NxN region of interest")
parser.add_argument("--json", help="streamData.json (default: the deployed one)")
parser.add_argument("--quick", action="store_true", help="fewer scenarios")
ARGS = parser.parse_args()

DEV = os.path.join(ARGS.root, "Development")
sys.path.insert(0, DEV)
import numpy as np  # noqa: E402
from amaranth import Fragment, Signal  # noqa: E402
from amaranth.lib import io  # noqa: E402
from amaranth.sim import Simulator  # noqa: E402

from GlasgowDataIO.IobeamControl.applet.adcTiming import AdcTiming  # noqa: E402
from GlasgowDataIO.IobeamControl.applet.iobeamDataSubtarget import IobeamDataSubtarget  # noqa: E402
from GlasgowDataIO.IobeamControl.commands.structs import BeamType, DACCodeRange, OutputMode, Transforms  # noqa: E402
from GlasgowDataIO.IobeamControl.macros import RasterScanCommand  # noqa: E402
from GlasgowDataIO.IobeamControl.macros.vector import VectorScanCommand  # noqa: E402
from GlasgowDataIO.IobeamControl.transfer.abc import Connection, Stream  # noqa: E402

CLOCK_HZ = 48_000_000
CONFIG_PATH = ARGS.json or os.path.join(DEV, "GlasgowDataIO", "Json", "streamData.json")
CONFIG = json.load(open(CONFIG_PATH, encoding="utf-8"))
ACTION = CONFIG["Actions"][0]["streamData"]["actionData"]
TIMING = AdcTiming.from_action(ACTION)
SOURCE_IS_COMPILED = not any(f.endswith(".py") for f in os.listdir(
    os.path.join(DEV, "GlasgowDataIO", "IobeamControl", "applet")))


# ---------------------------------------------------------------- test image
def make_image(n):
    """A 14-bit image with edges, gradients and a unique value at most pixels."""
    y, x = np.mgrid[0:n, 0:n]
    img = (x * 1021 + y * 517 + ((x ^ y) & 1) * 4099 + 100) % 16000 + 200
    return img.astype(np.uint16)


# ------------------------------------------------------------ pad platform
class PadPlatform:
    """Hands the subtarget SimulationPorts so pad-level signals are observable."""
    def add_resources(self, resources):
        self.ports = {"led": io.SimulationPort("o", 1)}
        for resource in resources:
            if resource.name == "data":
                self.ports["data"] = io.SimulationPort("io", 14)
            elif resource.name == "control":
                self.ports["control"] = SimpleNamespace(**{
                    sub.name: io.SimulationPort(sub.ios[0].dir, 1, invert=sub.ios[0].invert)
                    for sub in resource.ios})

    def request(self, name, *, dir):
        return self.ports[name]


# --------------------------------------------------------------- board model
class BoardModel:
    """Pad-level model of the OBI analogue board (see module docstring)."""
    ADC_PIPELINE = 5  # LTC2246: five conversion cycles of latency

    def __init__(self, image, extra_pipeline=0):
        self.image = image
        self.n = image.shape[0]
        self.shift = 14 - int(np.log2(self.n))
        self.pipeline = self.ADC_PIPELINE + extra_pipeline
        self.hist = collections.deque([0] * (self.pipeline + 1), maxlen=self.pipeline + 1)
        self.x_reg = self.y_reg = 0
        self.dac_out = (0, 0)
        self.u6 = 0
        self.adc_out = 0
        self.bus_hold = 0x3fff
        self.prev = collections.defaultdict(int)
        self.contention = 0
        self.conversions = 0
        self.oe_low_ticks = 0

    def analog(self):
        x, y = self.dac_out
        return int(self.image[min(y >> self.shift, self.n - 1)][min(x >> self.shift, self.n - 1)])

    def tick(self, p):
        rise = lambda k: p[k] == 1 and self.prev[k] == 0
        adc_out_before = self.adc_out
        # Edge-triggered parts capture what was present *before* the edge, so
        # every capture below reads state that this tick's other captures have
        # not yet changed (the order below is therefore irrelevant to physics).
        if rise("clk_a"):                       # ADC converts what the DAC held before this edge
            self.conversions += 1
            self.hist.appendleft(self.analog())
            self.adc_out = self.hist[-1]
        if rise("clk_d"):                       # DAC input register takes the X/Y registers as they were
            self.dac_out = (self.x_reg, self.y_reg)
        if rise("le_x"):
            self.x_reg = p["data_o"]
        if rise("le_y"):
            self.y_reg = p["data_o"]
        if rise("le_a"):
            self.u6 = adc_out_before
        self.prev.update(p)
        if p["oe_a"] == 0:                      # active-low /OE: U6 drives the shared bus
            self.oe_low_ticks += 1
            if p["data_oe"]:
                self.contention += 1
            self.bus_hold = self.u6
            return self.u6
        if p["data_oe"]:
            self.bus_hold = p["data_o"]
            return p["data_o"]
        return self.bus_hold


# ------------------------------------------------------------------- bench
class Bench:
    """Runs the real subtarget in the simulator; the host feeds and drains it."""

    def __init__(self, mode, image, timing, board_extra_pipeline=0, ext_switch_delay=8):
        self.mode = mode
        self.tx = bytearray()
        self.rx = bytearray()
        self.cycles = 0
        self.board = None
        self._tx = SimpleNamespace(r_data=Signal(8), r_rdy=Signal(), r_en=Signal())
        self._rx = SimpleNamespace(w_data=Signal(8), w_rdy=Signal(), w_en=Signal())
        kwargs = dict(ports=SimpleNamespace(), out_fifo=self._tx, in_fifo=self._rx,
                      adc_half_period=timing.half_period, adc_settle_cycles=timing.settle_cycles,
                      adc_latch_cycles=timing.latch_cycles,
                      bus_turnaround_cycles=timing.bus_turnaround_cycles,
                      dac_data_setup_cycles=timing.dac_data_setup_cycles,
                      dac_latch_cycles=timing.dac_latch_cycles,
                      ext_switch_delay=ext_switch_delay, transforms=Transforms(False, False, False))
        if mode == "sim":
            dut = IobeamDataSubtarget(loopback=True, sim_image=[int(v) for v in image.flatten()],
                                      sim_image_resolution=image.shape[0], **kwargs)
            self.platform = None
        else:
            dut = IobeamDataSubtarget(pin_config=copy.deepcopy(ACTION["pins"]), **kwargs)
            self.platform = PadPlatform()
            self.board = BoardModel(image, board_extra_pipeline)
        self.sim = Simulator(Fragment.get(dut, self.platform))
        self.sim.add_clock(1 / CLOCK_HZ)
        self.sim.add_testbench(self._bench)
        self.stalls = 0

    async def _bench(self, ctx):
        tick = 0
        while True:
            sending = len(self.tx) > 0 and tick % 7 != 3          # deliberate stalls on the OUT path
            ctx.set(self._tx.r_rdy, sending)
            ctx.set(self._tx.r_data, self.tx[0] if sending else 0)
            rx_ready = tick % 13 != 5                             # ... and on the IN path
            ctx.set(self._rx.w_rdy, rx_ready)
            if self.board is not None:
                c = self.platform.ports["control"]
                d = self.platform.ports["data"]
                pads = dict(le_x=ctx.get(c.dac_x_le_clk.o), le_y=ctx.get(c.dac_y_le_clk.o),
                            le_a=ctx.get(c.adc_le_clk.o), clk_a=ctx.get(c.adc_clk.o),
                            clk_d=ctx.get(c.dac_clk.o), oe_a=ctx.get(c.adc_oe.o),
                            data_o=ctx.get(d.o), data_oe=ctx.get(d.oe))
                ctx.set(d.i, self.board.tick(pads))
            if sending and ctx.get(self._tx.r_en):
                self.tx.pop(0)
            if rx_ready and ctx.get(self._rx.w_en):
                self.rx.append(ctx.get(self._rx.w_data))
            await ctx.tick()
            tick += 1

    def advance(self, cycles):
        self.cycles += cycles
        self.sim.run_until(self.cycles / CLOCK_HZ, run_passive=True)


class BenchStream(Stream):
    STEP = 256
    BUDGET = 3_000_000   # ~5 minutes of simulation; a healthy scan needs far less

    def __init__(self, bench):
        super().__init__(None)
        self.bench = bench

    async def write(self, data):
        self.bench.tx.extend(bytes(data))

    async def flush(self):
        pass

    async def _wait_for(self, condition):
        # Must yield to the event loop between steps: the macros stream their
        # pixel commands from a background sender task that only runs while
        # the reader is awaiting.
        start = self.bench.cycles
        while not condition():
            if self.bench.cycles - start > self.BUDGET:
                raise TimeoutError("gateware produced no response (deadlock?)")
            self.bench.advance(self.STEP)
            await asyncio.sleep(0)

    async def read(self, length):
        await self._wait_for(lambda: len(self.bench.rx) >= length)
        out = bytes(self.bench.rx[:length])
        del self.bench.rx[:length]
        return memoryview(out)

    async def readuntil(self, separator=b"\n", *, flush=True, max_count=False):
        await self._wait_for(lambda: separator in bytes(self.bench.rx))
        i = bytes(self.bench.rx).index(separator) + len(separator)
        out = bytes(self.bench.rx[:i])
        del self.bench.rx[:i]
        return memoryview(out)


class SimConnection(Connection):
    def __init__(self, bench):
        super().__init__(None)
        self.bench = bench

    async def _connect(self):
        self._stream = BenchStream(self.bench)


# ------------------------------------------------------------------ scenarios
def align(flat, expected, min_overlap=0.9):
    """Offset s such that flat[i + s] == expected[i] best, needing >=90% overlap."""
    best = (0, 0.0)
    for shift in range(-40, 41):
        a = flat[max(shift, 0):]
        e = expected[max(-shift, 0):]
        length = min(len(a), len(e))
        if length < min_overlap * len(expected):
            continue
        frac = float(np.mean(a[:length] == e[:length]))
        if frac > best[1] or (frac == best[1] and abs(shift) < abs(best[0])):
            best = (shift, frac)
    return best


ROI_ORIGIN = (40, 72)   # pixel coordinates on the grid, away from every edge


async def raster(conn, grid, roi, dwell):
    code_step = 16384 // grid
    x0, y0 = ROI_ORIGIN
    cmd = RasterScanCommand(cookie=conn.get_cookie(),
                            x_range=DACCodeRange(x0 * code_step, roi, code_step * 256),
                            y_range=DACCodeRange(y0 * code_step, roi, code_step * 256), dwell_time=dwell,
                            output_mode=OutputMode.SixteenBit, beam_type=BeamType.Ion,
                            external_control=True)
    chunks = [np.array(c, dtype=np.uint16) async for c in conn.transfer_multiple(cmd)]
    return np.concatenate(chunks) if chunks else np.zeros(0, np.uint16)


async def vector(conn, points):
    cmd = VectorScanCommand(cookie=conn.get_cookie(), output_mode=OutputMode.SixteenBit,
                            beam_type=BeamType.Ion, external_control=True, iter_points=points)
    chunks = [np.array(c, dtype=np.uint16) async for c in conn.transfer_multiple(cmd)]
    return np.concatenate(chunks) if chunks else np.zeros(0, np.uint16)


EXTRA_PIPELINE = 0   # extra board latency; non-zero only for the negative controls
RESULTS = []


def record(name, ok, detail):
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name:58s} {detail}", flush=True)


def scenario_raster(mode, grid, roi, dwell, extra_pipeline=EXTRA_PIPELINE, expect="exact", label=None):
    image = make_image(grid)
    bench = Bench(mode, image, TIMING, extra_pipeline)
    conn = SimConnection(bench)
    flat = asyncio.run(raster(conn, grid, roi, dwell))
    x0, y0 = ROI_ORIGIN
    expected = image[y0:y0 + roi, x0:x0 + roi].flatten()   # row-major: X is the fast axis
    offset, frac = align(flat, expected)
    unique = int(len(np.unique(flat)))
    name = label or f"raster {mode} {roi}x{roi} ROI dwell={dwell}" + (f" extra_pipeline={extra_pipeline}" if extra_pipeline else "")
    detail = f"samples={len(flat)} unique={unique} offset={offset:+d} match={frac * 100:5.1f}%"
    if bench.board is not None:
        detail += f" contention_ticks={bench.board.contention} cycles={bench.cycles}"
    if expect == "exact":                       # in place, every sample right, not a constant
        ok = offset == 0 and frac == 1.0 and unique > 1
    else:                                       # control: the misalignment must be *detected*
        ok = offset != 0 or frac < 1.0
    record(name, ok, detail)
    return flat, offset, frac


def scenario_vector(mode, grid):
    image = make_image(grid)
    step = 16384 // grid
    rng = np.random.RandomState(7)
    cells = set()
    while len(cells) < 24:
        cells.add((int(rng.randint(0, grid)), int(rng.randint(0, grid))))
    cells = sorted(cells, key=lambda c: (c[0] * 31 + c[1] * 17) % 23)   # scattered, deterministic order
    points = [(cx * step, cy * step, 1) for cx, cy in cells]
    bench = Bench(mode, image, TIMING, EXTRA_PIPELINE)
    conn = SimConnection(bench)
    flat = asyncio.run(vector(conn, points))
    expected = np.array([image[y // step][x // step] for x, y, _ in points], dtype=np.uint16)
    offset, frac = align(flat, expected)
    record(f"vector {mode} {len(points)} distinct points", offset == 0 and frac == 1.0 and len(np.unique(flat)) > 1,
           f"samples={len(flat)} unique={len(np.unique(flat))} offset={offset:+d} match={frac * 100:5.1f}%")


def scenario_dwell_semantics():
    """dwell_time D must produce D+1 ADC conversions per pixel (measured, not assumed)."""
    image = make_image(ARGS.grid)
    counts = {}
    for dwell in (0, 1, 3):
        totals = []
        for roi in (8, 24):
            bench = Bench("physical", image, TIMING)
            asyncio.run(raster(SimConnection(bench), ARGS.grid, roi, dwell))
            totals.append(bench.board.conversions)
        counts[dwell] = (totals[1] - totals[0]) / (24 * 24 - 8 * 8)
    ok = all(abs(counts[d] - (d + 1)) < 0.01 for d in counts)
    record("dwell_time D takes D+1 conversions per pixel", ok,
           " ".join(f"D={d}:{counts[d]:.3f}" for d in counts) +
           f"  (one conversion = {TIMING.period / CLOCK_HZ * 1e9:.0f} ns)")


def main():
    grid, roi = ARGS.grid, ARGS.roi
    print(f"code under test : {DEV}  ({'compiled .pyc only' if SOURCE_IS_COMPILED else 'contains .py sources'})")
    print(f"config          : {CONFIG_PATH}  IsProduction={CONFIG.get('IsProduction')}")
    print(f"ADC timing      : half={TIMING.half_period} settle={TIMING.settle_cycles} latch={TIMING.latch_cycles} "
          f"turnaround={TIMING.bus_turnaround_cycles} dac={TIMING.dac_data_setup_cycles}/{TIMING.dac_latch_cycles} "
          f"(upstream profile: {TIMING.uses_upstream_sequence})")
    print("-" * 110, flush=True)
    scenario_raster("sim", grid, roi, 1)
    scenario_vector("sim", grid)
    scenario_raster("physical", grid, roi, 1)
    scenario_vector("physical", grid)
    if not ARGS.quick:
        scenario_raster("sim", grid, roi, 0)
        scenario_raster("sim", grid, roi, 3)
        scenario_raster("physical", grid, roi, 0)
        scenario_raster("physical", grid, roi, 3)
        scenario_dwell_semantics()
        for extra in (1, 2):
            scenario_raster("physical", grid, roi, 0, extra_pipeline=extra, expect="shifted",
                            label=f"CONTROL: board {extra} conversion(s) slower is detected")
    failed = [r for r in RESULTS if not r[1]]
    print("-" * 110)
    print(f"{len(RESULTS) - len(failed)}/{len(RESULTS)} scenarios passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
