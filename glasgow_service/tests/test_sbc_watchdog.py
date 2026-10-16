"""systemd readiness and watchdog for the SBC vacuum service.

The service reports READY=1 once started and pings WATCHDOG=1 only while
its control loop is alive, so systemd (Type=notify, WatchdogSec=) restarts a
hung controller.  A real AF_UNIX datagram socket stands in for systemd.
"""
import asyncio
import json
import os
import socket
import time
from pathlib import Path

import pytest

pytest.importorskip("httpx")
from fastapi.testclient import TestClient

from glasgow_service import sd_notify
from glasgow_service.sbc_vacuum_app import create_app
from glasgow_service.vacuum import VacuumController, load_vacuum_config

CONFIG_PATH = Path(__file__).parents[2] / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


@pytest.fixture
def systemd_socket(tmp_path, monkeypatch):
    path = str(tmp_path / "notify.sock")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    sock.bind(path)
    sock.setblocking(False)
    monkeypatch.setenv("NOTIFY_SOCKET", path)
    yield sock
    sock.close()


def drain(sock) -> list[str]:
    messages = []
    while True:
        try:
            messages.append(sock.recv(4096).decode())
        except BlockingIOError:
            return messages


def simulation_profile(tmp_path, monkeypatch):
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=True, IsProduction=False, Simulate=True)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    monkeypatch.setenv("SBC_REQUIRE_FENCING", "false")


def test_notify_is_a_no_op_outside_systemd(monkeypatch):
    monkeypatch.delenv("NOTIFY_SOCKET", raising=False)
    assert sd_notify.notify("READY=1") is False


def test_watchdog_interval_is_half_of_watchdog_usec(monkeypatch):
    monkeypatch.delenv("WATCHDOG_USEC", raising=False)
    assert sd_notify.watchdog_interval() is None
    monkeypatch.setenv("WATCHDOG_USEC", "20000000")
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid()))
    assert sd_notify.watchdog_interval() == 10.0
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid() + 1))
    assert sd_notify.watchdog_interval() is None


def test_service_reports_ready_and_pings_while_the_loop_runs(tmp_path, monkeypatch, systemd_socket):
    simulation_profile(tmp_path, monkeypatch)
    monkeypatch.setenv("WATCHDOG_USEC", "200000")          # ping every 0.1 s
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid()))
    with TestClient(create_app(config_loader=load_vacuum_config)) as client:
        assert client.get("/health/live").status_code == 200
        time.sleep(0.45)
        running = drain(systemd_socket)
        assert running[0] == "READY=1"
        assert running.count("WATCHDOG=1") >= 2
    assert drain(systemd_socket)[-1] == "STOPPING=1"


def test_a_stalled_control_loop_stops_the_pings(tmp_path, monkeypatch, systemd_socket):
    simulation_profile(tmp_path, monkeypatch)
    monkeypatch.setenv("WATCHDOG_USEC", "200000")
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid()))
    state = {"alive": True}
    monkeypatch.setattr(VacuumController, "control_loop_alive",
                        lambda self, max_age: state["alive"])
    with TestClient(create_app(config_loader=load_vacuum_config)):
        time.sleep(0.3)
        assert "WATCHDOG=1" in drain(systemd_socket)
        state["alive"] = False
        time.sleep(0.15)                  # let an in-flight ping land
        drain(systemd_socket)
        time.sleep(0.4)
        assert "WATCHDOG=1" not in drain(systemd_socket)


def test_disabled_service_still_reports_ready(tmp_path, monkeypatch, systemd_socket):
    payload = json.loads(CONFIG_PATH.read_text())
    payload.update(Enable=False)
    source = tmp_path / "vacuum.json"
    source.write_text(json.dumps(payload))
    monkeypatch.setenv("SBC_VACUUM_CONFIG", str(source))
    with TestClient(create_app(config_loader=load_vacuum_config)):
        assert drain(systemd_socket)[0] == "READY=1"


def test_control_loop_alive_tracks_the_poll_task():
    from .test_vacuum import make_config

    async def scenario():
        controller = VacuumController(make_config(simulate=True))
        assert controller.control_loop_alive(10.0)       # stopped on purpose
        await controller.start()
        try:
            await asyncio.sleep(0)
            assert controller.control_loop_alive(10.0)
            controller._last_iteration_monotonic = time.monotonic() - 60
            assert not controller.control_loop_alive(10.0)  # stuck iteration
            controller._task.cancel()
            try:
                await controller._task
            except asyncio.CancelledError:
                pass
            assert not controller.control_loop_alive(10.0)  # dead poll task
        finally:
            await controller.close()
        assert controller.control_loop_alive(10.0)

    asyncio.run(scenario())
