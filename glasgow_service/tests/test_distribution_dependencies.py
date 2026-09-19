import importlib.util
import json
import marshal
import py_compile
import zipfile
from pathlib import Path

import pytest


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
    required = {"gpiozero", "httpx", "redis"}
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

    assert {"gpiozero", "httpx", "redis"} <= set(install_action["actionData"]["verifyImports"])


def test_distribution_installs_raspberry_pi_gpio_os_runtime_conditionally():
    config_path = (
        DEVELOPMENT_ROOT
        / "DeployWorkSpace"
        / "Development"
        / "DistributionDeploy"
        / "Json"
        / "DistributionDeploy.json"
    )
    config = json.loads(config_path.read_text())
    action = next(
        item["installSbcGpioRuntime"]
        for item in config["Actions"]
        if "installSbcGpioRuntime" in item
    )["actionData"]

    assert action["requireRaspberryPi"] is True
    assert action["aptPackages"] == ["python3-gpiozero", "python3-lgpio"]
    assert action["verifyImports"] == ["gpiozero", "lgpio"]


def isolated_builder(monkeypatch, tmp_path):
    builder = load_distribution_builder()
    # Exercise real compilation, directory traversal and archive production;
    # omit unrelated web/assets/dependency requirements from the tiny fixture.
    for name in ("validate_glasgow_runtime_dependencies",
                 "validate_local_redis_distribution_workflow",
                 "copy_source_trees", "copy_preserved_files",
                 "copy_matching_assets", "validate_packaged_local_system_manager",
                 "validate_dist_contents", "write_dist_manifest",
                 "verify_built_archive"):
        monkeypatch.setattr(builder, name, lambda *args, **kwargs: None)
    monkeypatch.chdir(tmp_path)
    source = tmp_path / "source"
    source.mkdir()
    return builder, source


def test_compiled_archive_uses_source_not_stale_or_orphan_caches(monkeypatch, tmp_path):
    builder, source = isolated_builder(monkeypatch, tmp_path)
    (source / "controller.py").write_text("ADC_FSM = True\n")
    cache = source / "__pycache__"
    cache.mkdir()
    stale = tmp_path / "old.py"
    stale.write_text("ADC_FSM = False\n")
    for tag in ("310", "313", "999"):
        py_compile.compile(str(stale), cfile=str(cache / f"controller.cpython-{tag}.pyc"))
    py_compile.compile(str(stale), cfile=str(cache / "deleted.cpython-313.pyc"))
    builder.build_compiled_dist(str(source), str(tmp_path / "dist"))
    with zipfile.ZipFile(tmp_path / "dist_app.zip") as archive:
        assert archive.namelist() == ["controller.pyc"]
        namespace = {}
        exec(marshal.loads(archive.read("controller.pyc")[16:]), namespace)
        assert namespace["ADC_FSM"] is True


def test_compile_failure_stops_archive_instead_of_shipping_old_bytecode(monkeypatch, tmp_path):
    builder, source = isolated_builder(monkeypatch, tmp_path)
    module = source / "controller.py"
    module.write_text("ADC_FSM = True\n")
    py_compile.compile(str(module), doraise=True)
    module.write_text("def broken(:\n")
    with pytest.raises(py_compile.PyCompileError):
        builder.build_compiled_dist(str(source), str(tmp_path / "dist"))
    assert not (tmp_path / "dist_app.zip").exists()
