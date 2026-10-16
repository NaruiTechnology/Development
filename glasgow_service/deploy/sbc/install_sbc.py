#!/usr/bin/env python3
"""Install or upgrade the SBC vacuum controller on a Raspberry Pi 4 Model B or Pi 5.

Run on the Pi, as root, from an unpacked bundle (``build_sbc_bundle.py``)::

    sudo python3 install_sbc.py                 # install / upgrade
    sudo python3 install_sbc.py --dry-run       # show what would happen
    sudo python3 install_sbc.py --rollback      # back to the previous release
    sudo python3 install_sbc.py --uninstall --yes

What it does (idempotent; safe to re-run):

1. detects the Pi model (``/proc/device-tree/model``);
2. installs OS packages (python3-venv, python3-lgpio, i2c-tools);
3. creates the ``vacuum`` system user in the gpio, i2c and dialout groups;
4. writes the board's ``config.txt`` lines in a managed block, removes the
   serial login console from ``cmdline.txt`` (the console UART is the RS-485
   bus) and, on the Pi 4B, disables Bluetooth's UART;
5. installs the release into ``<prefix>/releases/<version>`` with its own
   virtualenv, and switches ``<prefix>/current`` only after the wiring check
   passes;
6. installs ``/etc/sbc-vacuum/wiring-map.json``, a first profile
   (``Enable: false`` - nothing is switched until commissioning) and
   ``/etc/sbc-vacuum.env`` with a random API token.  Existing site files are
   never overwritten; the new versions are written next to them as ``.dist``;
7. installs and enables ``sbc-vacuum.service``.

It never restarts a running controller (a restart pumps the system down):
it says so and leaves that to ``--restart`` or the operator.  It does not
start the service when a reboot is needed for the new ``config.txt``.

Only the Python standard library is used, so it runs before the venv exists.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import grp
import json
import os
import pwd
import re
import secrets
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
UNIT = "sbc-vacuum.service"
USER = "vacuum"
GROUPS = ("gpio", "i2c", "dialout")
APT_PACKAGES = ("python3-venv", "python3-pip", "python3-lgpio", "i2c-tools")
BLOCK_BEGIN = "# >>> sbc-vacuum (managed by install_sbc.py; edits inside are replaced) >>>"
BLOCK_END = "# <<< sbc-vacuum <<<"
CONSOLE_RE = re.compile(r"\s*console=(?:serial0|serial1|ttyAMA\d+|ttyS0)(?:,\S*)?")
KEEP_RELEASES = 3
#: Commands that change the OS; --no-exec (tests, image staging) only logs them.
SYSTEM_COMMANDS = {"systemctl", "apt-get", "useradd", "usermod", "env"}


class InstallError(RuntimeError):
    pass


def model_from_string(text: str) -> str | None:
    t = text.strip("\x00 \n")
    if re.search(r"Raspberry Pi 5\b", t):
        return "5"
    if re.search(r"Raspberry Pi 4 Model B\b", t):
        return "4B"
    return None


def managed_block(lines: list[str]) -> str:
    return "\n".join([BLOCK_BEGIN, "[all]", *lines, BLOCK_END]) + "\n"


def apply_config_block(text: str, lines: list[str]) -> str:
    """Return config.txt with exactly one managed block (at the end)."""
    pattern = re.compile(re.escape(BLOCK_BEGIN) + r".*?" + re.escape(BLOCK_END) + r"\n?", re.S)
    body = pattern.sub("", text).rstrip("\n")
    return (body + "\n\n" if body else "") + managed_block(lines)


def strip_serial_console(cmdline: str) -> str:
    return CONSOLE_RE.sub("", cmdline).strip() + "\n"


class Installer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = Path(args.root)
        self.bundle = Path(args.bundle).resolve()
        self.prefix = args.prefix
        self.dry = args.dry_run
        self.notes: list[str] = []
        self.reboot_required = False
        self.version = (self.bundle / "VERSION").read_text().strip() if (self.bundle / "VERSION").exists() \
            else "dev"
        self.model: str | None = None

    # ------------------------------------------------------------ plumbing
    def p(self, absolute: str) -> Path:
        return self.root / absolute.lstrip("/")

    def log(self, msg: str) -> None:
        print(f"[sbc-install] {msg}", flush=True)

    def run(self, cmd: list[str], *, check: bool = True, quiet: bool = False) -> int:
        line = " ".join(shlex.quote(c) for c in cmd)
        if self.dry or (self.args.no_exec and cmd[0] in SYSTEM_COMMANDS):
            self.log(f"would run: {line}")
            return 0
        if not quiet:
            self.log(f"run: {line}")
        rc = subprocess.run(cmd).returncode
        if check and rc != 0:
            raise InstallError(f"command failed ({rc}): {line}")
        return rc

    def capture(self, cmd: list[str]) -> tuple[int, str]:
        if self.args.no_exec and cmd[0] in SYSTEM_COMMANDS:
            return 1, ""
        try:
            res = subprocess.run(cmd, capture_output=True, text=True)
        except FileNotFoundError:
            return 127, ""
        return res.returncode, res.stdout

    def write(self, absolute: str, text: str, mode: int = 0o644, *, backup: bool = False) -> bool:
        path = self.p(absolute)
        old = path.read_text() if path.exists() else None
        if old == text:
            return False
        if self.dry:
            self.log(f"would write {absolute}" + (" (changed)" if old is not None else " (new)"))
            return True
        path.parent.mkdir(parents=True, exist_ok=True)
        if backup and old is not None:
            stamp = _dt.datetime.now().strftime("%Y%m%d%H%M%S")
            shutil.copy2(path, path.with_name(f"{path.name}.sbc-vacuum.bak-{stamp}"))
        tmp = path.with_name(path.name + ".tmp-sbc")
        tmp.write_text(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        self.log(f"wrote {absolute}")
        return True

    def chown(self, absolute: str, user: str, group: str) -> None:
        if self.dry or self.args.no_exec:
            return
        try:
            shutil.chown(self.p(absolute), user, group)
        except (LookupError, PermissionError, OSError) as exc:
            self.log(f"warning: could not chown {absolute} to {user}:{group} ({exc})")

    def venv_python(self, release: str) -> str:
        """Absolute path (under --root) of the release's interpreter."""
        if self.args.python:
            return self.args.python
        return str(self.p(f"{self.prefix}/releases/{release}/venv/bin/python"))

    # ------------------------------------------------------------ steps
    def detect_model(self) -> str:
        path = self.p("/proc/device-tree/model")
        text = path.read_bytes().decode(errors="replace") if path.exists() else ""
        detected = model_from_string(text) if text else None
        if self.args.model and self.args.model != "auto":
            if detected and detected != self.args.model:
                raise InstallError(f"--model {self.args.model} but this is a Pi {detected} ({text.strip(chr(0))})")
            self.model = self.args.model
        elif detected:
            self.model = detected
        else:
            raise InstallError("not a Raspberry Pi 4 Model B or Pi 5 "
                               f"({text.strip(chr(0)) or 'no /proc/device-tree/model'}); "
                               "pass --model 4B|5 to install anyway (image builds)")
        self.log(f"target: Raspberry Pi {self.model} ({text.strip(chr(0)) or 'model given'}); "
                 f"release {self.version}")
        return self.model

    def apt(self) -> None:
        if self.args.no_apt:
            self.log("skipping OS packages (--no-apt)")
            return
        env_prefix = ["env", "DEBIAN_FRONTEND=noninteractive"]
        self.run(env_prefix + ["apt-get", "-o", "DPkg::Lock::Timeout=600", "update"])
        self.run(env_prefix + ["apt-get", "-o", "DPkg::Lock::Timeout=600", "install", "-y",
                               "--no-install-recommends", *APT_PACKAGES])

    def user(self) -> None:
        exists = self._user_exists()
        if not exists:
            self.run(["useradd", "--system", "--user-group", "--no-create-home",
                      "--home-dir", "/var/lib/sbc-vacuum", "--shell", "/usr/sbin/nologin", USER])
        present = [g for g in GROUPS if self._group_exists(g)]
        missing = [g for g in GROUPS if g not in present]
        if present:
            self.run(["usermod", "-a", "-G", ",".join(present), USER])
        if missing:
            self.notes.append(f"group(s) {', '.join(missing)} do not exist: is this Raspberry Pi OS? "
                              "The service user may not reach GPIO/I2C/UART.")

    def _user_exists(self) -> bool:
        if self.root != Path("/"):
            passwd = self.p("/etc/passwd")
            return passwd.exists() and any(l.split(":")[0] == USER for l in passwd.read_text().splitlines())
        try:
            pwd.getpwnam(USER)
            return True
        except KeyError:
            return False

    def _group_exists(self, name: str) -> bool:
        if self.root != Path("/"):
            group = self.p("/etc/group")
            return group.exists() and any(l.split(":")[0] == name for l in group.read_text().splitlines())
        try:
            grp.getgrnam(name)
            return True
        except KeyError:
            return False

    def boot_config(self, wiring: dict) -> None:
        boot = "/boot/firmware" if self.p("/boot/firmware/config.txt").exists() else "/boot"
        cfg_path = f"{boot}/config.txt"
        cfg = self.p(cfg_path).read_text() if self.p(cfg_path).exists() else ""
        lines = wiring["config_txt"][self.model]
        if self.write(cfg_path, apply_config_block(cfg, lines), backup=True):
            self.reboot_required = True
            self.notes.append(f"{cfg_path}: board settings written ({', '.join(lines)})")
        cmd_path = f"{boot}/cmdline.txt"
        if self.p(cmd_path).exists():
            cmd = self.p(cmd_path).read_text()
            new = strip_serial_console(cmd)
            if new.strip() != cmd.strip() and self.write(cmd_path, new, backup=True):
                self.reboot_required = True
                self.notes.append(f"{cmd_path}: serial login console removed (the UART is the RS-485 bus)")
        self.run(["systemctl", "mask", "serial-getty@ttyAMA0.service", "serial-getty@serial0.service"],
                 check=False, quiet=True)
        if self.model == "4B":
            self.run(["systemctl", "disable", "hciuart.service"], check=False, quiet=True)

    def release(self, wiring_map: Path) -> str:
        rel = f"{self.prefix}/releases/{self.version}"
        src = self.bundle / "src"
        if not (src / "pyproject.toml").exists():
            raise InstallError(f"bundle has no src/pyproject.toml ({src})")
        if self.dry:
            self.log(f"would install {src} into {rel}")
        else:
            dest = self.p(rel)
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            shutil.copytree(src, dest / "src")
            shutil.copy2(wiring_map, dest / "wiring-map.json")
            for name in ("VERSION", "SHA256SUMS"):
                if (self.bundle / name).exists():
                    shutil.copy2(self.bundle / name, dest / name)
        if self.args.python:
            self.log(f"using {self.args.python} instead of a release virtualenv (--python)")
            return self.version
        venv = f"{rel}/venv"
        # --system-site-packages: lgpio comes from the OS package (python3-lgpio).
        self.run(["python3", "-m", "venv", "--system-site-packages", str(self.p(venv))])
        pip = [str(self.p(venv + "/bin/python")), "-m", "pip", "install", "--disable-pip-version-check",
               "--no-input"]
        wheelhouse = self.bundle / "wheels"
        if wheelhouse.is_dir() and any(wheelhouse.iterdir()):
            pip += ["--no-index", "--find-links", str(wheelhouse)]
        self.run(pip + [str(self.p(rel + "/src")) + "[sbc]"])
        self.run([str(self.p(venv + "/bin/python")), "-c",
                  "import glasgow_service.sbc_vacuum_app, smbus2, serial; "
                  "import importlib.util as u; "
                  "print('lgpio:', 'ok' if u.find_spec('lgpio') else 'MISSING')"])
        return self.version

    def site_files(self, release: str) -> dict:
        etc = "/etc/sbc-vacuum"
        if not self.dry:
            self.p(etc).mkdir(parents=True, exist_ok=True)
        dist_map = (self.bundle / "wiring-map.json").read_text()
        self._install_site_file(f"{etc}/wiring-map.json", dist_map, 0o644)
        vpy = self.venv_python(release)
        profile = f"{etc}/vacuumSystem.json"
        tmp_profile = f"{etc}/vacuumSystem.json.dist"
        args = [vpy, "-m", "glasgow_service.sbc_wiring", "--map", str(self.p(f"{etc}/wiring-map.json")),
                "make-profile", "--template", str(self.bundle / "vacuumSystem.template.json"),
                "--model", self.model, "--root", str(self.root), "--out", str(self.p(tmp_profile))]
        self.run(args)
        if not self.p(profile).exists() and not self.dry:
            if self.p(tmp_profile).exists():
                shutil.copy2(self.p(tmp_profile), self.p(profile))
                self.log(f"installed first profile {profile} (Enable: false)")
        elif self.p(profile).exists():
            self.notes.append(f"kept your {profile}; the release's version is {tmp_profile}")
        env = "/etc/sbc-vacuum.env"
        template = (self.bundle / "sbc-vacuum.env.in").read_text().replace("@CONFIG@", profile)
        if self.p(env).exists():
            current = self.p(env).read_text()
            if "SBC_VACUUM_TOKEN=change-me" in current or re.search(r"^SBC_VACUUM_TOKEN=\s*$", current, re.M):
                self.notes.append(f"{env}: SBC_VACUUM_TOKEN is still a placeholder - set a long random value")
            self.write(env + ".dist", template.replace("@TOKEN@", "<generated on first install>"), 0o640)
        else:
            token = secrets.token_urlsafe(32)
            self.write(env, template.replace("@TOKEN@", token), 0o640)
            self.chown(env, "root", USER)
            self.notes.append(f"{env}: generated SBC_VACUUM_TOKEN; give the same value to the host "
                              "backend (SBC_VACUUM_TOKEN) so it can read the controller")
        return profile

    def _install_site_file(self, absolute: str, text: str, mode: int) -> None:
        if self.p(absolute).exists() and self.p(absolute).read_text() != text:
            self.write(absolute + ".dist", text, mode)
            self.notes.append(f"kept your {absolute} (site wiring record); release copy: {absolute}.dist")
        else:
            self.write(absolute, text, mode)

    def check_wiring(self, release: str, profile: str) -> None:
        vpy = self.venv_python(release)
        rc = self.run([vpy, "-m", "glasgow_service.sbc_wiring", "--map",
                       str(self.p("/etc/sbc-vacuum/wiring-map.json")), "check", "--profile",
                       str(self.p(profile)), "--model", self.model], check=False)
        if rc != 0 and not self.args.force:
            raise InstallError("the profile does not match the wiring map (see above); fix "
                               f"{profile} or /etc/sbc-vacuum/wiring-map.json, or pass --force. "
                               "The previous release stays active.")

    def systemd(self, release: str) -> None:
        unit = (self.bundle / "sbc-vacuum.service.in").read_text().replace("@PREFIX@", self.prefix)
        self.write(f"/etc/systemd/system/{UNIT}", unit)
        wrapper = ("#!/bin/sh\n# Installed by install_sbc.py: wiring map / profile / board checks.\n"
                   f"exec {self.prefix}/current/venv/bin/python -m glasgow_service.sbc_wiring "
                   "--map /etc/sbc-vacuum/wiring-map.json \"$@\"\n")
        self.write("/usr/local/bin/sbc-vacuum-preflight", wrapper, 0o755)
        md_args = [self.venv_python(release), "-m", "glasgow_service.sbc_wiring", "--map",
                   str(self.p("/etc/sbc-vacuum/wiring-map.json")), "show", "--markdown"]
        rc, out = self.capture(md_args)
        if rc == 0 and out:
            self.write("/etc/sbc-vacuum/WIRING-MAP.md", out)

    def switch_current(self, release: str) -> None:
        cur, prev = self.p(f"{self.prefix}/current"), self.p(f"{self.prefix}/previous")
        target = f"releases/{release}"
        old = os.readlink(cur) if cur.is_symlink() else None
        if old == target:
            return
        if self.dry:
            self.log(f"would point {self.prefix}/current at {target}")
            return
        if old:
            tmp = prev.with_name("previous.tmp")
            if tmp.is_symlink():
                tmp.unlink()
            tmp.symlink_to(old)
            os.replace(tmp, prev)
        tmp = cur.with_name("current.tmp")
        if tmp.is_symlink():
            tmp.unlink()
        tmp.symlink_to(target)
        os.replace(tmp, cur)                      # atomic switch
        self.log(f"{self.prefix}/current -> {target}" + (f" (previous: {old})" if old else ""))
        self.prune()

    def prune(self) -> None:
        rel_dir = self.p(f"{self.prefix}/releases")
        keep = set()
        for link in ("current", "previous"):
            p = self.p(f"{self.prefix}/{link}")
            if p.is_symlink():
                keep.add(Path(os.readlink(p)).name)
        releases = sorted((d for d in rel_dir.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime)
        for d in releases[:-KEEP_RELEASES]:
            if d.name not in keep:
                shutil.rmtree(d)
                self.log(f"removed old release {d.name}")

    def service_state(self) -> bool:
        rc, _ = self.capture(["systemctl", "is-active", "--quiet", UNIT])
        return rc == 0

    def start(self, was_active: bool) -> None:
        self.run(["systemctl", "daemon-reload"])
        self.run(["systemctl", "enable", UNIT])
        if self.reboot_required:
            self.notes.append("REBOOT REQUIRED for config.txt / cmdline.txt. The service is enabled and "
                              "starts on boot. After the reboot run: sudo sbc-vacuum-preflight preflight")
            return
        if was_active and not self.args.restart:
            self.notes.append("sbc-vacuum is running the previous release and was NOT restarted "
                              "(a restart pumps the system down). Restart when that is acceptable: "
                              "sudo systemctl restart sbc-vacuum")
            return
        self.run(["systemctl", "restart" if was_active else "start", UNIT])

    # ------------------------------------------------------------ entry points
    def install(self) -> None:
        wiring_path = self.bundle / "wiring-map.json"
        wiring = json.loads(wiring_path.read_text())
        self.detect_model()
        was_active = self.service_state()
        self.apt()
        self.user()
        self.boot_config(wiring)
        release = self.release(wiring_path)
        profile = self.site_files(release)
        self.check_wiring(release, profile)
        self.systemd(release)
        self.switch_current(release)
        if not self.dry:
            for d in ("/var/lib/sbc-vacuum",):
                self.p(d).mkdir(parents=True, exist_ok=True)
                self.chown(d, USER, USER)
        self.start(was_active)
        self.summary()

    def rollback(self) -> None:
        prev = self.p(f"{self.prefix}/previous")
        if not prev.is_symlink():
            raise InstallError("no previous release to roll back to")
        target = os.readlink(prev)
        self.log(f"rolling back to {target}")
        if not self.dry:
            cur = self.p(f"{self.prefix}/current")
            old = os.readlink(cur) if cur.is_symlink() else None
            tmp = cur.with_name("current.tmp")
            if tmp.is_symlink():
                tmp.unlink()
            tmp.symlink_to(target)
            os.replace(tmp, cur)
            if old:
                prev.unlink()
                prev.symlink_to(old)
        self.run(["systemctl", "daemon-reload"])
        if self.args.restart:
            self.run(["systemctl", "restart", UNIT])
        else:
            self.notes.append("rolled back; the running process is unchanged until: "
                              "sudo systemctl restart sbc-vacuum")
        self.summary()

    def uninstall(self) -> None:
        if not self.args.yes:
            raise InstallError("--uninstall stops the controller (every pump goes off); add --yes")
        self.run(["systemctl", "disable", "--now", UNIT], check=False)
        for f in (f"/etc/systemd/system/{UNIT}", "/usr/local/bin/sbc-vacuum-preflight"):
            if self.p(f).exists() and not self.dry:
                self.p(f).unlink()
        self.run(["systemctl", "daemon-reload"], check=False)
        self.notes.append(f"kept {self.prefix}, /etc/sbc-vacuum and /etc/sbc-vacuum.env "
                          "(site configuration); delete them by hand if wanted")
        self.summary()

    def summary(self) -> None:
        for n in self.notes:
            self.log(f"NOTE: {n}")
        self.log("done" + (" (dry run, nothing changed)" if self.dry else ""))


def parse(argv=None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bundle", default=str(HERE), help="unpacked bundle directory (default: this one)")
    ap.add_argument("--model", default="auto", choices=["auto", "4B", "5"])
    ap.add_argument("--prefix", default="/opt/ionbeam/sbc-vacuum")
    ap.add_argument("--root", default="/", help="install into this root (image builds, tests)")
    ap.add_argument("--dry-run", action="store_true", help="show the actions, change nothing")
    ap.add_argument("--no-apt", action="store_true", help="skip OS package installation")
    ap.add_argument("--no-exec", action="store_true", help=argparse.SUPPRESS)  # tests: log OS commands
    ap.add_argument("--python", default=None, help=argparse.SUPPRESS)  # tests: skip venv/pip, use this
    ap.add_argument("--restart", action="store_true",
                    help="restart a running controller onto the new release (pumps down)")
    ap.add_argument("--force", action="store_true", help="install even if the wiring check fails")
    ap.add_argument("--rollback", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--yes", action="store_true")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = parse(argv)
    if args.root == "/" and not args.dry_run and os.geteuid() != 0:
        print("install_sbc.py must run as root (sudo), or with --dry-run", file=sys.stderr)
        return 2
    inst = Installer(args)
    try:
        if args.rollback:
            inst.rollback()
        elif args.uninstall:
            inst.uninstall()
        else:
            inst.install()
    except InstallError as exc:
        print(f"[sbc-install] ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
