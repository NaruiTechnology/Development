#!/usr/bin/env python3
"""Vacuum excursion test: one pump loses vacuum, is isolated, and recovers.

Runs against the SBC vacuum service in board-emulator mode (vacuum
``Enable: true``, scanner ``IsProduction: false``), so every step shows live
on the SBC Vacuum Controller dashboard.

For the selected pump (picked at random from the configured pump list when
no pump name is given; the name is optional):

1. Slowly raise its gauge reading until it crosses its configured value.
2. Check: its isolation valve closes (card slide switch OFF) and its card
   turns red (``border == "error"``).  The other pumps keep running.
   MechanicalVacuumPump (edge case): every other pump stops and every valve
   closes, as at controller initialization.
3. Release the excursion; the running pump works the reading back down.
4. Check: reading <= value, valve open again (switch ON), card green.
   MechanicalVacuumPump: the cascade restarts and the whole system is ready.

Then it waits for the next pump to be selected (Enter = random, q = quit).

Usage (from glasgow_service/):
    python scripts/vacuum_excursion_test.py                    # random configured pump
    python scripts/vacuum_excursion_test.py TurboVacuumPump    # that pump
    python scripts/vacuum_excursion_test.py --once             # one run, no prompt
    python scripts/vacuum_excursion_test.py --local            # in-process emulator,
                                                               # no service needed
Options: --url (default http://127.0.0.1:8766), --token (default
$SBC_VACUUM_TOKEN), --ramp-seconds, --hold-seconds, --recovery-s, --timeout.
Exit code 0 when every check passed.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

MECHANICAL = "MechanicalVacuumPump"
POLL = 0.5                      # wall seconds between status reads

GREEN, RED, DIM, BOLD, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[1m", "\033[0m"
if not sys.stdout.isatty():
    GREEN = RED = DIM = BOLD = RESET = ""


# --------------------------------------------------------------------- client

class ServiceClient:
    """Thin wrapper over the SBC vacuum HTTP API (httpx or FastAPI TestClient)."""

    def __init__(self, http, token: str | None):
        self.http = http
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def _check(self, response):
        if response.status_code >= 400:
            raise RuntimeError(f"{response.request.method} {response.request.url.path}: "
                               f"HTTP {response.status_code} {response.text}")
        return response.json()

    def _send(self, method: str, path: str, **kwargs):
        try:
            response = self.http.request(method, path, **kwargs)
        except Exception as exc:
            # httpx transport errors are not OSError; report them uniformly.
            if type(exc).__module__.startswith("httpx"):
                raise ConnectionError(str(exc)) from None
            raise
        return self._check(response)

    def status(self) -> dict:
        return self._send("GET", "/status")

    def vacuum(self) -> dict:
        return self._send("GET", "/vacuum")

    def resume(self) -> dict:
        return self._send("POST", "/vacuum/resume", headers=self.headers)

    def excursion(self, pump: str, **body) -> dict:
        return self._send("POST", f"/emulator/excursion/{pump}", json=body,
                          headers=self.headers)


class _Response:
    """Minimal response for the stdlib HTTP client (same shape as httpx's)."""

    class _Request:
        def __init__(self, method, path):
            self.method = method
            self.url = type("U", (), {"path": path})()

    def __init__(self, method, path, status, body):
        self.request = self._Request(method, path)
        self.status_code = status
        self.text = body.decode("utf-8", "replace")

    def json(self):
        return json.loads(self.text)


class _StdlibHTTP:
    """Standard-library HTTP client, so the script needs no extra packages."""

    def __init__(self, base_url: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(self, method: str, path: str, json=None, headers=None):
        import json as _json
        import urllib.error
        import urllib.request
        data = None if json is None else _json.dumps(json).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json",
                                              **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return _Response(method, path, resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            return _Response(method, path, exc.code, exc.read())
        except urllib.error.URLError as exc:
            raise ConnectionError(str(exc.reason)) from None


@contextmanager
def remote_client(url: str, token: str | None):
    yield ServiceClient(_StdlibHTTP(url, timeout=10.0), token)


@contextmanager
def local_client(speed: float):
    """In-process service on the board emulator, like scripts/verify-vacuum-emulator.py."""
    root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(root))
    from fastapi.testclient import TestClient
    from glasgow_service.sbc_vacuum_app import create_app
    from glasgow_service.vacuum import load_vacuum_config

    example = root.parent / "GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json"
    payload = json.loads(example.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=False)
    with tempfile.TemporaryDirectory(prefix="vacuum-excursion-") as directory:
        profile = Path(directory) / "vacuum.json"
        profile.write_text(json.dumps(payload))
        os.environ.update(SBC_VACUUM_CONFIG=str(profile), SBC_REQUIRE_FENCING="false",
                          SBC_VACUUM_EMULATOR_SPEED=str(speed))
        os.environ.pop("SBC_VACUUM_TOKEN", None)
        with TestClient(create_app(config_loader=load_vacuum_config)) as http:
            yield ServiceClient(http, None)


# --------------------------------------------------------------------- helpers

def pumps_by_name(state: dict) -> dict[str, dict]:
    return {p["name"]: p for p in state["pumps"]}


def fmt(value) -> str:
    return "—" if value is None else f"{value:.2e}"


def describe(p: dict) -> str:
    colour = {"ready": GREEN + "green", "error": RED + "red", "waiting": RED + "waiting",
              "off": DIM + "off"}.get(p["border"], p["border"])
    valve = p.get("valve") or "valve"
    return (f"{p['name']:<22} power={'on ' if p['power'] else 'off'} "
            f"{valve}={'OPEN  ' if p.get('valve_open') else 'CLOSED'} "
            f"card={colour}{RESET} reading={fmt(p['value'])} / {fmt(p['threshold'])}")


class Checks:
    def __init__(self):
        self.results: list[tuple[str, bool]] = []

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        self.results.append((label, ok))
        mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
        print(f"   [{mark}] {label}" + (f"  {DIM}({detail}){RESET}" if detail and not ok else ""))
        return ok

    @property
    def passed(self) -> bool:
        return all(ok for _, ok in self.results)


def wait_for(client: ServiceClient, predicate, timeout: float, *, show: str | None = None):
    """Poll /vacuum until ``predicate(state)``; returns the state or None."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        state = client.vacuum()
        if show:
            line = describe(pumps_by_name(state)[show])
            if line != last:
                print(f"   {DIM}{line}{RESET}")
                last = line
        if predicate(state):
            return state
        time.sleep(POLL)
    return None


def pick_pump(client: ServiceClient, requested: str | None) -> str:
    """The requested pump, or one picked at random from the configured list."""
    names = [p["name"] for p in client.vacuum()["pumps"]]       # VacuumPumps, in order
    if requested:
        match = next((n for n in names if n.lower() == requested.lower()), None)
        if match is None:
            raise SystemExit(f"unknown pump {requested!r}; configured: {', '.join(names)}")
        return match
    return random.choice(names)


def diagnose(state: dict, pump: str) -> None:
    """Explain why ``pump`` is not running/green."""
    print(f"   {BOLD}Current state:{RESET}")
    for q in state["pumps"]:
        print(f"   {describe(q)}")
    if not state.get("running"):
        print("   -> the vacuum controller is not running.")
    if state.get("cascade_stopped"):
        print("   -> the cascade is stopped; press Resume on the dashboard.")
    for alarm in state.get("alarms") or []:
        print(f"   -> alarm: {alarm}")
    if state.get("last_error"):
        print(f"   -> controller error: {state['last_error']}")
    p = pumps_by_name(state)[pump]
    if p["power"] and p["border"] == "waiting":
        print(f"   -> {pump} is running but not ready yet (reading {fmt(p['value'])}, "
              f"value {fmt(p['threshold'])}); try a longer --timeout.")
    elif not p["power"]:
        print(f"   -> {pump} is not started: the pumps before it in the cascade are not all ready.")


def require_valve_support(client: ServiceClient) -> None:
    """Stop early when the service predates controller-managed valves."""
    pumps = client.vacuum()["pumps"]
    if any("valve_open" not in p for p in pumps):
        raise SystemExit(
            "The vacuum service does not report isolation valves (no 'valve_open' in GET /vacuum),\n"
            "so it is running code from before the valve patch. Apply\n"
            "vacuum-valves-excursion-test.patch, then restart the service:\n"
            "    systemctl --user restart sbc-vacuum.service")
    if not any(p.get("valve") for p in pumps):
        raise SystemExit(
            "No pump has an isolation valve configured: add the SBC.Valves section to the\n"
            "vacuum config the service loads, then restart the service.")


def wait_until_green(client: ServiceClient, pump: str, timeout: float) -> dict | None:
    """Wait for ``pump`` to run with its valve open and its card green.

    Shows progress, and resumes a stopped cascade once (emulator only).
    """
    deadline = time.monotonic() + timeout
    resumed = False
    last = None
    while time.monotonic() < deadline:
        state = client.vacuum()
        p = pumps_by_name(state)[pump]
        if p["power"] and p["border"] == "ready" and p.get("valve_open") is True:
            return state
        if state.get("cascade_stopped") and state.get("running") and not resumed:
            print("   cascade is stopped; resuming it (emulator) ...")
            client.resume()
            resumed = True
        line = describe(p)
        if line != last:
            print(f"   {DIM}{line}{RESET}")
            last = line
        time.sleep(POLL)
    return None


# --------------------------------------------------------------------- one run

def run_excursion(client: ServiceClient, pump: str, args) -> bool:
    checks = Checks()
    mechanical = pump == MECHANICAL
    print(f"\n{BOLD}=== Vacuum excursion test: {pump}{' (backing pump: restart edge case)' if mechanical else ''} ==={RESET}")

    # 0. The pump must be running and green before the test starts.
    print(" 0. waiting until it is running, valve open, card green ...")
    state = wait_until_green(client, pump, args.timeout)
    if not checks.check(f"{pump} running, valve open, card green", state is not None):
        diagnose(client.vacuum(), pump)
        return False
    target = pumps_by_name(state)[pump]
    threshold = target["threshold"]
    others_running = [p["name"] for p in state["pumps"] if p["name"] != pump and p["power"]]
    for p in state["pumps"]:
        print(f"   {describe(p)}")

    try:
        # 1. Slow rise until the reading crosses the configured value.
        print(f" 1. raising the {pump} gauge reading over ~{args.ramp_seconds:.0f} s ...")
        start_level, end_level = threshold * 0.02, threshold * 1.10
        started = time.monotonic()
        crossed = None
        last_line = None
        while time.monotonic() - started < args.ramp_seconds * 3:
            fraction = min(1.0, (time.monotonic() - started) / args.ramp_seconds)
            level = start_level * (end_level / start_level) ** fraction
            client.excursion(pump, mbar=level)
            time.sleep(POLL)
            state = client.vacuum()
            p = pumps_by_name(state)[pump]
            pct = 100.0 * (p["value"] or 0.0) / threshold
            line = (f"   reading {fmt(p['value'])} / {fmt(threshold)}  ({pct:5.1f} %)  "
                    f"valve {'OPEN' if p.get('valve_open') else 'CLOSED'}  card {p['border']}")
            if line != last_line:          # the service updates once a second
                print(line)
                last_line = line
            if p["value"] is not None and p["value"] > threshold:
                crossed = state
                break
        if not checks.check("reading crossed the configured value", crossed is not None):
            return False

        # 2. Isolation: valve closed (switch off), card red.
        print(" 2. checking isolation ...")
        if mechanical:
            isolated = wait_for(client, lambda s: all(
                not p.get("valve_open") for p in s["pumps"]) and all(
                not p["power"] for p in s["pumps"] if p["name"] != pump)
                and pumps_by_name(s)[pump]["border"] == "error", 10.0)
        else:
            isolated = wait_for(client, lambda s: not pumps_by_name(s)[pump].get("valve_open")
                                and pumps_by_name(s)[pump]["border"] == "error", 10.0)
        state = isolated or client.vacuum()
        p = pumps_by_name(state)[pump]
        checks.check(f"{p.get('valve') or 'isolation valve'} closed (slide switch OFF)",
                     not p.get("valve_open"))
        checks.check("card turned red", p["border"] == "error", f"border={p['border']}")
        checks.check(f"{pump} keeps running to recover", p["power"] is True)
        if mechanical:
            others = [q for q in state["pumps"] if q["name"] != pump]
            checks.check("every other pump stopped (restart, as at initialization)",
                         all(not q["power"] for q in others),
                         ", ".join(q["name"] for q in others if q["power"]))
            checks.check("every isolation valve closed",
                         all(not q.get("valve_open") for q in state["pumps"]),
                         ", ".join(q["name"] for q in state["pumps"] if q.get("valve_open")))
        else:
            still = [n for n in others_running if pumps_by_name(state)[n]["power"]]
            checks.check("the other pumps keep running", still == others_running,
                         f"stopped: {sorted(set(others_running) - set(still))}")
        checks.check("high voltage blocked (system not ready)", not state["isVacuumSystemReady"])
        for q in state["pumps"]:
            print(f"   {describe(q)}")
        if args.hold_seconds > 0:
            print(f"   holding the excursion {args.hold_seconds:.0f} s (watch the dashboard) ...")
            time.sleep(args.hold_seconds)

        # 3. Release: the running pump works the reading back down.
        print(" 3. releasing; the pump works the reading back down ...")
        client.excursion(pump, release=True, recovery_s=args.recovery_s)
        recovered = wait_for(client, lambda s: pumps_by_name(s)[pump]["border"] == "ready"
                             and pumps_by_name(s)[pump].get("valve_open") is True,
                             args.timeout, show=pump)

        # 4. Green again.
        state = recovered or client.vacuum()
        p = pumps_by_name(state)[pump]
        checks.check("reading back at or below the configured value",
                     p["value"] is not None and p["value"] <= threshold,
                     f"{fmt(p['value'])} > {fmt(threshold)}")
        checks.check(f"{p.get('valve') or 'isolation valve'} open again (slide switch ON)",
                     p.get("valve_open") is True)
        checks.check("card green again", p["border"] == "ready", f"border={p['border']}")
        if mechanical:
            print("   waiting for the cascade to restart ...")
            restarted = wait_for(client, lambda s: s["isVacuumSystemReady"], args.timeout)
            checks.check("cascade restarted: every pump green, valves open",
                         restarted is not None)
            state = restarted or client.vacuum()
        else:
            state = wait_for(client, lambda s: s["isVacuumSystemReady"], 15.0) or client.vacuum()
            checks.check("whole system ready again", state["isVacuumSystemReady"])
        for q in state["pumps"]:
            print(f"   {describe(q)}")
    finally:
        try:
            client.excursion(pump, mbar=0, release=True)     # never leave one behind
        except Exception as exc:   # pragma: no cover - best effort
            if "HTTP 401" not in str(exc):
                print(f"   {RED}warning: could not clear the excursion: {exc}{RESET}")

    verdict = f"{GREEN}PASSED{RESET}" if checks.passed else f"{RED}FAILED{RESET}"
    print(f"{BOLD}=== {pump}: {verdict}{BOLD} "
          f"({sum(ok for _, ok in checks.results)}/{len(checks.results)} checks) ==={RESET}")
    return checks.passed


# --------------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("pump", nargs="?",
                        help="optional pump name (default: a random pump from the configuration)")
    parser.add_argument("--url", default=os.environ.get("SBC_VACUUM_URL", "http://127.0.0.1:8766"))
    parser.add_argument("--token", default=os.environ.get("SBC_VACUUM_TOKEN"))
    parser.add_argument("--local", action="store_true",
                        help="run an in-process service on the emulator instead of --url")
    parser.add_argument("--speed", type=float, default=20.0, help="--local emulator speed")
    parser.add_argument("--once", action="store_true", help="one run, no next-pump prompt")
    parser.add_argument("--ramp-seconds", type=float, default=20.0,
                        help="wall time for the slow rise (default 20)")
    parser.add_argument("--hold-seconds", type=float, default=3.0,
                        help="keep the excursion after isolation (default 3)")
    parser.add_argument("--recovery-s", type=float, default=120.0,
                        help="emulated recovery time constant of the pump (default 120)")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="max wall seconds to wait for ready/recovery (default 180)")
    args = parser.parse_args()

    context = local_client(args.speed) if args.local else remote_client(args.url, args.token)
    all_passed = True
    with context as client:
        mode = client.status().get("mode")
        if mode != "board-emulator":
            print(f"The vacuum service is in mode {mode!r}. This test needs the board emulator: "
                  "vacuum \"Enable\": true and scanner \"IsProduction\": false.", file=sys.stderr)
            return 2
        require_valve_support(client)
        requested = args.pump
        interactive = sys.stdin.isatty() and not args.once
        while True:
            pump = pick_pump(client, requested)
            all_passed = run_excursion(client, pump, args) and all_passed
            if not interactive:
                break
            names = [p["name"] for p in client.vacuum()["pumps"]]
            answer = input(f"\nNext pump [{' / '.join(names)}; Enter = random; q = quit]: ").strip()
            if answer.lower() in {"q", "quit", "exit"}:
                break
            requested = answer or None
    return 0 if all_passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted")
        sys.exit(130)
    except RuntimeError as exc:
        hint = ""
        if "HTTP 401" in str(exc):
            hint = ("\nThe service needs its bearer token: pass --token or set SBC_VACUUM_TOKEN "
                    "to the service's value.")
        print(f"error: {exc}{hint}", file=sys.stderr)
        sys.exit(2)
    except OSError as exc:
        print(f"error: cannot reach the vacuum service ({exc}). Is sbc-vacuum.service running? "
              "Check --url.", file=sys.stderr)
        sys.exit(2)
