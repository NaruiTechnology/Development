#!/usr/bin/env python3
"""Exercise the real SBC HTTP app on an isolated emulator, never live hardware.

Run with the test environment's Python, for example:
    PYTHONPATH=. python scripts/verify-vacuum-emulator.py --seconds 200 --cycles 3
The temporary profile forces IsProduction=false; no service or saved settings
are changed. Install the service's test/httpx dependencies before running.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import tempfile
import time

from fastapi.testclient import TestClient

from glasgow_service.sbc_vacuum_app import create_app
from glasgow_service.vacuum import load_vacuum_config


def verify(seconds: float, cycles: int, speed: float) -> list[dict]:
    example = Path(__file__).resolve().parents[2] / "GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json"
    payload = json.loads(example.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=False)
    results = []
    with tempfile.TemporaryDirectory(prefix="vacuum-http-soak-") as directory:
        profile = Path(directory) / "vacuum.json"
        profile.write_text(json.dumps(payload))
        os.environ.update(SBC_VACUUM_CONFIG=str(profile), SBC_REQUIRE_FENCING="false",
                          SBC_VACUUM_EMULATOR_SPEED=str(speed), SBC_VACUUM_TOKEN="soak-only-token")
        for cycle in range(1, cycles + 1):
            started = time.monotonic()
            ready_at = None
            polls = 0
            previous_update = None
            previous_poll = None
            max_gap = 0.0
            max_request = 0.0
            next_progress = started + 30
            with TestClient(create_app(config_loader=load_vacuum_config)) as client:
                service = client.get("/status").json()
                assert service["mode"] == "board-emulator", service
                assert service["is_production"] is False, service
                while time.monotonic() - started < seconds:
                    request_start = time.monotonic()
                    inspection = client.get("/emulator")
                    state = client.get("/vacuum")
                    max_request = max(max_request, time.monotonic() - request_start)
                    assert inspection.status_code == 200, inspection.text
                    assert state.status_code == 200, state.text
                    state = state.json()
                    assert not state["last_error"], state
                    assert not state["cascade_stopped"], state
                    assert not state["alarms"], state
                    assert state["board"]["keepalive_tripped"] is False, state
                    now = time.monotonic()
                    if state["updated_at"] and state["updated_at"] != previous_update:
                        if previous_poll is not None:
                            max_gap = max(max_gap, now - previous_poll)
                        previous_poll = now
                        previous_update = state["updated_at"]
                        polls += 1
                    if state["isVacuumSystemReady"] and ready_at is None:
                        ready_at = now - started
                    if now >= next_progress:
                        print(json.dumps({"cycle": cycle, "elapsed_seconds": round(now - started, 1),
                                          "polls": polls, "ready": state["isVacuumSystemReady"]}), flush=True)
                        next_progress = now + 30
                    time.sleep(0.1)
                assert ready_at is not None, "emulator never completed pump-down"
                assert state["connected"] and state["isVacuumSystemReady"], state
                # Match executor release followed by service shutdown. The
                # lifespan closes the same board again on context exit.
                response = client.post("/vacuum/release", headers={"Authorization": "Bearer soak-only-token"})
                assert response.status_code == 200, response.text
            result = {"cycle": cycle, "duration_seconds": round(time.monotonic() - started, 3),
                      "speed": speed, "polls_observed": polls, "ready_at_seconds": round(ready_at, 3),
                      "max_observed_poll_gap_seconds": round(max_gap, 3),
                      "max_http_request_pair_seconds": round(max_request, 3), "faults": 0}
            results.append(result)
            print(json.dumps(result), flush=True)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=200, help="wall seconds per service lifecycle")
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--speed", type=float, default=20)
    parser.add_argument("--output", type=Path)
    arguments = parser.parse_args()
    if arguments.seconds <= 0 or arguments.cycles < 1 or arguments.speed <= 0:
        parser.error("seconds, cycles and speed must be positive")
    results = verify(arguments.seconds, arguments.cycles, arguments.speed)
    if arguments.output:
        arguments.output.write_text(json.dumps(results, indent=2) + "\n")
