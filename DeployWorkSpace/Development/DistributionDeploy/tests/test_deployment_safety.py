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

from workstates.unzipDistribution_state import unzipDistribution_state
from workstates.createDeployFolder_state import createDeployFolder_state
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
