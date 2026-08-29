"""Build glasgow-service:local using Docker on Linux or Windows."""
from pathlib import Path
import os
import subprocess
import sys


def main():
    operations_root = Path(os.environ.get(
        "OPERATIONS_ROOT", Path(__file__).resolve().parents[2])).resolve()
    image = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "GLASGOW_DOCKER_IMAGE", "glasgow-service:local")
    dockerfile = operations_root / "Development" / "glasgow_service" / \
        "deploy" / "Dockerfile.glasgow-service"
    if not dockerfile.is_file():
        raise FileNotFoundError("Dockerfile not found: {}".format(dockerfile))
    subprocess.run([
        "docker", "build", "--file", str(dockerfile), "--tag", image,
        str(operations_root)], check=True)
    subprocess.run(["docker", "image", "inspect", image], check=True,
                   stdout=subprocess.DEVNULL)
    print("Built {} from local Operations sources.".format(image))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
