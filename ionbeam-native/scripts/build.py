#!/usr/bin/env python3
"""Build pipeline for the native desktop app: check, test, bundle.

    python scripts/build.py                 # lint + tests + smoke + bundle
    python scripts/build.py --skip-tests    # bundle only
    python scripts/build.py --out DIR       # default: ionbeam-native/dist

The bundle is a self-contained slice of the Development tree
(ionbeam-native, GlasgowDataIO, glasgow_service, AutomationPy) with the
install scripts, the design doc and the runbook, as .tar.gz (Linux) and .zip
(Windows) plus SHA256SUMS. Install it with
``Development/ionbeam-native/scripts/install_linux.sh`` or
``install_windows.ps1`` after unpacking - the same scripts used on a checkout.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[1]
DEV_ROOT = APP_ROOT.parent
PARTS = ("ionbeam-native", "GlasgowDataIO", "glasgow_service", "AutomationPy")
SKIP_DIRS = {"__pycache__", ".venv", "node_modules", "dist", "build", ".pytest_cache", ".mypy_cache"}
SKIP_SUFFIXES = (".pyc", ".log")


def step(title: str) -> None:
    print(f"\n==> {title}", flush=True)


def run(cmd, **kw) -> None:
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(list(map(str, cmd)), check=True, **kw)


def version() -> str:
    ns: dict = {}
    exec((APP_ROOT / "ionbeam_native" / "__init__.py").read_text(), ns)
    return ns["__version__"]


def git_rev() -> str:
    try:
        return subprocess.run(["git", "-C", str(DEV_ROOT), "rev-parse", "--short", "HEAD"], check=True,
                              capture_output=True, text=True).stdout.strip()
    except Exception:
        return "nogit"


def bundle_files(part: str) -> list[Path]:
    """Tracked + untracked-but-not-ignored files (git), else a filtered walk."""
    root = DEV_ROOT / part
    try:
        out = subprocess.run(["git", "-C", str(DEV_ROOT), "ls-files", "-z", "--cached", "--others",
                              "--exclude-standard", "--", part], check=True, capture_output=True).stdout
        files = [DEV_ROOT / p for p in out.decode().split("\0") if p]
    except Exception:
        files = [p for p in root.rglob("*") if p.is_file()]
    keep = []
    for f in files:
        rel = f.relative_to(DEV_ROOT)
        if any(d in SKIP_DIRS or d.endswith(".egg-info") for d in rel.parts[:-1]):
            continue
        if f.name.endswith(SKIP_SUFFIXES) or not f.is_file():
            continue
        keep.append(f)
    return sorted(keep)


def checks(py: str) -> None:
    env = dict(os.environ, QT_QPA_PLATFORM=os.environ.get("QT_QPA_PLATFORM", "offscreen"))
    if shutil.which("pyflakes") or subprocess.run([py, "-c", "import pyflakes"], capture_output=True).returncode == 0:
        step("lint (pyflakes)")
        run([py, "-m", "pyflakes", "ionbeam_native", "scripts", "tests"], cwd=APP_ROOT, env=env)
    step("ionbeam-native tests")
    with tempfile.TemporaryDirectory() as tmp:
        run([py, "-m", "pytest", "-q", "-p", "no:cacheprovider", str(APP_ROOT / "tests")], cwd=tmp, env=env)
    step("glasgow_service tests")
    env_svc = dict(env, PYTHONPATH=os.pathsep.join(filter(None, [str(DEV_ROOT), env.get("PYTHONPATH")])))
    run([py, "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=DEV_ROOT / "glasgow_service", env=env_svc)
    step("smoke test (real app, emulator + mock backend)")
    run([py, str(APP_ROOT / "scripts" / "smoke.py"), "--seconds", "5"], env=env)


def make_bundle(out_dir: Path) -> list[Path]:
    name = f"ionbeam-native-{version()}-{git_rev()}"
    staging = out_dir / name
    if staging.exists():
        shutil.rmtree(staging)
    step(f"staging {staging}")
    count = 0
    for part in PARTS:
        for f in bundle_files(part):
            dest = staging / "Development" / f.relative_to(DEV_ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            count += 1
    docs = APP_ROOT / "docs"
    for doc in ("RUNBOOK.md", "DESIGN.md"):
        if (docs / doc).is_file():
            shutil.copy2(docs / doc, staging / doc)
    (staging / "INSTALL.txt").write_text(
        "Ion Beam native desktop app\n"
        "===========================\n\n"
        "Linux:   Development/ionbeam-native/scripts/install_linux.sh [--udev]\n"
        "Windows: powershell -ExecutionPolicy Bypass -File "
        "Development\\ionbeam-native\\scripts\\install_windows.ps1\n\n"
        "To share the Operations virtualenv with glasgow_service add --venv <Operations>/.venv (Linux)\n"
        "or -Venv <Operations>\\.venv (Windows). See RUNBOOK.md for configuration and operation.\n",
        encoding="utf-8")
    print(f"    {count} files")
    step("archiving")
    tgz = out_dir / f"{name}.tar.gz"
    with tarfile.open(tgz, "w:gz") as tar:
        tar.add(staging, arcname=name)
    zpath = out_dir / f"{name}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(staging.rglob("*")):
            if f.is_file():
                info = zipfile.ZipInfo.from_file(f, arcname=str(Path(name) / f.relative_to(staging)))
                if os.access(f, os.X_OK):
                    info.external_attr = 0o100755 << 16
                with open(f, "rb") as fh:
                    z.writestr(info, fh.read(), zipfile.ZIP_DEFLATED)
    sums = out_dir / "SHA256SUMS"
    lines = [f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}" for p in (tgz, zpath)]
    sums.write_text("\n".join(lines) + "\n")
    for p in (tgz, zpath, sums):
        print(f"    {p}  ({p.stat().st_size / 1e6:.1f} MB)")
    return [tgz, zpath, sums]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-tests", action="store_true")
    ap.add_argument("--out", default=str(APP_ROOT / "dist"))
    ap.add_argument("--python", default=sys.executable, help="interpreter with the app installed")
    args = ap.parse_args()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if not args.skip_tests:
        checks(args.python)
    make_bundle(out_dir)
    print("\nbuild ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
