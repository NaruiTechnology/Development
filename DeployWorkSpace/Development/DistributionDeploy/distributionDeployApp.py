#-------------------------------------------------------------------------------
# distributionDeployApp.py
#
# Entry point for the project distribution deploy workflow.
# Mirrors LoadFPGAImage/loadFPGAImageApp.py: load a JSON config, hand it to a
# WorkThread, start the thread, and join.
#
# Run from the project root (so 'workstates' and 'workthreads' are importable):
#   py -3 distributionDeployApp.py
#   py -3 distributionDeployApp.py -j ./Json/DistributionDeploy.json
#-------------------------------------------------------------------------------
import gc
import os

from buildingblocks.automation_config import AutomationConfig
from workthreads.DistributionDeployThread import DistributionDeployThread


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Deploy the project distribution onto an Ubuntu host.')
    parser.add_argument(
        '-j', action='store', dest='jsonfile',
        help="Config Json file path",
        default=os.path.realpath(r'./Json/DistributionDeploy.json'))
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

    thread = DistributionDeployThread(config)
    thread.Start()
    thread.join()

    gc.collect()


if __name__ == '__main__':
    main()
