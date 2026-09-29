#-------------------------------------------------------------------------------
# distributionDeployApp.py
#
# Entry point for the project distribution deploy workflow.
# Mirrors LoadFPGAImage/loadFPGAImageApp.py: load a JSON config, hand it to a
# WorkThread, start the thread, and join.
#
# May be launched from any directory; the default config is resolved next to
# this file, and Python puts this file's directory on sys.path so 'workstates'
# and 'workthreads' import:
#   python3 distributionDeployApp.py
#   python3 distributionDeployApp.py -j ./Json/DistributionDeploy.json
#-------------------------------------------------------------------------------
import gc
import os
import subprocess
import sys
import threading

from buildingblocks.automation_config import AutomationConfig
from workthreads.DistributionDeployThread import DistributionDeployThread


class SudoCredentialKeepalive:
    """Authenticate once in the parent terminal and refresh sudo while deploying."""
    def __init__(self, interval=60.0):
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        print("Deployment requires administrative access; authenticating sudo...")
        result = subprocess.run(["sudo", "-v"])
        if result.returncode != 0:
            raise RuntimeError("sudo authentication failed")
        self._thread = threading.Thread(
            target=self._refresh, name="sudo-credential-keepalive", daemon=True)
        self._thread.start()

    def _refresh(self):
        while not self._stop.wait(self.interval):
            result = subprocess.run(
                ["sudo", "-n", "-v"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
            if result.returncode != 0:
                break

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Deploy the project distribution onto an Ubuntu host.')
    parser.add_argument(
        '-j', action='store', dest='jsonfile',
        help="Config Json file path",
        default=os.path.join(os.path.dirname(os.path.realpath(__file__)),
                             'Json', 'DistributionDeploy.json'))
    parser.add_argument(
        '-r', action='store', dest='deployRoot',
        help="Override the deploy root directory on the target host",
        default=None)
    parser.add_argument(
        '--production', action='store_true', dest='production',
        help="Enable production overrides from the JSON config")
    parser.add_argument(
        '--mobility', action='store_true', dest='mobility',
        help="Deploy the mobility-only frontend variant")
    parser.add_argument('--desktop', action='store_true', help='Install the native desktop scanner before starting local services')
    parser.add_argument('--desktop-artifact', help='Path to desktop .deb (with adjacent .sha256)')

    args = parser.parse_args()
    jsonpath = args.jsonfile

    if not os.path.isfile(jsonpath):
        # Fallback when invoked from inside the DistributionDeploy folder
        alt = os.path.realpath(r'./Development/DistributionDeploy/Json/DistributionDeploy.json')
        if os.path.isfile(alt):
            jsonpath = alt
        else:
            raise FileNotFoundError(
                f"Config JSON not found at '{args.jsonfile}' or '{alt}'.")

    config = AutomationConfig(jsonpath)
    if args.deployRoot is not None:
        # Mutate in place so all states pick up the override
        config.Deployment["DeployRoot"] = args.deployRoot
    if args.production:
        config.Deployment["IsProduction"] = True
    if args.mobility:
        config.Deployment["MobilityOnly"] = True
    if args.desktop:
        if args.production or args.mobility:
            parser.error('--desktop is for a local Linux instrument workstation, not a remote production/mobility host')
        import hashlib
        artifact = os.path.abspath(os.path.expanduser(args.desktop_artifact or os.path.join(
            os.path.dirname(__file__), 'ionbeam-desktop_1.0.0_amd64.deb')))
        if not os.path.isfile(artifact) or not os.path.isfile(artifact + '.sha256'):
            parser.error('Build with --desktop first; desktop .deb and checksum are required')
        with open(artifact + '.sha256') as handle:
            expected = handle.read().split()[0]
        with open(artifact, 'rb') as handle:
            actual = hashlib.file_digest(handle, 'sha256').hexdigest()
        if actual != expected:
            parser.error('Desktop package checksum mismatch')
        config.Deployment['DesktopArtifact'] = artifact
        for index, action in enumerate(config.Actions):
            if 'manageLocalSystem' in action or 'launchGlasgowService' in action:
                config.Actions.insert(index, {'installDesktopScanner': {
                    'skip': False, 'transactionComplete': False, 'actionData': {}, 'timeout': 600}})
                break
        else:
            parser.error('Desktop deployment requires a local service startup action')

    sudo = SudoCredentialKeepalive()
    try:
        sudo.start()
    except (OSError, RuntimeError) as exc:
        print("Deployment cannot start: {}".format(exc), file=sys.stderr)
        return 1

    try:
        thread = DistributionDeployThread(config)
        thread.Start()
        thread.join()
    finally:
        sudo.stop()

    gc.collect()
    if not thread._workflowSucceeded:
        print("Deployment failed: {}".format(
            thread._workflowError or "workflow did not complete"), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
