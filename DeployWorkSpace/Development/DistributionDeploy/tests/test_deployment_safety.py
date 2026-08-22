import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workstates.exportEnv_state import exportEnv_state
from workstates.unzipDistribution_state import unzipDistribution_state
from workstates.createDeployFolder_state import createDeployFolder_state
from workstates.manageLocalSystem_state import manageLocalSystem_state
from workthreads.DistributionDeployThread import DistributionDeployThread


class DeployRootSafetyTests(unittest.TestCase):
    def test_only_named_deployment_root_is_clearable(self):
        driveRoot = Path(Path.cwd().anchor)
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot(str(driveRoot)))
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot(str(Path.home())))
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot(
            str(Path(tempfile.gettempdir()) / "random")))
        self.assertTrue(unzipDistribution_state._isSafeDeployRoot(
            str(Path(tempfile.gettempdir()) / "IobeamPlatform")))

    def test_guarded_clear_does_not_follow_directory_links(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            outside = Path(parent) / "outside"
            deploy.mkdir()
            outside.mkdir()
            marker = outside / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            try:
                (deploy / "link").symlink_to(outside, target_is_directory=True)
            except OSError as exc:
                self.skipTest("Windows symbolic-link privilege unavailable: {}".format(exc))

            state = unzipDistribution_state(None)
            self.assertTrue(state._prepareDeployRoot(str(deploy)))
            self.assertTrue(marker.exists())
            self.assertFalse((deploy / "link").exists())


class DeployRootLifecycleTests(unittest.TestCase):
    def test_running_stack_is_stopped_before_deploy_root_is_cleared(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            deploy.mkdir()
            parentThread = SimpleNamespace(
                deployRoot=str(deploy),
                GetStateConfig=lambda _state: {"timeout": 30.0},
            )
            state = createDeployFolder_state(parentThread)

            events = []

            async def stopStack(_deployRoot, _timeout):
                events.append("stop")
                return True

            def clearDeployRoot(_deployRoot):
                events.append("clear")
                return True

            with mock.patch.object(
                state,
                "_stopManagedWindowsStack",
                side_effect=stopStack,
            ), mock.patch.object(
                unzipDistribution_state,
                "_prepareDeployRoot",
                side_effect=clearDeployRoot,
            ):
                asyncio.run(state.DoWork())

            self.assertEqual(events, ["stop", "clear"])
            self.assertTrue(state.Success)


class LocalSystemManagerTests(unittest.TestCase):
    def test_windows_manager_runs_sample_stage_controller(self):
        manager = (ROOT.parents[2] / "Scripts" / "manage-local-system.ps1").read_text()

        self.assertIn('$env:SAMPLE_STAGE_CONFIG', manager)
        self.assertIn('$env:SAMPLE_STAGE_STATE', manager)
        self.assertIn('Start-Managed "sample-stage"', manager)
        self.assertIn('glasgow_service.sample_stage_app:app', manager)
        self.assertIn('http://127.0.0.1:8790/status', manager)

    def test_manager_output_uses_file_instead_of_asyncio_pipes(self):
        with tempfile.TemporaryDirectory() as parent:
            deploy = Path(parent) / "IobeamPlatform"
            deploy.mkdir()
            parentThread = SimpleNamespace(deployRoot=str(deploy))
            state = manageLocalSystem_state(parentThread)
            fakeProcess = SimpleNamespace(
                returncode=0,
                pid=123,
                wait=mock.AsyncMock(return_value=0),
            )
            args = ["powershell.exe", "-NoProfile", "stop"]

            launcher = mock.AsyncMock(return_value=fakeProcess)
            with mock.patch(
                "workstates.manageLocalSystem_state.asyncio.create_subprocess_exec",
                new=launcher,
            ):
                success = asyncio.run(state._runManager(args, timeout=1.0))

            self.assertTrue(success)
            kwargs = launcher.await_args.kwargs
            self.assertIsNot(kwargs["stdout"], asyncio.subprocess.PIPE)
            self.assertEqual(kwargs["stderr"], asyncio.subprocess.STDOUT)
            self.assertTrue((deploy / "Logs" / "manage-local-system.log").is_file())


class ExportEnvironmentTests(unittest.TestCase):
    def test_stale_values_are_removed_before_exports_are_written(self):
        parentThread = SimpleNamespace(
            GetStateConfig=lambda _state: {
                "actionData": {
                    "remove": ["IOBEAM_TEST_STALE"],
                    "exports": {"IOBEAM_TEST_KEEP": "C:\\fresh"},
                },
            },
        )
        state = exportEnv_state(parentThread)
        registryKey = mock.MagicMock()
        registryContext = mock.MagicMock()
        registryContext.__enter__.return_value = registryKey

        with mock.patch.dict(
            os.environ,
            {"IOBEAM_TEST_STALE": "old"},
            clear=False,
        ), mock.patch(
            "workstates.exportEnv_state.winreg.CreateKey",
            return_value=registryContext,
        ), mock.patch(
            "workstates.exportEnv_state.winreg.DeleteValue",
        ) as deleteValue, mock.patch(
            "workstates.exportEnv_state.winreg.SetValueEx",
        ) as setValue:
            asyncio.run(state.DoWork())
            self.assertNotIn("IOBEAM_TEST_STALE", os.environ)
            self.assertEqual(os.environ["IOBEAM_TEST_KEEP"], "C:\\fresh")

        deleteValue.assert_called_once_with(registryKey, "IOBEAM_TEST_STALE")
        self.assertEqual(setValue.call_args.args[-1], "C:\\fresh")
        self.assertTrue(state.Success)


class WorkflowContractTests(unittest.TestCase):
    def tearDown(self):
        try:
            (ROOT / "deployment-test.log").unlink()
        except FileNotFoundError:
            pass

    def config(self, actions):
        return SimpleNamespace(
            Actions=actions,
            Deployment={
                "WorkRoot": str(ROOT),
                "DeployRoot": str(Path(tempfile.gettempdir()) / "IobeamPlatform"),
            },
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

    def test_config_uses_windows_manager_not_detached_launches(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        actions = {name: cfg for item in payload["Actions"] for name, cfg in item.items()}
        self.assertFalse(actions["manageLocalSystem"]["skip"])
        for legacy in (
            "launchGlasgowService",
            "launchIonbeamWebBackend",
            "launchIonbeamWebFrontend",
        ):
            self.assertTrue(actions[legacy]["skip"])

    def test_admin_environment_is_cleared_for_backend_dotenv(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        actions = {name: cfg for item in payload["Actions"] for name, cfg in item.items()}
        actionData = actions["exportEnv"]["actionData"]
        removals = set(actionData["remove"])

        self.assertIn("IOBEAM_ADMIN_CONFIG", removals)
        self.assertIn("IOBEAM_ADMIN_DB_CONFIG", removals)
        self.assertIn("IOBEAM_ADMIN_DB_HOST", removals)
        self.assertFalse(
            any(name.startswith("IOBEAM_ADMIN_")
                for name in actionData["exports"])
        )

    def test_every_enabled_action_has_an_importable_workstate(self):
        payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
        config = self.config(payload["Actions"])
        thread = DistributionDeployThread(config)
        first = thread.IntialWork()
        self.assertIsNotNone(first)
        self.assertIsNone(thread._workflowError)

    def test_builder_packages_windows_manager_and_scripts(self):
        builder_path = ROOT.parents[2] / "buidCompiledDist.py"
        spec = importlib.util.spec_from_file_location(
            "distribution_builder", builder_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        expected = ("Scripts", os.path.join("Development", "Scripts"))
        self.assertIn(expected, module.COPY_TREES)
        self.assertIn("*.ps1", module.ASSET_PATTERNS)
        self.assertNotIn("*.service.in", module.ASSET_PATTERNS)


if __name__ == "__main__":
    unittest.main()
