"""Build the parallel Docker distribution and final DeployWorkSpace archive."""
import argparse
import importlib.util
import os
import sys


def _load_base_builder():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "buidCompiledDist.py")
    spec = importlib.util.spec_from_file_location("base_distribution_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Build Docker distribution package.")
    parser.add_argument("-r", "--raw", action="store_true")
    args = parser.parse_args()
    builder = _load_base_builder()
    zip_name = "dist_app_docker_raw" if args.raw else "dist_app_docker"
    app = os.path.join("Development", "DeployWorkSpace", "Development",
                       "DistributionDeploy", "distributionDeployApp-docker.py")
    builder.build_compiled_dist(
        ".", "./dist_app_docker", deliver_raw=args.raw,
        archive_name=zip_name, preserved_python_files=(app,))
    deploy_dir = os.path.join(".", "Development", "DeployWorkSpace",
                              "Development", "DistributionDeploy")
    workspace_dir = os.path.join(".", "Development", "DeployWorkSpace")
    # Preserve executable entrypoints in the outer handoff ZIP as well as the
    # inner application archive.
    builder.make_shell_scripts_executable(workspace_dir)
    label = builder.version_label_from_stream_data(".")
    archive_base = "DeployWorkspace_Docker_{}_{}".format(
        label, builder.timestamp_label())
    final_archive = builder.post_build_deploy(
        zip_name, deploy_dir, workspace_dir, archive_base)
    print("Final Docker handoff archive: {}".format(final_archive))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print("Docker build failed: {}".format(exc), file=sys.stderr)
        raise SystemExit(1)
