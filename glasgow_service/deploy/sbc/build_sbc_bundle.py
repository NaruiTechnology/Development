#!/usr/bin/env python3
"""Build the SBC vacuum controller install bundle (run on the development host).

    python3 glasgow_service/deploy/sbc/build_sbc_bundle.py            # dist/sbc-vacuum-<version>.tar.gz
    python3 glasgow_service/deploy/sbc/build_sbc_bundle.py --wheels   # + offline aarch64 wheelhouse

The bundle holds only what the Pi needs: the ``glasgow_service`` package
source (no tests), the installer, the systemd unit and env templates, the
board profile template and the wired connection map, plus ``VERSION`` and
``SHA256SUMS``.  Copy it to the Pi and run ``sudo python3 install_sbc.py``
inside it, or use ``deploy-sbc.sh``, which does both.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent                 # glasgow_service/deploy/sbc
SERVICE = HERE.parents[1]                              # glasgow_service/
REPO = SERVICE.parent                                  # Development/
PROFILE_TEMPLATE = REPO / "GlasgowDataIO" / "Json" / "vacuumSystem.rpi5-io.example.json"
BUNDLE_FILES = ("install_sbc.py", "wiring-map.json", "sbc-vacuum.service.in", "sbc-vacuum.env.in",
                "README.md", "deploy-sbc.sh")
SKIP = re.compile(r"(__pycache__|\.pyc$|\.pyo$|\.egg-info)")


def version() -> str:
    text = (SERVICE / "pyproject.toml").read_text()
    base = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M).group(1)
    try:
        sha = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short=8", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--", "glasgow_service",
                                "GlasgowDataIO/Json/vacuumSystem.rpi5-io.example.json"],
                               capture_output=True, text=True).stdout.strip()
        return f"{base}+g{sha}" + (f".dirty{time.strftime('%Y%m%d%H%M')}" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return f"{base}+{time.strftime('%Y%m%d%H%M')}"


def copy_package(dest: Path) -> int:
    (dest / "glasgow_service").mkdir(parents=True)
    shutil.copy2(SERVICE / "pyproject.toml", dest / "pyproject.toml")
    readme = SERVICE / "README.md"
    if readme.exists():
        shutil.copy2(readme, dest / "README.md")
    else:
        (dest / "README.md").write_text("glasgow-service (SBC vacuum controller subset)\n")
    count = 0
    for path in sorted((SERVICE / "glasgow_service").rglob("*")):
        rel = path.relative_to(SERVICE)
        if path.is_dir() or SKIP.search(str(rel)):
            continue
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest / rel)
        count += 1
    return count


def wheelhouse(dest: Path, python: str) -> None:
    """Download aarch64 wheels so the Pi can install without internet."""
    deps = ["fastapi>=0.110", "uvicorn[standard]>=0.27", "pydantic>=2.5", "gpiozero>=2.0",
            "redis>=5.0,<8", "httpx>=0.27,<1", "smbus2>=0.4", "pyserial>=3.5", "setuptools>=68", "wheel"]
    dest.mkdir()
    platforms = ["manylinux_2_17_aarch64", "manylinux2014_aarch64", "manylinux_2_28_aarch64", "linux_aarch64"]
    cmd = [sys.executable, "-m", "pip", "download", "--dest", str(dest), "--only-binary=:all:",
           "--python-version", python, "--implementation", "cp", "--abi", f"cp{python.replace('.', '')}"]
    for plat in platforms:
        cmd += ["--platform", plat]
    subprocess.run(cmd + ["--abi", "abi3", "--abi", "none"] + deps, check=True)


def sha256sums(root: Path) -> str:
    lines = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(root)}")
    return "\n".join(lines) + "\n"


def build(out_dir: Path, *, wheels: bool = False, python: str = "3.11") -> Path:
    ver = version()
    name = f"sbc-vacuum-{ver}"
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / name
        stage.mkdir()
        for f in BUNDLE_FILES:
            shutil.copy2(HERE / f, stage / f)
        template = json.loads(PROFILE_TEMPLATE.read_text())
        (stage / "vacuumSystem.template.json").write_text(json.dumps(template, indent=2) + "\n")
        n = copy_package(stage / "src")
        if wheels:
            wheelhouse(stage / "wheels", python)
        (stage / "VERSION").write_text(ver + "\n")
        (stage / "SHA256SUMS").write_text(sha256sums(stage))
        out_dir.mkdir(parents=True, exist_ok=True)
        archive = out_dir / f"{name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for path in sorted(stage.rglob("*")):
                info = tar.gettarinfo(str(path), arcname=str(Path(name) / path.relative_to(stage)))
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                if path.is_file():
                    with path.open("rb") as fh:
                        tar.addfile(info, fh)
                else:
                    tar.addfile(info)
        print(f"built {archive} ({n} package files{', wheelhouse' if wheels else ''}), version {ver}")
        return archive


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=SERVICE / "dist")
    ap.add_argument("--wheels", action="store_true", help="include an offline aarch64 wheelhouse")
    ap.add_argument("--python", default="3.11",
                    help="Pi OS Python for --wheels: 3.11 (bookworm) or 3.13 (trixie)")
    args = ap.parse_args(argv)
    build(args.out, wheels=args.wheels, python=args.python)
    return 0


if __name__ == "__main__":
    sys.exit(main())
