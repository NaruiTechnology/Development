"""Cross-OS lifecycle manager for the Docker-hosted Glasgow service."""
from pathlib import Path
import os
import subprocess
import sys
import time
import urllib.request


def docker(*args, check=True, capture=False):
    return subprocess.run(
        ["docker", *args], check=check,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True)


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "restart"
    if action not in {"start", "restart", "stop", "status", "logs"}:
        print("Usage: manage-local-system-docker.py "
              "[start|restart|stop|status|logs]", file=sys.stderr)
        return 2
    root = Path(os.environ.get(
        "OPERATIONS_ROOT", Path(__file__).resolve().parents[2])).resolve()
    image = os.environ.get("GLASGOW_DOCKER_IMAGE", "glasgow-service:local")
    container = os.environ.get("GLASGOW_DOCKER_CONTAINER", "glasgowService")
    config = Path(os.environ.get(
        "GLASGOW_CONFIG",
        root / "Development" / "GlasgowDataIO" / "Json" / "streamData.json"))

    if action == "status":
        return docker("ps", "-a", "--filter", "name=^/{}$".format(container)).returncode
    if action == "logs":
        return docker("logs", "-f", container).returncode
    if action in {"stop", "restart"}:
        docker("rm", "-f", container, check=False, capture=True)
        if action == "stop":
            return 0
    if not config.is_file():
        raise FileNotFoundError("Glasgow config not found: {}".format(config))
    if docker("image", "inspect", image, check=False, capture=True).returncode != 0:
        subprocess.run([
            sys.executable,
            str(Path(__file__).with_name("build-glasgow-service-docker.py")),
            image], check=True)
    docker(
        "run", "-d", "--name", container, "--restart", "unless-stopped",
        "-p", "8765:8765", "--privileged",
        "-e", "GLASGOW_TOKEN={}".format(os.environ.get("GLASGOW_TOKEN", "")),
        "-e", "GLASGOW_CONFIG=/app/config/streamData.json",
        "-v", "{}:/app/config/streamData.json:ro".format(config), image)
    for _ in range(60):
        try:
            with urllib.request.urlopen(
                    "http://127.0.0.1:8765/status", timeout=2) as response:
                if response.status < 400:
                    print("{} is ready at http://127.0.0.1:8765".format(container))
                    return 0
        except Exception:
            time.sleep(1)
    docker("logs", container, check=False)
    print("{} did not become ready".format(container), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
