#!/usr/bin/env python3
"""Acquire or release the local SBC vacuum exposure/maintenance lease."""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from secretstore import get


def persist_maintenance_lock(active: bool, owner: str, lease_seconds: float) -> None:
    if not owner.startswith("maintenance-"):
        return
    path = Path(os.environ.get("SBC_EXPOSURE_LOCK_STATE", "~/.local/state/sbc-vacuum-exposure-lock.json")).expanduser()
    if active:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        try:
            temporary.write_text(json.dumps({"owner": owner, "expires_at": time.time() + lease_seconds}), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        return
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if saved.get("owner") == owner:
            path.unlink()
    except (OSError, ValueError, TypeError, AttributeError):
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("active", choices=("true", "false"))
    parser.add_argument("owner")
    parser.add_argument("--lease-seconds", type=float, default=30)
    args = parser.parse_args()
    body = {"active": args.active == "true", "owner": args.owner}
    if args.active == "true":
        body["lease_seconds"] = args.lease_seconds
    headers = {"Content-Type": "application/json"}
    token = get("SBC_VACUUM_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request("http://127.0.0.1:8766/vacuum/exposure-lock", data=json.dumps(body).encode(),
                      headers=headers, method="POST")
    try:
        with urlopen(request, timeout=4) as response:
            if response.status < 200 or response.status >= 300:
                print(f"SBC refused the exposure lock (HTTP {response.status}).", file=sys.stderr)
                return 1
    except HTTPError as error:
        print(f"SBC refused the exposure lock (HTTP {error.code}).", file=sys.stderr)
        return 1
    except (URLError, TimeoutError, OSError) as error:
        print(f"SBC exposure lock unavailable: {error}", file=sys.stderr)
        return 1
    persist_maintenance_lock(body["active"], args.owner, args.lease_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
