"""Run one or more raster scans with custom parameters via REST.

Default mode runs a single scan with the parameters at the top of main().
Pass --sweep to run dwell=1..4 in sequence, validating each — handy as a
regression check after firmware or config changes.

    python examples/raster_custom.py
    python examples/raster_custom.py --sweep --save-csv
"""
import argparse
import json
import os
import sys
import urllib.request
import urllib.error


BASE  = os.environ.get("GLASGOW_BASE",  "http://127.0.0.1:8765")
TOKEN = os.environ.get("GLASGOW_TOKEN")


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        raise


def _print_result(r: dict, label: str = "") -> bool:
    """Pretty-print a ScanResult; return True if validation passed."""
    prefix = f"[{label}] " if label else ""
    v = r.get("validation") or {}
    passed = v.get("passed")
    send_s = r.get("send_time_s")
    send_s = f"{send_s:.3f}s" if isinstance(send_s, (int, float)) else "n/a"
    print(f"{prefix}chunks={r['chunks']} expected={r.get('expected_chunks')} "
          f"pixels_per_chunk={r.get('pixels_per_chunk')} send={send_s} "
          f"csv={r.get('csv_path')}")
    for c in v.get("checks", []):
        mark = "PASS" if c["passed"] else "FAIL"
        print(f"  [{mark}] {c['name']}: {c.get('detail')}")
    return bool(passed)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true",
                    help="run dwell=1..4 in sequence at the same resolution")
    ap.add_argument("--resolution",    type=int, default=512)
    ap.add_argument("--dwell",         type=int, default=2)
    ap.add_argument("--latency-bytes", type=int, default=16384)
    ap.add_argument("--frame-blank",   action="store_true")
    ap.add_argument("--save-csv",      action="store_true",
                    help="write the raster CSV (~/Output by default)")
    ap.add_argument("--no-validate",   action="store_true")
    args = ap.parse_args()

    base = {
        "resolution":    args.resolution,
        "latency_bytes": args.latency_bytes,
        "frame_blank":   args.frame_blank,
        "save_csv":      args.save_csv,
        "do_validate":   not args.no_validate,
        "cookie":        123,
    }

    if not args.sweep:
        result = post("/scan/raster/run", {**base, "dwell": args.dwell})
        ok = _print_result(result)
        sys.exit(0 if ok else 1)

    all_passed = True
    for dwell in (1, 2, 3, 4):
        result = post("/scan/raster/run", {**base, "dwell": dwell})
        ok = _print_result(result, label=f"dwell={dwell}")
        all_passed = all_passed and ok
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
