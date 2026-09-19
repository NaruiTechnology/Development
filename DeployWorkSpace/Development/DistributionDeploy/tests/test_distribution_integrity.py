"""End-to-end tests for the consolidated build -> verify -> deploy chain.

They run the real ``buidCompiledDist.main`` on a small but realistic workspace
(real builder, real manifest module, real workflow JSON, stub application
modules) from different working directories, then attack the resulting archive
in every way the deploy-side verifier must catch.
"""
import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]                # .../DistributionDeploy
DEVELOPMENT = ROOT.parents[2]                             # repository root
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import distributionManifest                                # noqa: E402
from archive_fixtures import write_manifested_archive      # noqa: E402
from workstates.stopLocalSystem_state import stopLocalSystem_state          # noqa: E402
from workstates.unzipDistribution_state import unzipDistribution_state      # noqa: E402
from workstates.verifyDistribution_state import verifyDistribution_state    # noqa: E402
from workthreads.DistributionDeployThread import DistributionDeployThread   # noqa: E402

BUILDER_SOURCE = DEVELOPMENT / "buidCompiledDist.py"
SLOT = Path("Development/DeployWorkSpace/Development/DistributionDeploy")


def load_builder(path):
    spec = importlib.util.spec_from_file_location("builder_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_workspace(base):
    """A minimal workspace that satisfies every builder validation."""
    ws = Path(base) / "workspace"
    dev = ws / "Development"
    real = {   # small real files the builder's own validators read
        "glasgow_service/requirements.txt": DEVELOPMENT / "glasgow_service/requirements.txt",
        "glasgow_service/pyproject.toml": DEVELOPMENT / "glasgow_service/pyproject.toml",
        "glasgow_service/deploy/setup-redis-sentinel.sh": DEVELOPMENT / "glasgow_service/deploy/setup-redis-sentinel.sh",
        "requirements.txt": DEVELOPMENT / "requirements.txt",
        "buidCompiledDist.py": BUILDER_SOURCE,
    }
    for rel, src in real.items():
        (dev / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dev / rel)
    slot = dev / "DeployWorkSpace/Development/DistributionDeploy"
    for rel in ("Json/DistributionDeploy.json", "workstates/installRedisSentinel_state.py",
                "distributionManifest.py"):
        (slot / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, slot / rel)
    stubs = {
        "GlasgowDataIO/Json/streamData.json": '{"Version": "0.8.0"}',
        "GlasgowDataIO/IobeamControl/IobeamLauncher.py": "LAUNCHER = 1\n",
        "GlasgowDataIO/IobeamControl/applet/busController.py": "ADC_FSM = True\n",
        "GlasgowDataIO/IobeamControl/applet/upstreamBusController.py": "UPSTREAM = True\n",
        "GlasgowDataIO/IobeamControl/applet/adcTiming.py": "TIMING = 1\n",
        "GlasgowDataIO/IobeamControl/applet/iobeamDataSubtarget.py": "SUBTARGET = 1\n",
        "GlasgowDataIO/IobeamControl/applet/commandExecutor.py": "EXECUTOR = 1\n",
        "glasgow_service/glasgow_service/service.py": "SERVICE = 1\n",
        "Scripts/manage-local-system.sh": "#!/bin/sh\n",
        "Scripts/program-fpga-ram.py": "# programmer\n",
        "ionbeam-web/backend/package.json": '{"name": "backend"}',
    }
    for rel, text in stubs.items():
        (dev / rel).parent.mkdir(parents=True, exist_ok=True)
        (dev / rel).write_text(text)
    unrelated = ws / "Unrelated"
    unrelated.mkdir()
    (unrelated / "secret.py").write_text("SECRET = 1\n")
    return ws, dev / "buidCompiledDist.py"


class BuilderEndToEndTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ws, self.script = make_workspace(self._tmp.name)
        self.builder = load_builder(self.script)
        self.other_cwd = Path(self._tmp.name) / "elsewhere"
        self.other_cwd.mkdir()
        self.cwd = os.getcwd()
        self.addCleanup(os.chdir, self.cwd)

    def build(self, cwd, *args):
        os.chdir(cwd)
        with patch("sys.stdout"):
            return self.builder.main(list(args), script_path=str(self.script))

    def archive(self, name="dist_app.zip"):
        return self.ws / SLOT / name

    def test_build_is_independent_of_the_working_directory(self):
        # The historical failure: launched from inside Development/, the build
        # exited 0 but dropped streamData.json and wrote to a stray folder.
        listings = []
        for cwd in (self.ws, self.ws / "Development", self.other_cwd):
            self.assertEqual(self.build(cwd), 0, cwd)
            with zipfile.ZipFile(self.archive()) as z:
                listings.append(sorted(z.namelist()))
            self.assertFalse((self.ws / "Development/Development").exists(), cwd)
            self.assertEqual(list(cwd.glob("dist_app.zip")), [])
        self.assertEqual(listings[0], listings[1])
        self.assertEqual(listings[0], listings[2])
        self.assertIn("Development/GlasgowDataIO/Json/streamData.json", listings[0])
        self.assertIn("dist_manifest.json", listings[0])

    def test_unrelated_sibling_directories_are_not_packaged(self):
        self.assertEqual(self.build(self.ws), 0)
        with zipfile.ZipFile(self.archive()) as z:
            self.assertFalse([n for n in z.namelist() if "Unrelated" in n or "secret" in n])

    def test_archive_is_verified_and_manifest_is_accurate(self):
        self.assertEqual(self.build(self.ws), 0)
        manifest = distributionManifest.verify_zip(self.archive())
        self.assertTrue(manifest["compiled"])
        self.assertEqual(manifest["python"]["magic"], importlib.util.MAGIC_NUMBER.hex())
        self.assertEqual(manifest["version"], "0.8.0")
        pyc = "Development/GlasgowDataIO/IobeamControl/applet/busController.pyc"
        self.assertIn(pyc, manifest["required"])
        source = (self.ws / "Development/GlasgowDataIO/IobeamControl/applet/busController.py").read_bytes()
        self.assertEqual(manifest["files"][pyc]["source_sha256"],
                         distributionManifest.sha256_bytes(source))

    def test_missing_required_input_fails_loudly_and_leaves_no_archive(self):
        (self.ws / "Development/GlasgowDataIO/Json/streamData.json").unlink()
        self.assertEqual(self.build(self.ws), 1)
        self.assertFalse(self.archive().exists())
        self.assertEqual(list(self.ws.glob("dist_app*.zip")), [])

    def test_previous_archive_survives_a_build_with_no_new_output(self):
        slot = self.ws / SLOT
        (slot / "dist_app.zip").write_bytes(b"last good archive")
        os.chdir(self.ws)
        with self.assertRaises(FileNotFoundError):
            self.builder.post_build_deploy("dist_app", str(slot), str(self.ws / "Development/DeployWorkSpace"))
        self.assertEqual((slot / "dist_app.zip").read_bytes(), b"last good archive")

    def test_raw_build_does_not_depend_on_the_interpreter(self):
        self.assertEqual(self.build(self.ws, "--raw"), 0)
        foreign = b"\x00\x00\x00\x00"
        manifest = distributionManifest.verify_zip(self.archive("dist_app_raw.zip"), magic=foreign)
        self.assertFalse(manifest["compiled"])

    def test_verify_option_reports_good_and_tampered_archives(self):
        self.assertEqual(self.build(self.ws), 0)
        good = str(self.archive())
        self.assertEqual(self.build(self.ws, "--verify", good), 0)
        bad = self.other_cwd / "tampered.zip"
        rewrite(good, bad, {"Development/GlasgowDataIO/Json/streamData.json": b'{"Version": "9"}'})
        self.assertEqual(self.build(self.ws, "--verify", str(bad)), 1)

    def test_script_outside_a_development_directory_is_rejected(self):
        with self.assertRaises(RuntimeError):
            self.builder.resolve_workspace(str(Path(self._tmp.name) / "notdev" / "buidCompiledDist.py"))


def rewrite(source, target, replace=None, drop=(), add=None):
    """Copy a zip, optionally changing, dropping or adding members."""
    replace, add = replace or {}, add or {}
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w") as out:
        for item in src.infolist():
            if item.filename in drop:
                continue
            out.writestr(item.filename, replace.get(item.filename, src.read(item.filename)))
        for name, data in add.items():
            out.writestr(name, data)


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.members = {"Development/a.pyc": b"alpha", "Development/b.json": b"{}"}
        self.good = self.dir / "good.zip"
        write_manifested_archive(self.good, self.members, compiled=True,
                                 python=distributionManifest.python_identity(),
                                 required=["Development/a.pyc"])

    def variant(self, **kwargs):
        target = self.dir / "variant.zip"
        rewrite(self.good, target, **kwargs)
        return target

    def assertRejected(self, path, fragment, **kwargs):
        with self.assertRaises(distributionManifest.ManifestError) as caught:
            distributionManifest.verify_zip(path, **kwargs)
        self.assertIn(fragment, str(caught.exception))

    def test_good_archive_passes(self):
        self.assertTrue(distributionManifest.verify_zip(self.good)["compiled"])

    def test_changed_member_is_detected(self):
        self.assertRejected(self.variant(replace={"Development/a.pyc": b"ALPHA"}),
                            "content differs from manifest")

    def test_same_length_change_is_detected(self):
        self.assertRejected(self.variant(replace={"Development/b.json": b"[]"}),
                            "content differs from manifest")

    def test_missing_member_is_detected(self):
        self.assertRejected(self.variant(drop=("Development/b.json",)), "missing from archive")

    def test_unlisted_member_is_detected(self):
        self.assertRejected(self.variant(add={"Development/extra.pyc": b"x"}), "not in manifest")

    def test_missing_manifest_is_detected(self):
        self.assertRejected(self.variant(drop=(distributionManifest.MANIFEST_NAME,)),
                            "no dist_manifest.json")

    def test_required_member_that_is_absent_is_detected(self):
        target = self.dir / "req.zip"
        write_manifested_archive(target, self.members, required=["Development/needed.pyc"])
        self.assertRejected(target, "required member(s) absent")

    def test_bytecode_from_another_interpreter_is_rejected_with_advice(self):
        self.assertRejected(self.good, "Rebuild the distribution", magic=b"\x00\x00\x00\x00")

    def test_path_traversal_member_is_rejected(self):
        target = self.dir / "evil.zip"
        write_manifested_archive(target, {"../evil.pyc": b"x"})
        self.assertRejected(target, "unsafe archive member")

    def test_corrupt_or_missing_file_is_a_clean_error(self):
        bad = self.dir / "notzip.zip"
        bad.write_bytes(b"not a zip at all")
        self.assertRejected(bad, "cannot open archive")
        self.assertRejected(self.dir / "absent.zip", "cannot open archive")


class ArchiveSelectionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def touch(self, *names):
        for name in names:
            (self.dir / name).write_bytes(b"z")

    def find(self, preferred):
        return unzipDistribution_state._findZipFile(str(self.dir), preferred)

    def test_single_glob_or_exact_match_is_returned(self):
        self.touch("dist_app.zip")
        self.assertEqual(self.find("dist_app*.zip"), str(self.dir / "dist_app.zip"))
        self.assertEqual(self.find("dist_app.zip"), str(self.dir / "dist_app.zip"))

    def test_no_match_is_none_not_the_newest_unrelated_zip(self):
        self.touch("something_else.zip", "old_backup.zip")
        self.assertIsNone(self.find("dist_app*.zip"))
        self.assertIsNone(self.find("dist_app.zip"))

    def test_ambiguous_match_is_an_error_never_a_guess(self):
        self.touch("dist_app.zip", "dist_app_raw.zip")
        with self.assertRaises(ValueError) as caught:
            self.find("dist_app*.zip")
        self.assertIn("ambiguous", str(caught.exception))

    def test_directory_hint_needs_exactly_one_zip(self):
        self.touch("only.zip")
        self.assertEqual(self.find(""), str(self.dir / "only.zip"))
        self.touch("second.zip")
        with self.assertRaises(ValueError):
            self.find("")


class StopGateVerificationTests(unittest.IsolatedAsyncioTestCase):
    """The archive is judged BEFORE anything is stopped or deleted."""

    MEMBERS = {
        "Development/Scripts/manage-local-system.sh": b"#!/bin/bash\n# incoming\n",
        "Development/Scripts/program-fpga-ram.py": b"# helper\n",
    }

    async def run_stop(self, prepare, deployment=None, glob=False):
        """Run the stop gate; returns (state, thread, install_survived)."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deploy = root / "IobeamPlatform"
            deploy.mkdir()
            marker = deploy / "old.pyc"
            marker.touch()
            archive = root / "dist_app.zip"
            prepare(archive)
            hint = str(root / "dist_app*.zip") if glob else str(archive)
            config = SimpleNamespace(
                Actions=[{"unzipDistribution": {"actionData": {"zip": hint}}}],
                Deployment=deployment if deployment is not None else {})
            thread = SimpleNamespace(deployRoot=str(deploy), workRoot=str(root),
                                     GetStateConfig=lambda _: {})
            state = stopLocalSystem_state(thread)
            state.Config = config
            state.commandAsyncio = AsyncMock(return_value=True)
            with patch("builtins.print"):
                await state.DoWork()
            return state, thread, marker.exists()   # evaluated before cleanup

    def valid(self, archive):
        write_manifested_archive(archive, self.MEMBERS)

    async def assertRejectedBeforeStopping(self, prepare, deployment=None, glob=False):
        state, thread, install_survived = await self.run_stop(prepare, deployment, glob)
        self.assertFalse(state._success)
        self.assertFalse(thread._localSystemStopped)
        state.commandAsyncio.assert_not_called()
        self.assertTrue(install_survived)

    async def test_valid_archive_is_accepted_and_pinned(self):
        state, thread, _ = await self.run_stop(self.valid)
        self.assertTrue(state._success)
        state.commandAsyncio.assert_called_once()
        self.assertTrue(thread._distributionZip.endswith("dist_app.zip"))

    async def test_archive_without_manifest_is_rejected(self):
        def legacy(archive):
            with zipfile.ZipFile(archive, "w") as z:
                for name, data in self.MEMBERS.items():
                    z.writestr(name, data)
        await self.assertRejectedBeforeStopping(legacy)

    async def test_tampered_archive_is_rejected(self):
        def tampered(archive):
            self.valid(archive)
            rewrite(archive, archive.with_suffix(".bad"),
                    replace={"Development/Scripts/program-fpga-ram.py": b"# evil\n"})
            archive.with_suffix(".bad").replace(archive)
        await self.assertRejectedBeforeStopping(tampered)

    async def test_bytecode_for_another_interpreter_is_rejected(self):
        def foreign(archive):
            write_manifested_archive(archive, self.MEMBERS, compiled=True,
                                     python={"version": "0.0", "cache_tag": "cpython-000",
                                             "magic": "00000000"})
        await self.assertRejectedBeforeStopping(foreign)

    async def test_ambiguous_archives_are_rejected(self):
        def two(archive):
            self.valid(archive)
            shutil.copy(archive, archive.with_name("dist_app_raw.zip"))
        await self.assertRejectedBeforeStopping(two, glob=True)

    async def test_explicit_opt_out_allows_a_legacy_archive(self):
        def legacy(archive):
            with zipfile.ZipFile(archive, "w") as z:
                for name, data in self.MEMBERS.items():
                    z.writestr(name, data)
        state, _, _ = await self.run_stop(legacy, {"RequireDistributionManifest": False})
        self.assertTrue(state._success)


class PostExtractionVerificationTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, mutate=None, deployment=None, pinned=True):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            deploy = root / "IobeamPlatform"
            members = {"Development/a.pyc": b"alpha", "Development/sub/b.json": b"{}"}
            archive = root / "dist_app.zip"
            manifest = write_manifested_archive(archive, members)
            for name, data in members.items():
                target = deploy / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            (deploy / distributionManifest.MANIFEST_NAME).write_text(
                json.dumps(manifest, sort_keys=True))
            if mutate:
                mutate(deploy)
            thread = SimpleNamespace(deployRoot=str(deploy), workRoot=str(root))
            if pinned:
                thread._distributionZip = str(archive)
            state = verifyDistribution_state(thread)
            state.Config = SimpleNamespace(Deployment=deployment or {})
            with patch("builtins.print"):
                await state.DoWork()
            return state._success

    async def test_intact_tree_passes(self):
        self.assertTrue(await self.check())

    async def test_modified_file_fails(self):
        self.assertFalse(await self.check(lambda d: (d / "Development/a.pyc").write_bytes(b"ALPHA")))

    async def test_missing_file_fails(self):
        self.assertFalse(await self.check(lambda d: (d / "Development/sub/b.json").unlink()))

    async def test_manifest_that_differs_from_the_verified_archive_fails(self):
        def swap(deploy):
            path = deploy / distributionManifest.MANIFEST_NAME
            data = json.loads(path.read_text())
            data["version"] = "different"
            path.write_text(json.dumps(data, sort_keys=True))
        self.assertFalse(await self.check(swap))

    async def test_missing_manifest_or_pinned_archive_fails(self):
        self.assertFalse(await self.check(lambda d: (d / distributionManifest.MANIFEST_NAME).unlink()))
        self.assertFalse(await self.check(pinned=False))

    async def test_opt_out_skips_with_success(self):
        self.assertTrue(await self.check(lambda d: (d / "Development/a.pyc").write_bytes(b"X"),
                                         deployment={"RequireDistributionManifest": False}))


class WorkflowWiringTests(unittest.TestCase):
    def payload(self):
        return json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())

    def thread(self, actions):
        return DistributionDeployThread(SimpleNamespace(
            Actions=actions, LogName="integrity-test",
            Deployment={"WorkRoot": str(ROOT), "DeployRoot": "/tmp/IobeamPlatform"}))

    def tearDown(self):
        try:
            (ROOT / "integrity-test.log").unlink()
        except FileNotFoundError:
            pass

    def test_verification_directly_follows_extraction_and_manifest_is_required(self):
        data = self.payload()
        names = [n for a in data["Actions"] for n in a]
        self.assertEqual(names[:4], ["stopLocalSystem", "createDeployFolder",
                                     "unzipDistribution", "verifyDistribution"])
        self.assertTrue(data["Deployment"]["RequireDistributionManifest"])

    def test_default_workflow_builds_a_queue(self):
        thread = self.thread(self.payload()["Actions"])
        self.assertIsNotNone(thread.IntialWork())
        self.assertIsNone(thread._workflowError)

    def test_verification_cannot_be_skipped_reused_or_reordered(self):
        for mutate in (
            lambda a: a["verifyDistribution"].__setitem__("skip", True),
            lambda a: a["verifyDistribution"].__setitem__("transactionComplete", True),
        ):
            data = self.payload()
            mutate({n: c for item in data["Actions"] for n, c in item.items()})
            thread = self.thread(data["Actions"])
            self.assertIsNone(thread.IntialWork())
            self.assertIsNotNone(thread._workflowError)
        data = self.payload()
        actions = data["Actions"]
        i = next(k for k, a in enumerate(actions) if "verifyDistribution" in a)
        j = next(k for k, a in enumerate(actions) if "unzipDistribution" in a)
        actions[i], actions[j] = actions[j], actions[i]
        thread = self.thread(actions)
        self.assertIsNone(thread.IntialWork())
        self.assertIn("in order", thread._workflowError)


class AppEntryPointTests(unittest.TestCase):
    def test_default_config_is_found_regardless_of_working_directory(self):
        import distributionDeployApp as app
        seen = {}

        class FakeConfig:
            def __init__(self, path):
                seen["path"] = path
                self.Deployment = {}

        class FakeThread:
            _workflowSucceeded = True
            _workflowError = None
            def __init__(self, config): pass
            def Start(self): pass
            def join(self): pass

        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as elsewhere:
            os.chdir(elsewhere)
            try:
                with patch.object(app, "AutomationConfig", FakeConfig), \
                     patch.object(app, "DistributionDeployThread", FakeThread), \
                     patch.object(app.SudoCredentialKeepalive, "start", lambda self: None), \
                     patch.object(sys, "argv", ["distributionDeployApp.py"]):
                    self.assertEqual(app.main(), 0)
            finally:
                os.chdir(cwd)
        self.assertEqual(Path(seen["path"]), ROOT / "Json" / "DistributionDeploy.json")


if __name__ == "__main__":
    unittest.main()
