"""SBC install package: wired connection map, preflight and installer.

Covers ``deploy/sbc`` and ``glasgow_service.sbc_wiring``:

* the map agrees with the board model, the driver and WIRING.md;
* a profile that disagrees with the map is refused (direct-GPIO profiles,
  swapped channels, wrong Pi model / serial node);
* the board probe passes on the emulated rig, fails without the I2C chips,
  and never resets expanders that are already running;
* the installer, run against a fake Pi root: config.txt block, serial
  console, profile, env token, unit, release switch, idempotent re-run, no
  restart of a running controller, refusal of a mismatched profile;
* the bundle builder and the emulator's commissioning replay.
"""
import json
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from glasgow_service import sbc_wiring as sw
from glasgow_service.emulation import board as emu_board
from glasgow_service.emulation.raspberry_pi import VACUUM_CONFIG_TXT
from glasgow_service.emulation.rig import VacuumRig
from glasgow_service import vacuum_io_board as driver

SERVICE = Path(__file__).resolve().parents[1]
REPO = SERVICE.parent
SBC_DIR = SERVICE / "deploy" / "sbc"
EXAMPLE = REPO / "GlasgowDataIO" / "Json" / "vacuumSystem.rpi5-io.example.json"
LIVE_GPIO_PROFILE = REPO / "GlasgowDataIO" / "Json" / "vacuumSystem.json"


@pytest.fixture(scope="module")
def wmap():
    return sw.WiringMap.load(SBC_DIR / "wiring-map.json")


@pytest.fixture
def example():
    return json.loads(EXAMPLE.read_text())


# --------------------------------------------------------------------------- map

def test_map_matches_board_model_and_driver(wmap):
    nets = {row["net"]: row["bcm"] for row in wmap.data["header"] if row.get("bcm") is not None}
    for net, name in {"IO_RESET_N": "BCM_IO_RESET_N", "HEARTBEAT": "BCM_HEARTBEAT",
                      "ESTOP_OK_N": "BCM_ESTOP_OK_N", "SAFE_OK_N": "BCM_SAFE_OK_N",
                      "DI_INT": "BCM_DI_INT", "ADC_ALRT": "BCM_ADC_ALRT",
                      "RS485_DE": "BCM_RS485_DE", "RUN_LED": "BCM_RUN_LED"}.items():
        assert nets[net] == getattr(emu_board, name) == getattr(driver, name), net
    assert set(wmap.i2c_addresses()) == {emu_board.ADDR_OUTPUTS, emu_board.ADDR_INPUTS,
                                         emu_board.ADDR_ADC_LOW, emu_board.ADDR_ADC_HIGH}


def test_header_pins_are_the_real_pi_header(wmap):
    from glasgow_service.emulation.raspberry_pi import HEADER
    for row in wmap.data["header"]:
        expected = HEADER[row["pin"]]
        if row.get("bcm") is not None:
            assert expected == row["bcm"], row
        else:
            assert expected == row["name"], row


def test_config_txt_matches_emulator(wmap):
    for model in ("4B", "5"):
        assert wmap.config_txt_lines(model) == VACUUM_CONFIG_TXT[model].strip().splitlines()


@pytest.mark.parametrize("name,connector,pins", [
    ("K1", "J11", {"COM": 1, "NO": 2, "NC": 3}),
    ("V4", "J22", {"+24": 3, "OUT-": 4}),
    ("V5", "J23", {"+24": 1, "OUT-": 2}),
    ("DI14", "J34", {"IN": 2, "COM": 5, "+24": 6}),
    ("AI3", "J41", {"AI": 5, "0V": 6}),
    ("AI8", "J42", {"AI": 7, "0V": 8}),
])
def test_terminals_follow_wiring_md(wmap, name, connector, pins):
    assert wmap.terminals[name] == {**wmap.terminals[name], "connector": connector, "pins": pins}


def test_relay_rails_follow_the_jumper_defaults(wmap):
    assert wmap.terminals["K1"]["rail"] == "estop"
    assert all(wmap.terminals[f"K{n}"]["rail"] == "safe" for n in range(2, 9))


def test_render_lists_every_device(wmap):
    text, md = wmap.render(), sw.render_markdown(wmap)
    for name in wmap.devices:
        assert name in text and name in md


# --------------------------------------------------------------------------- profile vs map

def test_example_board_profile_matches_the_map(wmap, example):
    report = sw.check_profile(wmap, example, "4B")
    assert report.passed, report.render()
    assert sum(f.check == "wiring" and f.level == "ok" for f in report.findings) == 21


def test_live_gpio_profile_is_refused_on_a_board_install(wmap):
    report = sw.check_profile(wmap, json.loads(LIVE_GPIO_PROFILE.read_text()))
    assert not report.passed
    message = report.errors[0].message
    assert "IO_RESET_N" in message and "HEARTBEAT" in message


def test_swapped_relay_is_an_error(wmap, example):
    example["SBC"]["Channels"]["A1"], example["SBC"]["Channels"]["A2"] = "K3", "K2"
    report = sw.check_profile(wmap, example, "4B")
    assert not report.passed
    assert any("TurboVacuumPump" in f.message and "J13" in f.message for f in report.errors)


def test_wrong_model_and_serial_node_are_errors(wmap, example):
    report = sw.check_profile(wmap, example, "5")      # example is PiModel 4B
    checks = {f.check for f in report.errors}
    assert {"profile.model"} <= checks
    example["SBC"]["PiModel"] = "5"
    example["SBC"]["Serial"]["RS232"] = "/dev/ttyAMA1"
    report = sw.check_profile(wmap, example, "5")
    assert [f.check for f in report.errors] == ["profile.serial"]


def test_interlock_off_is_flagged(wmap, example):
    example["SBC"]["Gauges"]["B1"]["Interlock"] = False
    report = sw.check_profile(wmap, example, "4B")
    assert report.passed
    assert any(f.check == "gauges" and f.level == "warn" for f in report.findings)


@pytest.mark.parametrize("model,rs232", [("4B", "/dev/ttyAMA1"), ("5", "/dev/ttyAMA4")])
def test_generated_profile_is_safe_and_matches(wmap, example, model, rs232):
    payload = sw.profile_for_model(example, model, wmap)
    assert payload["Enable"] is False and payload["IsProduction"] is True
    assert payload["SBC"]["PiModel"] == model
    assert payload["SBC"]["Serial"] == {"RS485": "/dev/ttyAMA0", "RS232": rs232}
    assert sw.check_profile(wmap, payload, model).passed
    assert not any("scan IsProduction" in m for m in payload["Message"])


# --------------------------------------------------------------------------- host checks

def make_pi_root(root: Path, model_text: str, *, config: str = "", cmdline: str = "",
                 vacuum_groups: bool = False) -> Path:
    (root / "proc/device-tree").mkdir(parents=True)
    (root / "proc/device-tree/model").write_bytes(model_text.encode() + b"\0")
    (root / "boot/firmware").mkdir(parents=True)
    (root / "boot/firmware/config.txt").write_text(config)
    (root / "boot/firmware/cmdline.txt").write_text(cmdline or "console=tty1 root=PARTUUID=x rootwait\n")
    (root / "etc").mkdir()
    (root / "etc/passwd").write_text("root:x:0:0::/root:/bin/sh\n"
                                     + ("vacuum:x:990:990::/var/lib/sbc-vacuum:/usr/sbin/nologin\n"
                                        if vacuum_groups else ""))
    members = "pi,vacuum" if vacuum_groups else "pi"
    (root / "etc/group").write_text(f"root:x:0:\ngpio:x:986:{members}\ni2c:x:998:{members}\n"
                                    f"dialout:x:20:{members}\nvacuum:x:990:\n")
    (root / "dev").mkdir()
    return root


def test_host_check_passes_on_a_prepared_pi5(tmp_path, wmap):
    cfg = "\n".join(["dtparam=audio=on", "[all]"] + wmap.config_txt_lines("5")) + "\n"
    root = make_pi_root(tmp_path, "Raspberry Pi 5 Model B Rev 1.0", config=cfg, vacuum_groups=True)
    for node in ("i2c-1", "gpiochip0", "ttyAMA0", "ttyAMA4"):
        (root / "dev" / node).touch()
    report = sw.check_host(wmap, sw.Host(root))
    assert report.passed, report.render()


def test_host_check_finds_the_usual_mistakes(tmp_path, wmap):
    cfg = "[cm4]\ndtparam=i2c_arm=on\n[all]\nenable_uart=1\n"     # i2c only for another board
    root = make_pi_root(tmp_path, "Raspberry Pi 4 Model B Rev 1.5", config=cfg,
                        cmdline="console=serial0,115200 console=tty1 root=x\n")
    report = sw.check_host(wmap, sw.Host(root))
    errors = {f.check: f.message for f in report.errors}
    assert "i2c_arm" in errors["config.txt"] and "uart5" in errors["config.txt"]
    assert "console" in errors
    devices = [f.message for f in report.errors if f.check == "devices"]
    assert any("/dev/i2c-1" in m for m in devices) and any("GPIO chips: none" in m for m in devices)
    assert "vacuum" in errors["user"]


def test_not_a_pi(tmp_path, wmap):
    report = sw.check_host(wmap, sw.Host(tmp_path))
    assert not report.passed and report.errors[0].check == "model"


def test_pi4_uart5_node_is_resolved_from_the_device_tree(tmp_path, wmap):
    root = make_pi_root(tmp_path, "Raspberry Pi 4 Model B Rev 1.5")
    dt = root / "sys/firmware/devicetree/base/soc/serial@7e201a00"
    dt.mkdir(parents=True)
    tty = root / "sys/class/tty/ttyAMA5/device"
    tty.mkdir(parents=True)
    (tty / "of_node").symlink_to(dt)
    host = sw.Host(root)
    assert host.resolve_dt_tty("serial@7e201a00") == "/dev/ttyAMA5"
    payload = {"SBC": {"Serial": {"RS232": "/dev/ttyAMA1"}}}
    report = sw.check_serial_nodes(wmap, payload, host, "4B")
    assert report.findings[0].level == "warn" and "/dev/ttyAMA5" in report.findings[0].message


# --------------------------------------------------------------------------- probe

def test_probe_passes_on_the_emulated_board(wmap):
    rig = VacuumRig(tool_connected=False)
    report = sw.probe_board(wmap, sw.emulated_probe_io(rig))
    assert report.passed, report.render()
    assert sum(f.check == "i2c" and f.level == "ok" for f in report.findings) == 4
    assert any("E-stop rail" in f.message and "live" in f.message for f in report.findings)
    # The reset line is back low and released: expanders in reset, outputs off.
    assert not rig.pi.pin_level(emu_board.BCM_IO_RESET_N)
    assert rig.pi.lines[emu_board.BCM_IO_RESET_N].owner is None


def test_probe_reports_missing_chips(wmap):
    rig = VacuumRig(tool_connected=False)
    for address in (0x20, 0x21, 0x48, 0x49):
        rig.pi.i2c1.inject_nack(address, 50)
    report = sw.probe_board(wmap, sw.emulated_probe_io(rig))
    assert len(report.errors) == 4
    assert "ribbon" in report.errors[0].message


def test_probe_reports_open_estop(wmap):
    rig = VacuumRig(tool_connected=False)
    rig.set_estop(True)
    rig.advance(0.05)
    report = sw.probe_board(wmap, sw.emulated_probe_io(rig))
    assert any("E-stop rail" in f.message and "off" in f.message for f in report.findings)


def test_probe_never_resets_running_expanders(wmap):
    """A latched backing pump (IO_RESET_N held high) survives the probe."""
    rig = VacuumRig(tool_connected=False)
    hal = rig.gpio_hal()
    hal.setup_output(emu_board.BCM_IO_RESET_N, True)
    rig.advance(0.01)
    bus = rig.smbus()
    bus.write_byte_data(0x20, 0x00, 0x00)        # IODIRA: outputs
    bus.write_byte_data(0x20, 0x14, 0x01)        # OLATA: K1 on
    rig.advance(0.05)
    assert rig.board.relay_closed(1)
    rig.pi.lines[emu_board.BCM_IO_RESET_N].owner = None   # "released, still driven high"
    report = sw.probe_board(wmap, sw.ProbeIO(gpio=_OtherOwner(rig), bus=rig.smbus(), sleep=rig.sleep))
    rig.advance(0.05)
    assert rig.board.relay_closed(1), report.render()
    assert any(f.check == "probe" and f.level == "warn" for f in report.findings)


class _OtherOwner:
    """A second process's view of the GPIO chip (inputs only in this test)."""

    def __init__(self, rig):
        self._hal = rig.gpio_hal()
        self._hal.OWNER = "preflight"

    def setup_input(self, bcm, pull=None):
        self._hal.setup_input(bcm, pull)

    def read(self, bcm):
        return self._hal.read(bcm)

    def setup_output(self, bcm, level):
        raise AssertionError("the probe must not drive a line here")

    def write(self, bcm, level):
        raise AssertionError("the probe must not drive a line here")


def test_preflight_refuses_probe_while_service_runs(tmp_path, wmap):
    root = make_pi_root(tmp_path, "Raspberry Pi 5 Model B Rev 1.0")
    report = sw.run_preflight(wmap, None, sw.Host(root), probe=True,
                              probe_io=lambda: pytest.fail("must not probe"), check_service=lambda: True)
    assert any(f.check == "probe" and f.level == "error" for f in report.findings)


def test_cli_emulator_preflight(capsys):
    rc = sw.main(["--map", str(SBC_DIR / "wiring-map.json"), "preflight", "--emulator",
                  "--profile", str(EXAMPLE)])
    out = capsys.readouterr().out
    assert rc == 0, out
    assert "preflight: PASS" in out


# --------------------------------------------------------------------------- installer

def load_installer():
    import importlib.util
    spec = importlib.util.spec_from_file_location("install_sbc", SBC_DIR / "install_sbc.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_config_block_is_idempotent_and_cmdline_console_removed():
    inst = load_installer()
    lines = ["dtparam=i2c_arm=on", "enable_uart=1"]
    once = inst.apply_config_block("dtparam=audio=on\n", lines)
    twice = inst.apply_config_block(once, lines + ["dtoverlay=uart4-pi5"])
    assert twice.count(inst.BLOCK_BEGIN) == 1 and "uart4-pi5" in twice
    assert twice.startswith("dtparam=audio=on\n")
    assert inst.strip_serial_console("console=serial0,115200 console=tty1 root=x rootwait\n") == \
        "console=tty1 root=x rootwait\n"


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    out = tmp_path_factory.mktemp("dist")
    subprocess.run([sys.executable, str(SBC_DIR / "build_sbc_bundle.py"), "--out", str(out)],
                   check=True, capture_output=True)
    archive = next(out.glob("sbc-vacuum-*.tar.gz"))
    with tarfile.open(archive) as tar:
        tar.extractall(out, filter="data")
    return next(p for p in out.iterdir() if p.is_dir())


def test_bundle_contents_and_checksums(bundle):
    for name in ("install_sbc.py", "wiring-map.json", "sbc-vacuum.service.in", "sbc-vacuum.env.in",
                 "vacuumSystem.template.json", "VERSION", "SHA256SUMS", "README.md",
                 "src/pyproject.toml", "src/glasgow_service/sbc_vacuum_app.py",
                 "src/glasgow_service/sbc_wiring.py", "src/glasgow_service/emulation/rig.py"):
        assert (bundle / name).exists(), name
    assert not list(bundle.glob("src/tests")) and not list(bundle.rglob("__pycache__"))
    rc = subprocess.run(["sha256sum", "--quiet", "-c", "SHA256SUMS"], cwd=bundle).returncode
    assert rc == 0


def run_install(bundle, root, *extra):
    env = {"PYTHONPATH": str(bundle / "src"), "PATH": "/usr/bin:/bin"}
    return subprocess.run([sys.executable, str(bundle / "install_sbc.py"), "--root", str(root),
                           "--no-apt", "--no-exec", "--python", sys.executable, *extra],
                          capture_output=True, text=True, env=env)


@pytest.mark.parametrize("model_text,model,overlay,rs232", [
    ("Raspberry Pi 4 Model B Rev 1.5", "4B", "dtoverlay=uart5", "/dev/ttyAMA1"),
    ("Raspberry Pi 5 Model B Rev 1.0", "5", "dtoverlay=uart4-pi5", "/dev/ttyAMA4"),
])
def test_install_on_a_fresh_pi(bundle, tmp_path, model_text, model, overlay, rs232):
    root = make_pi_root(tmp_path, model_text, config="dtparam=audio=on\n",
                        cmdline="console=serial0,115200 console=tty1 root=x rootwait\n")
    res = run_install(bundle, root)
    assert res.returncode == 0, res.stdout + res.stderr
    cfg = (root / "boot/firmware/config.txt").read_text()
    assert overlay in cfg and "dtparam=i2c_arm=on" in cfg
    assert ("disable-bt" in cfg) == (model == "4B")
    assert "console=serial0" not in (root / "boot/firmware/cmdline.txt").read_text()
    assert list((root / "boot/firmware").glob("config.txt.sbc-vacuum.bak-*"))
    profile = json.loads((root / "etc/sbc-vacuum/vacuumSystem.json").read_text())
    assert (profile["Enable"], profile["IsProduction"], profile["SBC"]["PiModel"]) == (False, True, model)
    assert profile["SBC"]["Serial"]["RS232"] == rs232
    env = (root / "etc/sbc-vacuum.env").read_text()
    token = next(l.split("=", 1)[1] for l in env.splitlines() if l.startswith("SBC_VACUUM_TOKEN="))
    assert len(token) >= 40 and "SBC_VACUUM_PORT=8766" in env
    assert oct((root / "etc/sbc-vacuum.env").stat().st_mode & 0o777) == "0o640"
    unit = (root / "etc/systemd/system/sbc-vacuum.service").read_text()
    assert "WorkingDirectory=/var/lib/sbc-vacuum" in unit and "SupplementaryGroups=gpio i2c dialout" in unit
    assert "/opt/ionbeam/sbc-vacuum/current/venv/bin/python -m glasgow_service.sbc_vacuum_app" in unit
    assert "@" not in unit.replace("serial-getty@", "")
    current = root / "opt/ionbeam/sbc-vacuum/current"
    assert current.is_symlink() and (current / "src/pyproject.toml").exists()
    assert (root / "etc/sbc-vacuum/WIRING-MAP.md").exists()
    assert "REBOOT REQUIRED" in res.stdout
    assert "would run: systemctl start" not in res.stdout       # not before the reboot

    # Re-run: nothing changes, no reboot, site files kept.
    res2 = run_install(bundle, root)
    assert res2.returncode == 0, res2.stdout + res2.stderr
    assert "REBOOT REQUIRED" not in res2.stdout
    assert (root / "etc/sbc-vacuum.env").read_text() == env
    assert "kept your /etc/sbc-vacuum/vacuumSystem.json" in res2.stdout
    assert (root / "boot/firmware/config.txt").read_text() == cfg


def test_install_refuses_a_gpio_profile_and_keeps_current(bundle, tmp_path):
    root = make_pi_root(tmp_path, "Raspberry Pi 5 Model B Rev 1.0")
    (root / "etc/sbc-vacuum").mkdir(parents=True)
    (root / "etc/sbc-vacuum/vacuumSystem.json").write_text(LIVE_GPIO_PROFILE.read_text())
    res = run_install(bundle, root)
    assert res.returncode == 1
    assert "does not match the wiring map" in res.stderr
    assert not (root / "opt/ionbeam/sbc-vacuum/current").exists()
    assert not (root / "etc/systemd/system/sbc-vacuum.service").exists()


def test_install_refuses_a_non_pi(bundle, tmp_path):
    res = run_install(bundle, tmp_path)
    assert res.returncode == 1 and "not a Raspberry Pi" in res.stderr


def test_dry_run_changes_nothing(bundle, tmp_path):
    root = make_pi_root(tmp_path, "Raspberry Pi 5 Model B Rev 1.0", config="x=1\n")
    before = sorted(str(p) for p in root.rglob("*"))
    res = run_install(bundle, root, "--dry-run")
    assert res.returncode == 0, res.stderr
    assert sorted(str(p) for p in root.rglob("*")) == before
    assert (root / "boot/firmware/config.txt").read_text() == "x=1\n"


def test_upgrade_does_not_restart_a_running_controller(tmp_path, monkeypatch):
    inst = load_installer()
    args = inst.parse(["--root", str(tmp_path), "--no-exec"])
    i = inst.Installer(args)
    calls = []
    monkeypatch.setattr(i, "run", lambda cmd, **kw: calls.append(cmd) or 0)
    i.start(was_active=True)
    assert ["systemctl", "restart", "sbc-vacuum.service"] not in calls
    assert any("NOT restarted" in n for n in i.notes)
    i.args.restart = True
    calls.clear()
    i.start(was_active=True)
    assert ["systemctl", "restart", "sbc-vacuum.service"] in calls


def test_release_switch_and_rollback(tmp_path):
    inst = load_installer()
    prefix = "/opt/ionbeam/sbc-vacuum"
    args = inst.parse(["--root", str(tmp_path), "--no-exec", "--prefix", prefix])
    i = inst.Installer(args)
    for v in ("1", "2"):
        (tmp_path / f"opt/ionbeam/sbc-vacuum/releases/{v}").mkdir(parents=True)
        i.switch_current(v)
    base = tmp_path / "opt/ionbeam/sbc-vacuum"
    assert (base / "current").readlink() == Path("releases/2")
    assert (base / "previous").readlink() == Path("releases/1")
    i.rollback()
    assert (base / "current").readlink() == Path("releases/1")
    assert (base / "previous").readlink() == Path("releases/2")


def test_repo_unit_runs_lgpio_from_a_writable_directory():
    unit = (SERVICE / "deploy" / "sbc-vacuum.service").read_text()
    assert "WorkingDirectory=/var/lib/sbc-vacuum" in unit
    assert "SupplementaryGroups=gpio i2c dialout" in unit


# --------------------------------------------------------------------------- emulator CLI

def test_commission_replay_runs_to_the_end(capsys):
    from glasgow_service.emulation.__main__ import main
    main(["commission"])
    out = capsys.readouterr().out
    rows = {line.split("  ")[0].strip(): line for line in out.splitlines() if line[:1].isdigit()}
    assert "K2●" in rows["4 jumper DI1"]
    assert "K5●" in rows["6 jumper DI3+DI4, HV permissive on"]
    assert "K1○" in rows["8 open E-stop"] and "K1○" in rows["8b close E-stop (nothing restarts)"]
    assert "SAFE○" in rows["9 service stopped"]
