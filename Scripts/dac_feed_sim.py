#!/usr/bin/env python3
"""X-DAC waveform under a slow host link, in the real gateware.

Why this exists: on the VirtualBox install every host flush of the OUT pipe
costs tens of milliseconds (the 2026-09-23 vector scan in GlasgowService.log
averaged ~51 ms per 513-point chunk, while the FPGA needs ~1.1 ms to execute
one). When a scan's commands are paced one flush per small chunk, the FPGA
executes a burst, runs dry, and parks the beam until the next chunk lands. On
a scope the X DAC then shows short fast ramps separated by flat steps instead
of OBI's continuous sawtooth, and the image smears along the fast axis.

This script drives the real host macros through the real gateware (same bench
and pad-level board model as e2e_scan_sim.py) with a stream whose flush()
lets simulated time pass, and records the X DAC register on the board model.
All times are scaled down so it runs in seconds; the ratio
flush_cost / chunk_beam_time is what matters and is taken from the log.

    python dac_feed_sim.py --root <dir containing Development>
"""
import argparse
import asyncio
import os
import sys

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("--root", default=os.path.expanduser("~/IobeamPlatform"))
parser.add_argument("--json")
parser.add_argument("--width", type=int, default=64, help="points per line (X)")
parser.add_argument("--lines", type=int, default=3)
parser.add_argument("--flush-ratio", type=float, default=46.0,
                    help="host flush cost / beam time of one legacy chunk (log: 51 ms / 1.1 ms)")
args = parser.parse_args()

# Reuse the e2e harness (bench, board model, timing) without running its main().
sys.argv = [sys.argv[0], "--root", args.root] + (["--json", args.json] if args.json else [])
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_scan_sim as h  # noqa: E402

np = h.np
DWELL = 1
CYCLES_PER_POINT = (DWELL + 1) * 2 * h.TIMING.half_period
LEGACY_CHUNK_POINTS = max(1, args.width // 4)          # 513 of 2048 points, as on hardware
FLUSH_CYCLES = int(args.flush_ratio * LEGACY_CHUNK_POINTS * CYCLES_PER_POINT)


class SlowFlushStream(h.BenchStream):
    async def flush(self):
        self.bench.advance(FLUSH_CYCLES)
        await asyncio.sleep(0)


class Conn(h.SimConnection):
    async def _connect(self):
        self._stream = SlowFlushStream(self.bench)


def instrument(bench):
    trace = []
    tick = bench.board.tick
    state = {"t": 0, "x": None}

    def wrapped(p):
        out = tick(p)
        state["t"] += 1
        if bench.board.x_reg != state["x"]:
            state["x"] = bench.board.x_reg
            trace.append((state["t"], state["x"]))
        return out
    bench.board.tick = wrapped
    return trace


def points(width, lines, step):
    return [(x * step, 8192 + y * step, DWELL) for y in range(lines) for x in range(width)]


async def run(cmd, bench, latency):
    conn = Conn(bench)
    out = []
    async for chunk in conn.transfer_multiple(cmd, latency=latency):
        out.append(np.asarray(chunk, dtype=np.uint16))
    return out


def analyse(trace, width, step):
    """Per line: time from first to last X step, and the longest flat stretch inside it."""
    xs = [(t, x) for t, x in trace if t > 1]   # t == 1 is the board model's reset value
    lines, cur = [], []
    for t, x in xs:
        if cur and x < cur[-1][1]:            # flyback: a new line starts
            lines.append(cur)
            cur = []
        cur.append((t, x))
    if cur:
        lines.append(cur)
    lines = [ln for ln in lines if len(ln) >= width // 2 and ln[-1][1] >= (width - 1) * step]
    rows = []
    for ln in lines:
        span = ln[-1][0] - ln[0][0]
        gaps = [b[0] - a[0] for a, b in zip(ln, ln[1:])]
        rows.append((span, max(gaps)))
    return rows


def scenario(label, make_cmd, latency):
    image = h.make_image(256)
    bench = h.Bench("physical", image, h.TIMING)
    trace = instrument(bench)
    asyncio.run(run(make_cmd(), bench, latency))
    step = 16384 // 256
    rows = analyse(trace, args.width, step)
    ideal = (args.width - 1) * CYCLES_PER_POINT
    if not rows:
        print(f"{label:<44} no complete line captured")
        return None
    span = np.median([r[0] for r in rows])
    gap = max(r[1] for r in rows)
    worst = max(r[0] for r in rows)
    print(f"{label:<44} line ramp {span / ideal:6.1f}x ideal (worst {worst / ideal:5.1f}x)   "
          f"longest flat step {gap / CYCLES_PER_POINT:7.1f} points   ({len(rows)} lines)")
    return worst / ideal, gap / CYCLES_PER_POINT


def main():
    step = 16384 // 256
    pts = points(args.width, args.lines, step)
    print(f"{args.width} points/line, dwell {DWELL}, point time {CYCLES_PER_POINT} cycles, "
          f"flush cost {FLUSH_CYCLES} cycles ({args.flush_ratio:.0f}x one legacy chunk)")
    print("-" * 100)
    legacy = scenario(
        "vector, streamed points, legacy chunking",
        lambda: h.VectorScanCommand(cookie=123, output_mode=h.OutputMode.SixteenBit,
                                    beam_type=h.BeamType.Ion, external_control=True,
                                    iter_points=iter(pts), drain_floor_pixels=64, max_pipeline=4),
        LEGACY_CHUNK_POINTS * DWELL)
    raster_cmd = lambda: h.RasterScanCommand(
        x_range=h.DACCodeRange(start=0, count=args.width, step=step * 256),
        y_range=h.DACCodeRange(start=8192, count=args.lines, step=step * 256),
        dwell_time=DWELL, cookie=123, output_mode=h.OutputMode.SixteenBit,
        beam_type=h.BeamType.Ion, external_control=True)
    scenario("raster generator, small chunks (legacy)", raster_cmd, LEGACY_CHUNK_POINTS * DWELL)
    raster = scenario(
        "raster generator, chunks sized to the link",
        lambda: h.RasterScanCommand(
            x_range=h.DACCodeRange(start=0, count=args.width, step=step * 256),
            y_range=h.DACCodeRange(start=8192, count=args.lines, step=step * 256),
            dwell_time=DWELL, cookie=123, output_mode=h.OutputMode.SixteenBit,
            beam_type=h.BeamType.Ion, external_control=True),
        int(4 * args.flush_ratio * LEGACY_CHUNK_POINTS * DWELL))
    ok = legacy is not None and raster is not None and raster[0] < 1.5 and raster[1] < 3
    print("-" * 100)
    print("continuous sawtooth reproduced on the raster path" if ok else "NOT continuous")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
