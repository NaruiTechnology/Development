"""Run a small custom-pattern vector scan via REST, or a default sweep.

    python examples/vector_custom.py                  # 4-corner square
    python examples/vector_custom.py --default        # built-in 2048x2048
    python examples/vector_custom.py --pre-process --save-csv
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
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        raise


def _print_result(r: dict) -> bool:
    v = r.get("validation") or {}
    proc = r.get("process_time_s")
    send = r.get("send_time_s")
    proc = f"{proc:.3f}s" if isinstance(proc, (int, float)) else "n/a"
    send = f"{send:.3f}s" if isinstance(send, (int, float)) else "n/a"
    print(f"chunks={r['chunks']} bytes={r['bytes']} "
          f"process={proc} send={send} csv={r.get('csv_path')}")
    for c in v.get("checks", []):
        mark = "PASS" if c["passed"] else "FAIL"
        print(f"  [{mark}] {c['name']}: {c.get('detail')}")
    return bool(v.get("passed"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--default",       action="store_true",
                    help="use the built-in 2048x2048 pattern instead of the 4-corner demo")
    ap.add_argument("--latency-bytes", type=int, default=8196)
    ap.add_argument("--output-mode",   default="SixteenBit",
                    choices=["SixteenBit", "EightBit"])
    ap.add_argument("--pre-process",   action="store_true",
                    help="call _pre_process_chunks before transfer; time it separately")
    ap.add_argument("--save-csv",      action="store_true")
    ap.add_argument("--no-validate",   action="store_true")
    args = ap.parse_args()

    body = {
        "latency_bytes": args.latency_bytes,
        "output_mode":   args.output_mode,
        "pre_process":   args.pre_process,
        "save_csv":      args.save_csv,
        "do_validate":   not args.no_validate,
        "cookie":        123,
    }

    if args.default:
        body["pattern"] = "default"
    else:
        body["pattern"] = "custom"
        body["points"] = [
            [   0,    0, 2],
            [1000,    0, 2],
            [1000, 1000, 2],
            [   0, 1000, 2],
            [   0,    0, 2],
        ]

    result = post("/scan/vector/run", body)
    ok = _print_result(result)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
