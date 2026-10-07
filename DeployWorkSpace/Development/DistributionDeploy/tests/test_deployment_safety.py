import json
import importlib.util
import os
import shlex
import sys
import tempfile
import unittest
import asyncio
import zipfile
from unittest.mock import AsyncMock, Mock, patch
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from archive_fixtures import write_manifested_archive
from workstates.unzipDistribution_state import unzipDistribution_state
from workthreads.DistributionDeployThread import DistributionDeployThread
from workstates.createDeployFolder_state import createDeployFolder_state
from workstates.stopLocalSystem_state import stopLocalSystem_state
from workstates.programFpgaRam_state import programFpgaRam_state
from workstates.setupIonbeamWeb_state import setupIonbeamWeb_state


class DeploymentGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_uses_incoming_script_and_failure_preserves_installation(self):
        for succeeds in (False, True):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                deploy = root / "IobeamPlatform"
                deploy.mkdir()
                marker = deploy / "old.pyc"
                marker.touch()
                archive = root / "dist_app.zip"
                write_manifested_archive(archive, {
                    "Development/Scripts/manage-local-system.sh": b"#!/bin/bash\n# incoming manager\n",
                    "Development/Scripts/program-fpga-ram.py": b"# helper\n",
                })
                config = SimpleNamespace(Actions=[{"unzipDistribution": {"actionData": {"zip": str(archive)}}}])
                thread = SimpleNamespace(deployRoot=str(deploy), workRoot=str(root), GetStateConfig=lambda _: {})
                state = stopLocalSystem_state(thread)
                state.Config = config

                async def run(command, cwd, verbose):
                    self.assertIn("./Development/Scripts/manage-local-system.sh stop", command)
                    self.assertIn(str(deploy), command)
                    self.assertIn("incoming manager", (Path(cwd) / "Development/Scripts/manage-local-system.sh").read_text())
                    return succeeds

                state.commandAsyncio = AsyncMock(side_effect=run)
                await state.DoWork()
                self.assertEqual(state._success, succeeds)
                self.assertEqual(thread._localSystemStopped, succeeds)
                self.assertTrue(marker.exists())
                self.assertEqual(thread._distributionZip, str(archive))

    async def test_extraction_does_not_clear_prepared_directory_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deploy = root / "IobeamPlatform"
            deploy.mkdir()
            marker = deploy / "prepared-marker"
            marker.touch()
            archive = root / "dist_app.zip"
            archive.touch()
            config = {"actionData": {"zip": str(archive), "dest": "."}}
            thread = SimpleNamespace(deployRoot=str(deploy), workRoot=str(root),
                                     _deployRootPrepared=True, _distributionZip=str(archive),
                                     GetStateConfig=lambda _: config, activateVirtualEnv=lambda: None)
            state = unzipDistribution_state(thread)
            state._run = AsyncMock(return_value=True)
            await state.DoWork()
            self.assertTrue(state._success)
            self.assertTrue(marker.exists())

    async def test_fpga_subprocess_failure_blocks_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in (".venv/bin/python", "Development/Scripts/program-fpga-ram.py", "scan.json"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            thread = SimpleNamespace(deployRoot=str(root), venvDir=".venv", glasgowConfig=str(root / "scan.json"),
                                     _localSystemStopped=True, GetStateConfig=lambda _: {})
            state = programFpgaRam_state(thread)
            state.commandAsyncio = AsyncMock(return_value=False)
            await state.DoWork()
            self.assertFalse(state._success)
            self.assertEqual(shlex.split(state.commandAsyncio.call_args.args[0]), [
                str(root / ".venv/bin/python"),
                str(root / "Development/Scripts/program-fpga-ram.py"),
                "--config", str(root / "scan.json"),
            ])


class DeployRootSafetyTests(unittest.TestCase):
    def test_root_symlink_is_rejected_without_touching_destination(self):
        with tempfile.TemporaryDirectory() as parent:
            outside = Path(parent) / "outside"
            outside.mkdir()
            marker = outside / "keep"
            marker.touch()
            deploy = Path(parent) / "IobeamPlatform"
            deploy.symlink_to(outside, target_is_directory=True)
            self.assertFalse(unzipDistribution_state(None)._prepareDeployRoot(str(deploy)))
            self.assertTrue(marker.exists())

    def test_replaces_root_itself_and_removes_hidden_stale_files(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            deploy.mkdir(mode=0o700)
            (deploy / ".stale.pyc").touch()
            with patch("workstates.unzipDistribution_state.shutil.rmtree", wraps=__import__('shutil').rmtree) as remove:
                self.assertTrue(unzipDistribution_state(None)._prepareDeployRoot(str(deploy)))
                remove.assert_called_once_with(str(deploy))
            self.assertEqual(list(deploy.iterdir()), [])

    def test_deletion_requires_successful_stop(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            deploy.mkdir()
            marker = deploy / "keep"
            marker.touch()
            thread = SimpleNamespace(deployRoot=str(deploy), GetStateConfig=lambda _: {})
            state = createDeployFolder_state(thread)
            asyncio.run(state.DoWork())
            self.assertFalse(state._success)
            self.assertTrue(marker.exists())

    def test_only_named_deployment_root_is_clearable(self):
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot("/"))
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot(str(Path.home())))
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot("/tmp/random"))
        self.assertTrue(unzipDistribution_state._isSafeDeployRoot("/tmp/IobeamPlatform"))

    def test_guarded_clear_does_not_follow_directory_symlinks(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            outside = Path(parent) / "outside"
            deploy.mkdir()
            outside.mkdir()
            marker = outside / "keep.txt"
            marker.write_text("keep")
            (deploy / "link").symlink_to(outside, target_is_directory=True)

            state = unzipDistribution_state(None)
            self.assertTrue(state._prepareDeployRoot(str(deploy)))
            self.assertTrue(marker.exists())
            self.assertFalse((deploy / "link").exists())

    def test_all_extracted_shell_scripts_become_executable(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            scripts = deploy / "nested"
            scripts.mkdir(parents=True)
            shell_script = scripts / "runtime.sh"
            shell_script.write_text("#!/usr/bin/env bash\n")
            shell_script.chmod(0o644)
            ordinary_file = scripts / "settings.json"
            ordinary_file.write_text("{}")
            ordinary_file.chmod(0o644)

            state = unzipDistribution_state(None)
            self.assertEqual(state._makeShellScriptsExecutable(str(deploy)), 1)
            self.assertTrue(shell_script.stat().st_mode & 0o111)
            self.assertFalse(ordinary_file.stat().st_mode & 0o111)


class WorkflowContractTests(unittest.TestCase):
    def tearDown(self):
        try:
            (ROOT / "deployment-test.log").unlink()
        except FileNotFoundError:
            pass

    def config(self, actions):
        return SimpleNamespace(
            Actions=actions,
            Deployment={"WorkRoot": str(ROOT), "DeployRoot": "/tmp/IobeamPlatform"},
            LogName="deployment-test",
        )

    def test_missing_workstate_fails_queue_construction(self):
        thread = DistributionDeployThread(self.config([
            {"doesNotExist": {"skip": False, "transactionComplete": False}},
        ]))
        self.assertIsNone(thread.IntialWork())
        self.assertEqual(thread._workflowError, "missing workstate: doesNotExist")
        self.assertFalse(thread._workflowSucceeded)

    def test_skip_is_honored_in_production(self):
        config = self.config([
            {"doesNotExist": {"skip": True, "transactionComplete": False}},
        ])
        config.Deployment["IsProduction"] = True
        thread = DistributionDeployThread(config)
        self.assertIsNone(thread.IntialWork())
        self.assertIsNone(thread._workflowError)
        self.assertTrue(thread._workflowSucceeded)

    def test_config_uses_systemd_manager_not_detached_launches(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        actions = {name: cfg for item in payload["Actions"] for name, cfg in item.items()}
        self.assertFalse(actions["manageLocalSystem"]["skip"])
        self.assertFalse(actions["setupGlasgow"]["skip"])
        self.assertTrue(actions["programFpgaRam"]["skip"])
        for legacy in (
            "launchGlasgowService",
            "verifyGlasgowService",
            "launchIonbeamWebBackend",
            "launchIonbeamWebFrontend",
        ):
            self.assertTrue(actions[legacy]["skip"])

    def test_web_setup_installs_and_builds_backend_and_frontend(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        actions = {name: cfg for item in payload["Actions"] for name, cfg in item.items()}
        action_data = actions["setupIonbeamWeb"]["actionData"]
        self.assertTrue(action_data["npmBuild"])
        commands = setupIonbeamWeb_state._projectCommands(
            "/deploy/backend",
            "/deploy/frontend",
            action_data["npmInstall"],
            action_data["npmBuild"],
            backendBuildCommand=action_data["backendBuildCommand"],
            frontendBuildCommand=action_data["frontendBuildCommand"],
        )
        self.assertEqual(commands, [
            ("backend-install", "/deploy/backend", "npm install"),
            ("frontend-install", "/deploy/frontend", "npm install"),
            ("backend-build", "/deploy/backend", "npm run build"),
            ("frontend-build", "/deploy/frontend", "npm run build"),
        ])

    def test_generated_backend_env_uses_deployed_vacuum_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            backend = root / "Development/ionbeam-web/backend"
            backend.mkdir(parents=True)
            state = setupIonbeamWeb_state(SimpleNamespace(deployRoot=str(root)))
            state._readAdminDbConfig = Mock(return_value={})
            state._writeBackendEnv(str(backend / ".env"), str(backend), {})
            env = dict(line.split("=", 1) for line in (backend / ".env").read_text().splitlines() if "=" in line)
            self.assertEqual(env["SBC_VACUUM_CONFIG"], str(root / "Development/GlasgowDataIO/Json/vacuumSystem.json"))
            self.assertEqual(env["VACUUM_CONTROLLER_URL"], "http://127.0.0.1:8780")

    def test_stop_gate_cannot_be_skipped_or_reused(self):
        for flag in ("skip", "transactionComplete"):
            payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
            next(a["stopLocalSystem"] for a in payload["Actions"]
                 if "stopLocalSystem" in a)[flag] = True
            thread = DistributionDeployThread(self.config(payload["Actions"]))
            self.assertIsNone(thread.IntialWork())
            self.assertIsNotNone(thread._workflowError)

    def test_fpga_gate_can_be_explicitly_skipped_without_hardware(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        next(a["programFpgaRam"] for a in payload["Actions"]
             if "programFpgaRam" in a)["skip"] = True
        thread = DistributionDeployThread(self.config(payload["Actions"]))
        self.assertIsNotNone(thread.IntialWork())
        self.assertIsNone(thread._workflowError)

    def test_failure_aborts_before_next_state(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        thread = DistributionDeployThread(self.config(payload["Actions"]))
        state = thread.IntialWork()
        self.assertIsInstance(state, stopLocalSystem_state)
        self.assertIsNone(thread.StateFactory(state))
        self.assertFalse(thread._workflowSucceeded)

    def test_fpga_precedes_remaining_installation_and_restart(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        names = [name for action in payload["Actions"] for name in action]
        self.assertEqual(names[:4], ["stopLocalSystem", "provisionSecrets", "createDeployFolder", "unzipDistribution"])
        for prerequisite in ("installPipRequirements", "installToolchain", "setupGlasgow"):
            self.assertLess(names.index(prerequisite), names.index("programFpgaRam"))
        for remaining in ("installPostgreSQL", "setupIonbeamWeb", "manageLocalSystem"):
            self.assertLess(names.index("programFpgaRam"), names.index(remaining))

    def test_every_enabled_action_has_an_importable_workstate(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        config = self.config(payload["Actions"])
        thread = DistributionDeployThread(config)
        first = thread.IntialWork()
        self.assertIsNotNone(first)
        self.assertIsNone(thread._workflowError)

    def test_builder_packages_system_manager_and_templates(self):
        builder_path = ROOT.parents[2] / "buildCompiledDist.py"
        spec = importlib.util.spec_from_file_location("distribution_builder", builder_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIn("Scripts", module.COPY_TREES)
        self.assertIn("*.service.in", module.ASSET_PATTERNS)
        self.assertIn("*.env.in", module.ASSET_PATTERNS)
        self.assertIn("*.rules", module.ASSET_PATTERNS)

    def test_builder_makes_every_shell_script_executable(self):
        builder_path = ROOT.parents[2] / "buildCompiledDist.py"
        spec = importlib.util.spec_from_file_location("distribution_builder", builder_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            first = root / "first.sh"
            second = root / "nested" / "second.sh"
            second.parent.mkdir()
            first.write_text("#!/bin/sh\n")
            second.write_text("#!/bin/sh\n")
            first.chmod(0o644)
            second.chmod(0o600)

            self.assertEqual(module.make_shell_scripts_executable(str(root)), 2)
            self.assertTrue(first.stat().st_mode & 0o111)
            self.assertTrue(second.stat().st_mode & 0o111)

    def test_builder_prefers_development_scripts_over_stale_workspace_scripts(self):
        builder_path = ROOT.parents[2] / "buildCompiledDist.py"
        spec = importlib.util.spec_from_file_location("distribution_builder", builder_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / "Scripts"
            fresh = root / "Development/Scripts"
            old.mkdir()
            fresh.mkdir(parents=True)
            (old / "manage-local-system.sh").write_text("stale")
            (fresh / "manage-local-system.sh").write_text("fresh")
            (fresh / "program-fpga-ram.py").write_text("programmer")
            output = root / "out"
            module.copy_source_trees(str(root), str(output), ["Scripts"])
            self.assertEqual((output / "Development/Scripts/manage-local-system.sh").read_text(), "fresh")
            module.validate_packaged_local_system_manager(str(output))


if __name__ == "__main__":
    unittest.main()
