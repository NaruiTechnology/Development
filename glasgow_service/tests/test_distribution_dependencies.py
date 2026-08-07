import importlib.util
import json
from pathlib import Path


DEVELOPMENT_ROOT = Path(__file__).parents[2]


def load_distribution_builder():
    path = DEVELOPMENT_ROOT / "buidCompiledDist.py"
    spec = importlib.util.spec_from_file_location("iobeam_distribution_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def requirement_names(path):
    names = set()
    for raw_line in path.read_text().splitlines():
        line = raw_line.split("#", 1)[0].strip().lower()
        if not line or line.startswith(("-", "git+")):
            continue
        name = line.split("=", 1)[0].split("<", 1)[0].split(">", 1)[0]
        names.add(name.strip().replace("_", "-"))
    return names


def test_distribution_manifests_include_ha_runtime_clients():
    required = {"httpx", "redis"}
    manifests = [
        DEVELOPMENT_ROOT / "requirements.txt",
        DEVELOPMENT_ROOT / "DeployWorkSpace" / "Development" / "requirements.txt",
        DEVELOPMENT_ROOT / "glasgow_service" / "requirements.txt",
    ]

    for manifest in manifests:
        assert required <= requirement_names(manifest), manifest


def test_archive_builder_validates_glasgow_dependency_metadata():
    builder = load_distribution_builder()

    builder.validate_glasgow_runtime_dependencies(DEVELOPMENT_ROOT)


def test_distribution_deploy_verifies_installed_client_imports():
    config_path = (
        DEVELOPMENT_ROOT
        / "DeployWorkSpace"
        / "Development"
        / "DistributionDeploy"
        / "Json"
        / "DistributionDeploy.json"
    )
    config = json.loads(config_path.read_text())
    install_action = next(
        action["installPipRequirements"]
        for action in config["Actions"]
        if "installPipRequirements" in action
    )

    assert install_action["actionData"]["verifyImports"] == ["httpx", "redis"]
