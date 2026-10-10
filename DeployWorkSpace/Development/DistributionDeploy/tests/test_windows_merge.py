"""Windows command paths and retained Operations deployment safeguards."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
import zipfile

from archive_fixtures import write_manifested_archive
from workstates.stopLocalSystem_state import stopLocalSystem_state
from workstates.programFpgaRam_state import programFpgaRam_state
from workstates.installIonbeamNative_state import installIonbeamNative_state
from workstates.verifyFpgaToolchain_state import verifyFpgaToolchain_state
from workstates.unzipDistribution_state import unzipDistribution_state
from workstates.exportEnv_state import exportEnv_state
from workstates.detachedShellLaunch_state import detachedShellLaunch_state


@unittest.skipUnless(os.name == "nt", "Windows launch contracts")
class WindowsMergeTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_runs_verified_incoming_powershell_and_preserves_installation(self):
        for code in (0, 1):
            with tempfile.TemporaryDirectory(prefix="windows merge ") as temp:
                root = Path(temp)
                deploy = root / "Deploy"
                deploy.mkdir()
                (deploy / "keep").touch()
                archive = root / "dist_app.zip"
                write_manifested_archive(archive, {
                    "Development/Scripts/manage-local-system.ps1": b"# incoming manager",
                    "Development/Scripts/program-fpga-ram.py": b"# programmer",
                })
                thread = SimpleNamespace(deployRoot=str(deploy), workRoot=temp, GetStateConfig=lambda _: {})
                state = stopLocalSystem_state(thread)
                state.Config = SimpleNamespace(Actions=[{"unzipDistribution": {"actionData": {"zip": str(archive)}}}])
                process = SimpleNamespace(returncode=code, communicate=AsyncMock(return_value=(b"", b"")))
                with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=process)) as launch:
                    await state.DoWork()
                self.assertEqual(thread._localSystemStopped, code == 0)
                self.assertTrue((deploy / "keep").exists())
                self.assertEqual(launch.call_args.args[0], "powershell.exe")
                self.assertEqual(launch.call_args.args[-1], "stop")
                self.assertEqual(launch.call_args.kwargs["env"]["IOBEAM_OPERATIONS_ROOT"], str(deploy))

    async def test_fpga_uses_windows_python_and_propagates_failure(self):
        with tempfile.TemporaryDirectory(prefix="fpga space ") as temp:
            root = Path(temp)
            for rel in (".venv/Scripts/python.exe", "Development/Scripts/program-fpga-ram.py", "scan.json"):
                file = root / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            thread = SimpleNamespace(deployRoot=temp, venvDir=".venv", glasgowConfig=str(root / "scan.json"),
                                     _localSystemStopped=True, GetStateConfig=lambda _: {})
            state = programFpgaRam_state(thread)
            state.runArguments = AsyncMock(return_value=False)
            await state.DoWork()
            self.assertFalse(state._success)
            self.assertEqual(state.runArguments.call_args.args[0], [str(root / ".venv/Scripts/python.exe"),
                str(root / "Development/Scripts/program-fpga-ram.py"), "--config", str(root / "scan.json")])

    async def test_native_installer_uses_powershell_without_apt(self):
        state = installIonbeamNative_state(SimpleNamespace(deployRoot="C:/Deploy", GetStateConfig=lambda _: {
            "actionData": {"desktopEntry": False, "runSmokeTest": False}}))
        state.runArguments = AsyncMock(return_value=True)
        state._ensureAptPackages = AsyncMock()
        await state.DoWork()
        self.assertTrue(state._success)
        args = state.runArguments.call_args.args[0]
        self.assertEqual(args[0], "powershell.exe")
        self.assertIn("-SkipPip", args)
        self.assertIn("-SkipSmoke", args)
        self.assertIn("-NoDesktopEntry", args)
        state._ensureAptPackages.assert_not_called()

    async def test_toolchain_uses_semicolon_pythonpath_without_bash(self):
        state = verifyFpgaToolchain_state(SimpleNamespace(deployRoot="C:/Deploy", venvDir=".venv",
            GetStateConfig=lambda _: {"actionData": {"pythonPath": ["Development", "Development/glasgow_service"]}}))
        state.runArguments = AsyncMock(return_value=True)
        await state.DoWork()
        self.assertTrue(state._success)
        args, _, env = state.runArguments.call_args.args
        self.assertTrue(args[0].endswith("Scripts\\python.exe"))
        self.assertIn(";", env["PYTHONPATH"])

    async def test_secrets_never_persist_to_registry_or_command_line(self):
        with tempfile.TemporaryDirectory() as temp:
            config = {"actionData": {"dir": temp, "command": "run-service", "exports": {
                "GLASGOW_TOKEN": {"value": "${GLASGOW_TOKEN}", "resolve": False}}}}
            thread = SimpleNamespace(deployRoot=temp, GetStateConfig=lambda _: config)
            with patch.dict(os.environ, {"GLASGOW_TOKEN": "test-secret"}), \
                 patch("winreg.CreateKey"), patch("winreg.SetValueEx") as persist:
                state = exportEnv_state(thread)
                await state.DoWork()
                self.assertTrue(state._success)
                persist.assert_not_called()
            with patch.dict(os.environ, {"GLASGOW_TOKEN": "test-secret"}), \
                 patch("subprocess.Popen", return_value=SimpleNamespace(pid=123)) as launch:
                state = detachedShellLaunch_state(thread)
                await state.DoWork()
                self.assertTrue(state._success)
                self.assertNotIn("test-secret", str(launch.call_args.args))
                self.assertEqual(launch.call_args.kwargs["env"]["GLASGOW_TOKEN"], "test-secret")

    async def test_zip_traversal_is_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            deploy = root / "Deploy"
            deploy.mkdir()
            archive = root / "dist_app.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape.txt", "bad")
            config = {"actionData": {"zip": str(archive), "dest": "."}}
            state = unzipDistribution_state(SimpleNamespace(deployRoot=str(deploy), workRoot=temp,
                _deployRootPrepared=True, GetStateConfig=lambda _: config))
            await state.DoWork()
            self.assertFalse(state._success)
            self.assertFalse((root / "escape.txt").exists())

    def test_manifest_has_no_linux_commands(self):
        config = json.loads((Path(__file__).parents[1] / "Json/DistributionDeploy.json").read_text())
        for item in config["Actions"]:
            for name, action in item.items():
                data = action.get("actionData", {})
                for key in ("command", "commandFormat", "script", "installer", "venvActivate"):
                    value = str(data.get(key, ""))
                    self.assertFalse(any(token in value for token in ("bash ", "sudo ", ".sh", "/bin/activate")), (name, key, value))
