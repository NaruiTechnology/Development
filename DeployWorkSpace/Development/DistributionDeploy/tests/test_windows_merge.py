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
from workstates.createDeployFolder_state import createDeployFolder_state
from workstates.installPipRequirements_state import _verification_imports
from workstates.setupGlasgow_state import setupGlasgow_state
from workstates.installPostgreSQL_state import installPostgreSQL_state
from workstates.setupIobeamAdminDb_state import setupIobeamAdminDb_state
from workstates.setupIonbeamWeb_state import setupIonbeamWeb_state
from workstates.installRedisSentinel_state import installRedisSentinel_state
from workstates.installGoogleChrome_state import installGoogleChrome_state
from workstates.exportEnv_state import exportEnv_state
from workstates.detachedShellLaunch_state import detachedShellLaunch_state


@unittest.skipUnless(os.name == "nt", "Windows launch contracts")
class WindowsMergeTests(unittest.IsolatedAsyncioTestCase):
    def test_smbus2_import_check_is_linux_only(self):
        config = json.loads((Path(__file__).parents[1] / "Json/DistributionDeploy.json").read_text())
        action = next(item["installPipRequirements"] for item in config["Actions"]
                      if "installPipRequirements" in item)["actionData"]

        self.assertNotIn("smbus2", _verification_imports(action, "win32"))
        self.assertIn("smbus2", _verification_imports(action, "linux"))

    def test_configured_deploy_root_passes_safety_guard(self):
        self.assertTrue(unzipDistribution_state._isSafeDeployRoot(
            r"C:\Project\Iobeam\Deploy"))
        self.assertFalse(unzipDistribution_state._isSafeDeployRoot(
            r"C:\Project\Iobeam\Other"))

    def test_deploy_cleanup_scans_command_lines_for_external_node(self):
        stop_script = createDeployFolder_state._STOP_DEPLOY_ROOT_PROCESSES

        self.assertIn("Get-CimInstance Win32_Process", stop_script)
        self.assertIn("$_.ExecutablePath, $_.CommandLine", stop_script)
        self.assertIn("taskkill.exe /PID $processId /T /F", stop_script)

    def test_ionbeam_web_skips_bash_nvm_wrapper_on_windows(self):
        state = setupIonbeamWeb_state(SimpleNamespace(deployRoot="C:/Deploy"))

        self.assertEqual(state._wrapNodeCommand("npm install", useNvm=True), "npm install")

    async def test_redis_installer_starts_desktop_and_waits_for_engine(self):
        action = {"timeout": 10, "actionData": {
            "engineReadyTimeoutSeconds": 1,
            "enginePollIntervalSeconds": 0.1,
        }}
        state = installRedisSentinel_state(SimpleNamespace(
            deployRoot="C:/Deploy", _isProduction=False,
            GetStateConfig=lambda _: action))
        state._findDocker = Mock(return_value=r"C:\Docker\docker.exe")
        state._findDockerDesktop = Mock(
            return_value=r"C:\Program Files\Docker\Docker\Docker Desktop.exe")
        state._runExec = AsyncMock(side_effect=[
            (False, "", "engine starting"),
            (True, "ready", ""),
        ])
        with patch("os.startfile") as start_desktop, \
             patch("workstates.installRedisSentinel_state.asyncio.sleep",
                   new_callable=AsyncMock):
            await state.DoWork()

        self.assertTrue(state._success)
        start_desktop.assert_called_once_with(
            r"C:\Program Files\Docker\Docker\Docker Desktop.exe")
        self.assertEqual(state._runExec.await_count, 2)

    async def test_chrome_setup_uses_winget_and_registry_on_windows(self):
        action = {"timeout": 30, "actionData": {"windowsPackage": "Google.Chrome"}}
        state = installGoogleChrome_state(SimpleNamespace(
            deployRoot="C:/Deploy", GetStateConfig=lambda _: action))
        chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        state._findWindowsChrome = Mock(side_effect=[None, chrome])
        state._runWindows = AsyncMock(return_value=(True, ""))
        state._configureWindowsDownloadPolicy = Mock()
        state.commandAsyncio = AsyncMock()
        with patch("workstates.installGoogleChrome_state.shutil.which",
                   return_value="winget.exe"):
            await state.DoWork()

        self.assertTrue(state._success)
        self.assertEqual(state._runWindows.call_args.args[0], [
            "winget.exe", "install", "--id", "Google.Chrome", "--exact",
            "--silent", "--accept-source-agreements", "--accept-package-agreements",
        ])
        state._configureWindowsDownloadPolicy.assert_called_once_with()
        state.commandAsyncio.assert_not_awaited()

    async def test_create_deploy_folder_sets_prepared_marker_after_recreation(self):
        with tempfile.TemporaryDirectory() as temp:
            deploy = Path(temp) / "Deploy"
            deploy.mkdir()
            thread = SimpleNamespace(
                deployRoot=str(deploy),
                _deployRootPrepared=True,
                GetStateConfig=lambda _: {},
            )
            state = createDeployFolder_state(thread)
            state._stopManagedWindowsStack = AsyncMock(return_value=True)

            await state.DoWork()

            self.assertTrue(state._success)
            self.assertTrue(thread._deployRootPrepared)

    async def test_distribution_zip_extracts_without_external_unzip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            deploy = root / "Deploy"
            deploy.mkdir()
            archive = root / "dist_app.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("payload.txt", "deployed")
            config = {"actionData": {"zip": str(archive), "dest": "."}}
            thread = SimpleNamespace(
                deployRoot=str(deploy), workRoot=temp,
                _deployRootPrepared=True, _distributionZip=str(archive),
                GetStateConfig=lambda _: config,
                activateVirtualEnv=lambda: None,
            )
            state = unzipDistribution_state(thread)
            state._run = AsyncMock(return_value=False)

            await state.DoWork()

            self.assertTrue(state._success)
            self.assertEqual((deploy / "payload.txt").read_text(), "deployed")
            state._run.assert_not_awaited()

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

    async def test_postgresql_installer_uses_winget_and_verifies_psql(self):
        with tempfile.TemporaryDirectory() as temp:
            psql = Path(temp) / "PostgreSQL" / "bin" / "psql.exe"
            psql.parent.mkdir(parents=True)
            psql.touch()
            (psql.parent / "postgres.exe").touch()
            action = {"actionData": {"windowsPackage": "PostgreSQL.PostgreSQL"}}
            state = installPostgreSQL_state(SimpleNamespace(
                deployRoot=temp, GetStateConfig=lambda _: action))
            state._findPsql = Mock(side_effect=[None, str(psql)])
            state.runArguments = AsyncMock(return_value=True)
            state._isAdministrator = Mock(return_value=True)
            with patch("workstates.installPostgreSQL_state.shutil.which",
                       return_value="winget.exe"):
                await state.DoWork()

            self.assertTrue(state._success)
            command = state.runArguments.call_args.args[0]
            self.assertEqual(command[:9], [
                "winget.exe", "install", "--id", "PostgreSQL.PostgreSQL.17",
                "--exact", "--silent", "--accept-source-agreements",
                "--accept-package-agreements", "--source",
            ])
            self.assertIn("--disable-interactivity", command)
            self.assertIn("--log", command)
            self.assertIn(str(psql.parent), os.environ["PATH"])

    async def test_admin_database_skips_linux_vbox_user_on_windows(self):
        state = setupIobeamAdminDb_state(SimpleNamespace(deployRoot="C:/Deploy"))
        state._runExec = AsyncMock()

        self.assertTrue(await state._ensureVboxUser(30))
        state._runExec.assert_not_awaited()

    async def test_admin_database_uses_native_psql_and_password_environment(self):
        state = setupIobeamAdminDb_state(SimpleNamespace(deployRoot="C:/Deploy"))
        state._psqlExecutable = Mock(return_value=r"C:\Program Files\PostgreSQL\17\bin\psql.exe")
        state.deploymentConfig = Mock(return_value={"DatabasePort": 5440})
        state._runExec = AsyncMock(return_value=(True, "iobeam_admin_app:iobeam_admin", ""))

        self.assertTrue(await state._verifyRuntimeRoleCanConnect(
            "iobeam_admin", "localhost", "iobeam_admin_app", "runtime-secret", 30, {}))

        argv, timeout = state._runExec.call_args.args[:2]
        self.assertEqual(argv[:8], [
            r"C:\Program Files\PostgreSQL\17\bin\psql.exe",
            "-h", "localhost", "-p", "5440", "-U", "iobeam_admin_app",
            "-d",
        ])
        self.assertEqual(argv[8], "iobeam_admin")
        self.assertEqual(argv[-2:], ["-Atqc", "SELECT current_user || ':' || current_database();"])
        self.assertEqual(timeout, 30)
        self.assertEqual(state._runExec.call_args.kwargs["env"]["PGPASSWORD"], "runtime-secret")

    async def test_glasgow_checks_tools_from_deployment_venv(self):
        with tempfile.TemporaryDirectory(prefix="glasgow venv ") as temp:
            root = Path(temp)
            scripts = root / ".venv" / "Scripts"
            scripts.mkdir(parents=True)
            (scripts / "python.exe").touch()
            action = {"actionData": {"deployRoot": ".", "venvDir": ".venv"}}
            state = setupGlasgow_state(SimpleNamespace(
                deployRoot=temp, GetStateConfig=lambda _: action))
            state._run = AsyncMock(return_value=True)

            await state.DoWork()

            self.assertTrue(state._success)
            commands = [call.args[0] for call in state._run.await_args_list]
            self.assertEqual(commands[1][0], str(scripts / "yowasp-yosys.exe"))
            self.assertEqual(commands[2][0], str(scripts / "yowasp-nextpnr-ice40.exe"))

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
