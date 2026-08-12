import json
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workstates.unzipDistribution_state import unzipDistribution_state
from workthreads.DistributionDeployThread import DistributionDeployThread


class DeployRootSafetyTests(unittest.TestCase):
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
        for legacy in (
            "launchGlasgowService",
            "verifyGlasgowService",
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

    def test_builder_packages_system_manager_and_templates(self):
        builder_path = ROOT.parents[2] / "buidCompiledDist.py"
        spec = importlib.util.spec_from_file_location("distribution_builder", builder_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertIn("Scripts", module.COPY_TREES)
        self.assertIn("*.service.in", module.ASSET_PATTERNS)
        self.assertIn("*.env.in", module.ASSET_PATTERNS)


if __name__ == "__main__":
    unittest.main()
