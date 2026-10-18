"""End-to-end: host-side activity never disturbs the SBC vacuum controller.

Starts a real SBC process (simulated hardware) and a real web backend pointed
straight at it, then does what operators do on the host -- save the scan
configuration (which runs the host's service-reset hook), switch the host's
vacuum setting off and on, stop and restart the backend -- and checks that
the SBC process, its uptime, its pumps and its own profile are untouched
throughout.  No executor runs at all: the host reads the SBC directly.

Skipped when Node.js or the backend's node_modules are not installed.
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
BACKEND = ROOT / "ionbeam-web" / "backend"
PROFILE = ROOT / "GlasgowDataIO" / "Json" / "vacuumSystem.json"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not (BACKEND / "node_modules" / "tsx").exists(),
    reason="needs Node.js and ionbeam-web/backend/node_modules")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url, timeout=2.0):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.status, json.loads(response.read())


def post_json(url, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.status, json.loads(response.read())


def wait_for(url, process, seconds=30.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"process exited early ({process.returncode})")
        try:
            return get_json(url)
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.1)
    raise AssertionError(f"{url} did not come up")


def stop(process):
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


@pytest.fixture
def stack(tmp_path):
    profile = tmp_path / "vacuumSystem.json"
    payload = json.loads(PROFILE.read_text())
    payload.update(Enable=True, Simulate=True)
    profile.write_text(json.dumps(payload, indent=4))
    stream = tmp_path / "streamData.json"
    stream.write_text(json.dumps({"IsProduction": True, "Actions": []}))
    resets = tmp_path / "resets.txt"
    reset_hook = tmp_path / "reset.sh"
    reset_hook.write_text(f"#!/bin/sh\necho reset >> '{resets}'\n")
    reset_hook.chmod(0o755)

    sbc_port, web_port = free_port(), free_port()
    sbc_log = tmp_path / "sbc.log"
    sbc = subprocess.Popen(
        [sys.executable, "-m", "glasgow_service.sbc_vacuum_app"],
        cwd=ROOT / "glasgow_service",
        env={**os.environ, "PYTHONPATH": f"{ROOT}:{ROOT / 'glasgow_service'}",
             "SBC_VACUUM_CONFIG": str(profile), "SBC_VACUUM_HOST": "127.0.0.1",
             "SBC_VACUUM_PORT": str(sbc_port), "SBC_REQUIRE_FENCING": "false",
             "SBC_VACUUM_TOKEN": "sbc-secret"},
        stdout=sbc_log.open("w"), stderr=subprocess.STDOUT)

    def start_backend():
        return subprocess.Popen(
            ["node", "--import", "tsx", "src/server.ts"], cwd=BACKEND,
            env={**os.environ, "PORT": str(web_port), "MOCK": "true",
                 "GLASGOW_CONFIG": str(stream), "SBC_VACUUM_CONFIG": str(profile),
                 "VACUUM_CONTROLLER_URL": f"http://127.0.0.1:{sbc_port}",
                 "SBC_VACUUM_TOKEN": "sbc-secret",
                 "GLASGOW_RESTART_CMD": str(reset_hook),
                 "IONBEAM_BACKEND_RESTART_AFTER_GLASGOW": "false",
                 "IOBEAM_ADMIN_CONFIG": str(tmp_path / "admin.json"),
                 "IOBEAM_SECRETS_FILE": str(tmp_path / "secrets.env"),
                 "IOBEAM_ADMIN_DB_CONFIG": str(tmp_path / "missing-db.json"),
                 "IOBEAM_ADMIN_DB_HOST": "127.0.0.1", "IOBEAM_ADMIN_DB_PORT": "1",
                 "IOBEAM_OPERATION_DB_HOST": "127.0.0.1", "IOBEAM_OPERATION_DB_PORT": "1"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    backend = start_backend()
    state = {"sbc": sbc, "backend": backend, "start_backend": start_backend,
             "sbc_url": f"http://127.0.0.1:{sbc_port}",
             "web_url": f"http://127.0.0.1:{web_port}",
             "profile": profile, "resets": resets, "sbc_log": sbc_log}
    try:
        yield state
    finally:
        stop(state["backend"])
        stop(sbc)


def sbc_snapshot(state):
    _, status = get_json(f"{state['sbc_url']}/vacuum")
    pumps = {pump["name"]: pump["power"] for pump in status["pumps"]}
    return status["running"], status["runtime_seconds"], pumps


def test_host_activity_never_disturbs_the_sbc(stack):
    sbc = stack["sbc"]
    wait_for(f"{stack['sbc_url']}/health/live", sbc)
    running, runtime, pumps = sbc_snapshot(stack)
    assert running and pumps["MechanicalVacuumPump"] is True
    profile_bytes = stack["profile"].read_bytes()

    def assert_sbc_undisturbed(previous_runtime):
        assert sbc.poll() is None, "the SBC process stopped"
        now_running, now_runtime, now_pumps = sbc_snapshot(stack)
        assert now_running
        assert now_runtime > previous_runtime, "the SBC controller restarted"
        assert now_pumps["MechanicalVacuumPump"] is True
        assert stack["profile"].read_bytes() == profile_bytes
        return now_runtime

    # The host reads the SBC directly.
    status, via_host = wait_for(f"{stack['web_url']}/api/vacuum", stack["backend"])
    assert status == 200 and via_host["running"] is True
    runtime = assert_sbc_undisturbed(runtime)

    # Save the scan configuration twice, switching the host's vacuum setting
    # off and on: the host's reset hook runs each time, the SBC is untouched.
    config_url = f"{stack['web_url']}/api/admin/config"
    for enabled in (False, True):
        code, body = post_json(config_url, {
            "data": {"IsProduction": True, "Actions": []}, "vacuum_enabled": enabled})
        assert code == 200 and body["restart"]["ok"], body
        if not enabled:
            with pytest.raises(urllib.error.HTTPError) as hidden:
                get_json(f"{stack['web_url']}/api/vacuum")
            assert hidden.value.code == 404           # host hides vacuum ...
        runtime = assert_sbc_undisturbed(runtime)       # ... the SBC carries on
    assert stack["resets"].read_text().count("reset") == 2

    # Stop the whole host backend, then bring it back.
    stop(stack["backend"])
    time.sleep(1.0)
    runtime = assert_sbc_undisturbed(runtime)
    stack["backend"] = stack["start_backend"]()
    status, via_host = wait_for(f"{stack['web_url']}/api/vacuum", stack["backend"])
    assert status == 200 and via_host["running"] is True
    assert_sbc_undisturbed(runtime)

    # One SBC controller start for the whole session.
    assert stack["sbc_log"].read_text().count("controller started") == 1
