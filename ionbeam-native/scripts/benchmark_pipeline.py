#!/usr/bin/env python3
"""Frame-to-frame benchmark: web-service connection model vs desktop session.

Runs the real glasgow_service scan code (macros, GlasgowConnection/Stream,
DeviceService, ADC presence monitor, validation) against the byte-level
Glasgow emulator, so the *host-side* cost of each model is measured; beam
time is emulated at the configured ADC rate (8 MHz conversions).

* ``web``     - stock DeviceService: GlasgowConnection hard-closes after
                every transfer; the next scan reconnects. The emulator cannot
                reproduce USB bitstream download + launcher sleeps, so each
                reconnect is charged ``--web-connect-cost`` seconds (default
                5.15 s = 0.45 s applet build/plan measured on this code +
                3.0 + 1.2 + 0.5 s of fixed launcher sleeps; the bitstream
                re-download itself is NOT included, so this is a lower bound).
                ``--dump`` also enables DumpData (CSV+PNG rendered on the scan
                loop, as the service does).
* ``desktop`` - DesktopDeviceService: one session, soft reset between frames,
                DumpData (if enabled) rendered out of process.

Numbers from this script are emulator numbers. The runbook describes how to
take the same measurement on the instrument (the desktop app logs a
``[perf]`` line per frame).

Usage:  python scripts/benchmark_pipeline.py [--frames 5] [--resolution 512] [--dwell 1] [--dump]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from ionbeam_native.paths import ensure_import_paths, stream_config_path  # noqa: E402

ensure_import_paths()

import logging  # noqa: E402

logging.disable(logging.WARNING)


def build_config(tmp: Path, dump: bool) -> str:
    cfg = json.load(open(stream_config_path()))
    cfg["IsProduction"] = True
    cfg["DumpData"] = bool(dump)
    path = tmp / "stream.json"
    path.write_text(json.dumps(cfg))
    return str(path)


async def run_frames(svc, req, frames: int) -> list:
    walls = []
    for i in range(frames):
        req = req.model_copy(update={"cookie": (req.cookie + 2) & 0xFFFF})
        t = time.perf_counter()
        n = 0
        async for chunk in svc.raster_scan(req, native_samples=True):
            n += len(chunk)
        walls.append(time.perf_counter() - t)
        assert n == req.resolution ** 2, (n, req.resolution)
    return walls


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames", type=int, default=5)
    ap.add_argument("--resolution", type=int, default=512)
    ap.add_argument("--dwell", type=int, default=1)
    ap.add_argument("--web-connect-cost", type=float, default=5.15)
    ap.add_argument("--dump", action="store_true", help="enable DumpData (CSV+PNG per scan)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="ionbeam-bench-"))
    os.chdir(tmp)                                   # service logs go here
    os.environ["HOME"] = str(tmp)                   # DumpData writes ~/Output
    os.environ["IONBEAM_DEVICE_LOCK"] = str(tmp / "device.lock")
    config = build_config(tmp, args.dump)

    import glasgow_service.service as service_mod
    from glasgow_service.models import RasterRequest
    from GlasgowDataIO.IobeamControl.transfer.glasgowStream import GlasgowConnection
    from ionbeam_native.engine.artifacts import ArtifactWorker
    from ionbeam_native.engine.persistent import PersistentGlasgowConnection
    from ionbeam_native.engine.service import DesktopDeviceService
    from ionbeam_native.testing.fake_glasgow import FakeStreamLauncherMixin

    class WebModelConnection(FakeStreamLauncherMixin, GlasgowConnection):
        connect_cost_s = args.web_connect_cost

    class DesktopFakeConnection(FakeStreamLauncherMixin, PersistentGlasgowConnection):
        pass

    class DesktopFakeService(DesktopDeviceService):
        connection_cls = DesktopFakeConnection

    req = RasterRequest(resolution=args.resolution, dwell=args.dwell, latency_bytes=65536, cookie=100,
                        output_mode="SixteenBit", adc_valid=True, do_validate=True)
    beam_s = args.resolution ** 2 * (args.dwell + 1) / 8e6

    async def web():
        service_mod.GlasgowConnection = WebModelConnection
        try:
            svc = service_mod.DeviceService(config)
            walls = await run_frames(svc, req, args.frames)
            await svc.stop()
            return walls
        finally:
            service_mod.GlasgowConnection = GlasgowConnection

    worker = ArtifactWorker(config) if args.dump else None

    async def desktop():
        svc = DesktopFakeService(config, dump_sink=(worker.dump if worker else None))
        await svc.open_session()          # the app opens the session at start-up
        walls = await run_frames(svc, req, args.frames)
        await svc.stop()
        return walls

    results = {}
    for name, fn in (("web", web), ("desktop", desktop)):
        walls = asyncio.run(fn())
        results[name] = {
            "frame_ms": [round(w * 1e3, 1) for w in walls],
            "median_ms": round(statistics.median(walls) * 1e3, 1),
            "fps": round(1 / statistics.median(walls), 2),
            "duty": round(beam_s / statistics.median(walls), 3),
        }
    if worker:
        worker.shutdown()
    results["beam_ms"] = round(beam_s * 1e3, 2)
    results["speedup_median"] = round(results["web"]["median_ms"] / results["desktop"]["median_ms"], 1)
    results["params"] = vars(args)

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"raster {args.resolution}^2 dwell={args.dwell}  beam time/frame = {results['beam_ms']} ms"
              f"  DumpData={'on' if args.dump else 'off'}  frames={args.frames}")
        for name in ("web", "desktop"):
            r = results[name]
            print(f"  {name:8s} median {r['median_ms']:9.1f} ms/frame  {r['fps']:7.2f} fps  duty {r['duty']:.3f}"
                  f"   frames {r['frame_ms']}")
        print(f"  speed-up (median frame time): {results['speedup_median']}x")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
