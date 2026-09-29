#!/usr/bin/env python3
"""Build the Ionbeam Electron scanner and a checksummed Ubuntu .deb."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile


DEVELOPMENT = Path(__file__).resolve().parents[1]
APP = DEVELOPMENT / "ionbeam-desktop"
PACKAGE_NAME = "ionbeam-desktop"


def run(command, cwd):
    print("+", " ".join(map(str, command)), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-deps", action="store_true", help="run npm ci before building")
    args = parser.parse_args()
    package = json.loads((APP / "package.json").read_text())
    version = package["version"]
    release = APP / "release"
    artifact = release / f"{PACKAGE_NAME}_{version}_amd64.deb"

    if args.install_deps:
        run(["npm", "ci"], APP)
    run(["npm", "run", "build"], APP)
    release.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".desktop-build-", dir=release) as temporary:
        work = Path(temporary)
        run([sys.executable, "scripts/package_linux.py", "--output-dir", str(work / "runtime")], APP)
        electron_tree = work / "runtime" / "IonbeamDesktop-linux-x64"
        if not (electron_tree / "electron").is_file():
            raise SystemExit(f"Electron runtime missing from {electron_tree}")
        stage = work / "package"
        install_root = stage / "opt" / "ionbeam-desktop"
        shutil.copytree(electron_tree, install_root)
        (stage / "usr" / "bin").mkdir(parents=True)
        launcher = stage / "usr" / "bin" / "ionbeam-desktop"
        launcher.write_text("#!/bin/sh\nexec /opt/ionbeam-desktop/ionbeam-desktop \"$@\"\n")
        launcher.chmod(0o755)
        applications = stage / "usr" / "share" / "applications"
        applications.mkdir(parents=True)
        (applications / "ionbeam-desktop.desktop").write_text(
            "[Desktop Entry]\nType=Application\nName=Ion Beam Desktop Scanner\n"
            "Comment=Raster, vector and ROI acquisition\nExec=/usr/bin/ionbeam-desktop %u\n"
            "Terminal=false\nCategories=Science;Engineering;\n"
            "MimeType=x-scheme-handler/ionbeam;\n")
        control = stage / "DEBIAN" / "control"
        control.parent.mkdir()
        control.write_text(
            f"Package: {PACKAGE_NAME}\nVersion: {version}\nSection: science\nPriority: optional\n"
            "Architecture: amd64\nDepends: libasound2, libatk-bridge2.0-0, libatk1.0-0, libc6, "
            "libcairo2, libcups2, libdbus-1-3, libdrm2, libgbm1, libglib2.0-0, libgtk-3-0, "
            "libnss3, libx11-xcb1, libxkbcommon0, libxss1, libxtst6\n"
            "Maintainer: Ionbeam Technology\n"
            "Description: Native Ion Beam scanner with the Ionbeam web control layout\n")
        candidate = work / artifact.name
        run(["dpkg-deb", "--build", "--root-owner-group", str(stage), str(candidate)], APP)
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        checksum = work / (artifact.name + ".sha256")
        checksum.write_text(f"{digest}  {artifact.name}\n")
        candidate.replace(artifact)
        checksum.replace(artifact.with_suffix(artifact.suffix + ".sha256"))
    print(f"Built {artifact}\nSHA-256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
