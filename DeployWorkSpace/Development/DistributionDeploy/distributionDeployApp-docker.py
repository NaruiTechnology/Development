"""Cross-platform Docker distribution deployment entry point."""
import gc
import os
import platform
import subprocess
import sys

from buildingblocks.automation_config import AutomationConfig
from workthreads.DistributionDeployThread import DistributionDeployThread


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Deploy the local Glasgow service as a Docker container.")
    parser.add_argument("-j", dest="jsonfile", default=os.path.realpath(
        "./Json/DistributionDeploy-docker.json"))
    parser.add_argument("-r", dest="deployRoot", default=None)
    args = parser.parse_args()
    jsonpath = args.jsonfile
    if not os.path.isfile(jsonpath):
        alt = os.path.realpath(
            "./Development/DistributionDeploy/Json/DistributionDeploy-docker.json")
        if not os.path.isfile(alt):
            raise FileNotFoundError("Docker deployment config not found: {}".format(jsonpath))
        jsonpath = alt

    config = AutomationConfig(jsonpath)
    if args.deployRoot:
        config.Deployment["DeployRoot"] = args.deployRoot

    # Only the first Linux installation needs an authenticated sudo session.
    if platform.system() == "Linux" and subprocess.run(
            ["sh", "-c", "command -v docker"],
            stdout=subprocess.DEVNULL).returncode != 0:
        if subprocess.run(["sudo", "-v"]).returncode != 0:
            print("Docker installation requires sudo access.", file=sys.stderr)
            return 1

    thread = DistributionDeployThread(config)
    thread.Start()
    thread.join()
    gc.collect()
    if not thread._workflowSucceeded:
        print("Docker deployment failed: {}".format(
            thread._workflowError or "workflow did not complete"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
