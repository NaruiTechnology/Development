#!/usr/bin/env python3
"""Build and deploy the desktop scanner to a local instrument workstation."""
from pathlib import Path
import argparse
import json
import subprocess
import sys


DEVELOPMENT = Path(__file__).resolve().parents[1]
DEPLOY = DEVELOPMENT / "DeployWorkSpace" / "Development" / "DistributionDeploy" / "distributionDeployApp.py"
BUILD_DIST = DEVELOPMENT / "buildCompiledDist.py"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="deployment JSON config")
    parser.add_argument("--deploy-root", help="override target platform directory")
    parser.add_argument("--artifact", help="use an already-built desktop .deb")
    parser.add_argument("--install-deps", action="store_true", help="run npm ci when building")
    args = parser.parse_args()

    # Build the full distribution as well as the Electron package so the
    # device API, native socket service and frontend all land together.
    build = [sys.executable, str(BUILD_DIST), "--desktop"]
    if args.install_deps:
        build.append("--desktop-install-deps")
    subprocess.run(build, cwd=DEVELOPMENT, check=True)

    version = json.loads((DEVELOPMENT / "ionbeam-desktop" / "package.json").read_text())["version"]
    bundled_artifact = DEPLOY.parent / f"ionbeam-desktop_{version}_amd64.deb"
    artifact = Path(args.artifact).expanduser().resolve() if args.artifact else bundled_artifact
    if not artifact.is_file():
        parser.error(f"Desktop package does not exist: {artifact}")

    command = [sys.executable, str(DEPLOY), "--desktop", "--desktop-artifact", str(artifact)]
    if args.config:
        command.extend(["-j", str(Path(args.config).expanduser().resolve())])
    if args.deploy_root:
        command.extend(["-r", args.deploy_root])
    return subprocess.run(command, cwd=DEPLOY.parent).returncode


if __name__ == "__main__":
    raise SystemExit(main())
