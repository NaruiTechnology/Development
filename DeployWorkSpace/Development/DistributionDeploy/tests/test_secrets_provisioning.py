"""Credential handling in the build and install workflow."""
import asyncio
import json
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import secretsSupport  # noqa: E402
from workstates.detachedShellLaunch_state import detachedShellLaunch_state  # noqa: E402
from workstates.exportEnv_state import exportEnv_state  # noqa: E402
from workstates.provisionSecrets_state import provisionSecrets_state  # noqa: E402
from workstates.setupIobeamAdminDb_state import setupIobeamAdminDb_state  # noqa: E402
from workstates.setupIonbeamWeb_state import setupIonbeamWeb_state  # noqa: E402

store = secretsSupport.load()
LEGACY_FTP = {"enabled": True, "host": "198.51.100.7", "username": "legacy-user",
              "password": "legacy-pass", "folder": "/upload"}


class SecretsFileTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.secrets = self.root / "home" / ".config" / "iobeam" / "secrets.env"
        patcher = patch.dict(os.environ, {"IOBEAM_SECRETS_FILE": str(self.secrets)})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("GLASGOW_TOKEN", "IOBEAM_FTP_PASSWORD", "IOBEAM_FTP_HOST", "IOBEAM_FTP_USER",
                     "IOBEAM_ADMIN_DB_PASSWORD", "IOBEAM_ADMIN_DB_HOST", "IOBEAM_ADMIN_DB_USER",
                     "IOBEAM_ADMIN_CONFIG_DB_HOST", "IOBEAM_ADMIN_CONFIG_DB_USER",
                     "IOBEAM_ADMIN_CONFIG_DB_PASSWORD", "IOBEAM_OPERATION_DB_PASSWORD"):
            os.environ.pop(name, None)

    def file_values(self):
        return store.read_file(str(self.secrets))


class ProvisionSecretsTests(SecretsFileTestCase):
    def make_state(self, deploy, variables, deployment=None):
        config = {"actionData": {"variables": variables, "prompt": False}}
        thread = SimpleNamespace(deployRoot=str(deploy), workRoot=str(self.root),
                                 GetStateConfig=lambda _: config)
        state = provisionSecrets_state(thread)
        state.Config = SimpleNamespace(Deployment=deployment or {})
        state.Logger = Mock()
        return state

    def old_installation(self):
        deploy = self.root / "IobeamPlatform"
        stream = deploy / "Development/GlasgowDataIO/Json/streamData.json"
        stream.parent.mkdir(parents=True)
        stream.write_text(json.dumps({"Actions": [{"streamData": {"actionData": {"ftp": LEGACY_FTP}}}]}))
        env = deploy / "Development/ionbeam-web/backend/.env"
        env.parent.mkdir(parents=True)
        env.write_text("PORT=4000\nGLASGOW_TOKEN=legacy-token-value\nSMTP_PASSWORD=legacy-smtp\n")
        return deploy

    def test_upgrade_harvests_old_installation_before_it_is_deleted(self):
        deploy = self.old_installation()
        state = self.make_state(deploy, [
            {"name": "GLASGOW_TOKEN", "required": True, "generate": "hex32"},
            {"name": "IOBEAM_FTP_PASSWORD", "required": False},
        ])
        asyncio.run(state.DoWork())
        self.assertTrue(state._success)
        values = self.file_values()
        self.assertEqual(values["GLASGOW_TOKEN"], "legacy-token-value")   # harvest beats generator
        self.assertEqual(values["IOBEAM_FTP_HOST"], "198.51.100.7")
        self.assertEqual(values["IOBEAM_FTP_PASSWORD"], "legacy-pass")
        self.assertEqual(values["SMTP_PASSWORD"], "legacy-smtp")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.secrets.stat().st_mode), 0o600)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.secrets.parent.stat().st_mode), 0o700)
        self.assertEqual(os.environ["IOBEAM_FTP_PASSWORD"], "legacy-pass")
        logged = " ".join(str(c) for c in state.Logger.mock_calls)
        for secret in ("legacy-pass", "legacy-token-value", "legacy-smtp"):
            self.assertNotIn(secret, logged)

    def test_existing_values_are_never_overwritten(self):
        store.write({"GLASGOW_TOKEN": "kept"}, str(self.secrets))
        deploy = self.old_installation()
        asyncio.run(self.make_state(deploy, [{"name": "GLASGOW_TOKEN", "generate": "hex32"}]).DoWork())
        self.assertEqual(self.file_values()["GLASGOW_TOKEN"], "kept")

    def test_fresh_host_generates_token_and_fails_on_missing_required(self):
        deploy = self.root / "fresh"
        state = self.make_state(deploy, [
            {"name": "GLASGOW_TOKEN", "required": True, "generate": "hex32"},
            {"name": "IOBEAM_ADMIN_CONFIG_DB_PASSWORD", "required": True},
        ])
        asyncio.run(state.DoWork())
        self.assertFalse(state._success)
        self.assertEqual(len(self.file_values()["GLASGOW_TOKEN"]), 64)
        message = " ".join(str(c) for c in state.Logger.error.mock_calls)
        self.assertIn("IOBEAM_ADMIN_CONFIG_DB_PASSWORD", message)
        self.assertIn("--secrets-file", message)
        self.assertIn("Nothing was removed", message)

    def test_environment_supplies_values_for_unattended_deploys(self):
        with patch.dict(os.environ, {"IOBEAM_ADMIN_CONFIG_DB_PASSWORD": "from-env"}):
            state = self.make_state(self.root / "fresh", [
                {"name": "IOBEAM_ADMIN_CONFIG_DB_PASSWORD", "required": True}])
            asyncio.run(state.DoWork())
        self.assertTrue(state._success)
        self.assertEqual(self.file_values()["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"], "from-env")

    def test_prepared_file_replaces_stored_values_and_needs_no_prompt(self):
        store.write({"IOBEAM_FTP_PASSWORD": "old"}, str(self.secrets))
        seed = self.root / "prepared.env"
        seed.write_text("IOBEAM_ADMIN_CONFIG_DB_HOST=db\nIOBEAM_ADMIN_CONFIG_DB_USER=u\n"
                        "IOBEAM_ADMIN_CONFIG_DB_PASSWORD=p\nIOBEAM_FTP_PASSWORD=new\n")
        config = {"actionData": {}}   # manifest defaults: secretstore.VARIABLES
        thread = SimpleNamespace(deployRoot=str(self.root / "fresh"), workRoot=str(self.root),
                                 GetStateConfig=lambda _: config)
        state = provisionSecrets_state(thread)
        state.Config = SimpleNamespace(Deployment={})
        state.Logger = Mock()
        with patch.dict(os.environ, {"IOBEAM_SECRETS_SEED": str(seed)}):
            asyncio.run(state.DoWork())
        self.assertTrue(state._success, state.Logger.error.mock_calls)
        values = self.file_values()
        self.assertEqual(values["IOBEAM_FTP_PASSWORD"], "new")
        self.assertEqual(len(values["GLASGOW_TOKEN"]), 64)
        self.assertTrue(values["IOBEAM_ADMIN_DB_PASSWORD"])
        logged = " ".join(str(c) for c in state.Logger.mock_calls)
        self.assertIn("no previous installation", logged)
        self.assertNotIn("new", [str(c) for c in state.Logger.mock_calls])

    def test_unresolved_manifest_reference_fails_the_run(self):
        state = self.make_state(self.root / "fresh", [],
                                deployment={"DatabasePassword": "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD}"})
        asyncio.run(state.DoWork())
        self.assertFalse(state._success)

    def test_manifest_declares_provisioning_before_deletion(self):
        payload = json.loads((ROOT / "Json/DistributionDeploy.json").read_text())
        names = [name for action in payload["Actions"] for name in action]
        self.assertLess(names.index("provisionSecrets"), names.index("createDeployFolder"))
        self.assertGreater(names.index("provisionSecrets"), names.index("stopLocalSystem"))
        self.assertEqual(store.scan_json(payload), [])


class NoInputMigrationTests(SecretsFileTestCase):
    """Upgrades and half-migrated hosts must deploy without asking anything."""

    def run_state(self, deploy_root, handoff_dirs, home):
        import workstates.provisionSecrets_state as module
        config = {"actionData": {}}           # the manifest's defaults
        thread = SimpleNamespace(deployRoot=str(deploy_root), workRoot=str(self.root),
                                 GetStateConfig=lambda _: config)
        state = provisionSecrets_state(thread)
        state.Config = SimpleNamespace(Deployment={
            "DatabasePassword": "${IOBEAM_ADMIN_CONFIG_DB_PASSWORD:-}"})
        state.Logger = Mock()
        state._handoffSearchDirs = lambda: [str(d) for d in handoff_dirs]
        with patch.dict(os.environ, {"HOME": str(home)}), \
                patch.object(module, "TRACE_FILES", ("~/.bashrc",)), \
                patch("sys.stdin.isatty", return_value=True):   # a terminal is attached ...
            asyncio.run(state.DoWork())
        return state

    def test_half_migrated_host_recovers_values_from_earlier_archive_and_bashrc(self):
        sys.path.insert(0, str(ROOT.parents[2] / "secretstore" / "tests"))
        from test_secretstore import previous_release_handoff
        downloads = self.root / "Downloads"
        downloads.mkdir()
        previous_release_handoff(downloads)                     # pre-secrets release archive
        home = self.root / "home"
        home.mkdir()
        (home / ".bashrc").write_text("export GLASGOW_TOKEN=bashrc-token\n")
        # DeployRoot was already replaced by the new release: placeholders only.
        deploy = self.root / "IobeamPlatform"
        stream = deploy / "Development/GlasgowDataIO/Json/streamData.json"
        stream.parent.mkdir(parents=True)
        stream.write_text(json.dumps({"Actions": [{"streamData": {"actionData": {"ftp": {
            "host": "${IOBEAM_FTP_HOST}", "username": "${IOBEAM_FTP_USER}",
            "password": "${IOBEAM_FTP_PASSWORD}"}}}}]}))
        state = self.run_state(deploy, [downloads], home)
        self.assertTrue(state._success, state.Logger.error.mock_calls)
        values = self.file_values()
        self.assertEqual(values["IOBEAM_ADMIN_CONFIG_DB_PASSWORD"], "cfg-real-pass")
        self.assertEqual(values["IOBEAM_FTP_PASSWORD"], "ftp-real-pass")
        self.assertEqual(values["GLASGOW_TOKEN"], "old-release-token")   # archive before bashrc
        logged = " ".join(str(c) for c in state.Logger.mock_calls)
        self.assertIn("earlier release archive", logged)
        self.assertNotIn("Not configured", logged)
        for secret in ("cfg-real-pass", "ftp-real-pass", "old-release-token"):
            self.assertNotIn(secret, logged)

    @unittest.skipIf(os.name == "nt", "POSIX shell fixture; Windows paths covered separately")
    def test_bashrc_token_is_used_when_no_archive_has_one(self):
        home = self.root / "home"
        home.mkdir()
        (home / ".bashrc").write_text("export GLASGOW_TOKEN=bashrc-token\n")
        state = self.run_state(self.root / "fresh", [], home)
        self.assertTrue(state._success)
        self.assertEqual(self.file_values()["GLASGOW_TOKEN"], "bashrc-token")

    def test_nothing_anywhere_still_deploys_and_explains_what_is_unset(self):
        home = self.root / "home"
        home.mkdir()
        with patch("builtins.input", side_effect=AssertionError("must not prompt")), \
                patch("getpass.getpass", side_effect=AssertionError("must not prompt")):
            state = self.run_state(self.root / "fresh", [], home)
        self.assertTrue(state._success, state.Logger.error.mock_calls)
        values = self.file_values()
        self.assertEqual(len(values["GLASGOW_TOKEN"]), 64)
        self.assertTrue(values["IOBEAM_ADMIN_DB_PASSWORD"])
        warning = " ".join(str(c) for c in state.Logger.warning.mock_calls)
        self.assertIn("IOBEAM_ADMIN_CONFIG_DB_HOST", warning)
        self.assertIn("local admin database", warning)
        self.assertIn("FTP is disabled", warning)


class SecretsNeverLeakTests(SecretsFileTestCase):
    @unittest.skipIf(os.name == "nt", "POSIX shell fixture; Windows paths covered separately")
    def test_export_env_keeps_secrets_out_of_bashrc(self):
        store.write({"GLASGOW_TOKEN": "token-value"}, str(self.secrets))
        bashrc = self.root / "bashrc"
        config = {"actionData": {"bashrcPath": str(bashrc), "exports": {
            "GLASGOW_TOKEN": {"value": "${GLASGOW_TOKEN}", "resolve": False},
            "GLASGOW_CONFIG": "Development/x.json"}}}
        state = exportEnv_state(SimpleNamespace(deployRoot=str(self.root), GetStateConfig=lambda _: config))
        state.Logger = Mock()
        asyncio.run(state.DoWork())
        self.assertTrue(state._success)
        text = bashrc.read_text()
        self.assertIn("GLASGOW_CONFIG", text)
        self.assertNotIn("token-value", text)
        self.assertNotIn("GLASGOW_TOKEN", text)
        self.assertEqual(os.environ["GLASGOW_TOKEN"], "token-value")
        self.assertNotIn("token-value", str(state.Logger.mock_calls))

    @unittest.skipIf(os.name == "nt", "POSIX shell fixture; Windows paths covered separately")
    def test_detached_launch_never_puts_a_secret_on_the_command_line(self):
        store.write({"GLASGOW_TOKEN": "token-value"}, str(self.secrets))
        run_dir = self.root / "svc"
        run_dir.mkdir()
        config = {"actionData": {"dir": str(run_dir), "command": "run-service", "exports": {
            "GLASGOW_TOKEN": {"value": "${GLASGOW_TOKEN}", "resolve": False}}}}
        state = detachedShellLaunch_state(SimpleNamespace(deployRoot=str(self.root), GetStateConfig=lambda _: config))
        state.Logger = Mock()
        state._stopExisting = Mock(return_value=True)
        state._launchDetached = Mock()
        asyncio.run(state.DoWork())
        command = state._launchDetached.call_args[0][0]
        self.assertNotIn("token-value", command)
        self.assertIn(". " + str(self.secrets), command)
        self.assertEqual(os.environ["GLASGOW_TOKEN"], "token-value")

    def test_admin_db_config_holds_placeholders_and_secrets_file_holds_values(self):
        config_file = self.root / "IobeamAdminDb.json"
        state = setupIobeamAdminDb_state(SimpleNamespace(deployRoot=str(self.root), GetStateConfig=lambda _: {}))
        state.Logger = Mock()
        self.assertTrue(state._writeDbConfig(str(config_file), "iobeam_admin", "localhost",
                                             "iobeam_admin_app", "runtime-pass", {}))
        data = json.loads(config_file.read_text())
        self.assertEqual(data["Password"], "${IOBEAM_ADMIN_DB_PASSWORD}")
        self.assertNotIn("runtime-pass", config_file.read_text())
        self.assertEqual(self.file_values()["IOBEAM_ADMIN_DB_PASSWORD"], "runtime-pass")
        self.assertEqual(state._readDbPassword(str(config_file)), "runtime-pass")

    def test_runtime_role_check_passes_password_in_environment(self):
        state = setupIobeamAdminDb_state(SimpleNamespace(deployRoot=str(self.root), GetStateConfig=lambda _: {}))
        state.Logger = Mock()
        calls = []

        async def fake_run(argv, timeout, stdin=None, env=None):
            calls.append((argv, env))
            return True, "app:db", ""

        state._runExec = fake_run
        asyncio.run(state._verifyRuntimeRoleCanConnect("db", "localhost", "app", "pw-value", 5, {}))
        argv, env = calls[0]
        self.assertNotIn("pw-value", " ".join(argv))
        self.assertEqual(env["PGPASSWORD"], "pw-value")

    def test_backend_env_has_no_credentials(self):
        backend = self.root / "Development/ionbeam-web/backend"
        backend.mkdir(parents=True)
        state = setupIonbeamWeb_state(SimpleNamespace(deployRoot=str(self.root)))
        state.Logger = Mock()
        state._readAdminDbConfig = Mock(return_value={"Host": "db.local", "User": "app", "Password": "db-pass"})
        with patch.dict(os.environ, {"GLASGOW_TOKEN": "token-value"}):
            state._writeBackendEnv(str(backend / ".env"), str(backend), {})
        text = (backend / ".env").read_text()
        for leaked in ("db-pass", "token-value", "IOBEAM_ADMIN_DB_PASSWORD", "GLASGOW_TOKEN", "db.local"):
            self.assertNotIn(leaked, text)
        values = self.file_values()
        self.assertEqual(values["IOBEAM_ADMIN_DB_PASSWORD"], "db-pass")
        self.assertEqual(values["IOBEAM_OPERATION_DB_PASSWORD"], "db-pass")
        self.assertEqual(values["IOBEAM_ADMIN_DB_HOST"], "db.local")


class BuildGateTests(unittest.TestCase):
    def setUp(self):
        from test_distribution_integrity import load_builder, make_workspace
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ws, self.script = make_workspace(self._tmp.name)
        self.builder = load_builder(self.script)
        self.cwd = os.getcwd()
        self.addCleanup(os.chdir, self.cwd)

    def build(self):
        os.chdir(self.ws)
        with patch("sys.stdout"):
            return self.builder.main([], script_path=str(self.script))

    def test_handoff_vendors_secretstore_and_leaves_no_copy_behind(self):
        self.assertEqual(self.build(), 0)
        handoff = max(self.ws.glob("DeployWorkspace_*.zip"))
        with zipfile.ZipFile(handoff) as archive:
            names = archive.namelist()
        self.assertTrue(any(n.endswith("DistributionDeploy/vendor/secretstore/__init__.py") for n in names))
        self.assertFalse((self.ws / "Development/DeployWorkSpace/Development/DistributionDeploy/vendor").exists())

    def test_literal_credentials_fail_the_build(self):
        leak = self.ws / "Development/IobeamAdmin/Json/IobeamAdmin.json"
        leak.parent.mkdir(parents=True, exist_ok=True)
        leak.write_text(json.dumps({"Database": {"Password": "hunter2"}}))
        self.assertEqual(self.build(), 1)
        self.assertFalse(list(self.ws.glob("DeployWorkspace_*.zip")))
        self.assertFalse((self.ws / "dist_app.zip").exists())


if __name__ == "__main__":
    unittest.main()


class FreshHostCommandTests(unittest.TestCase):
    """Commands that only run on a host that has never been deployed to."""

    @unittest.skipIf(os.name == "nt", "POSIX shell fixture; Windows paths covered separately")
    def test_postgresql_install_command_succeeds_when_its_tools_succeed(self):
        import subprocess
        from workstates.installPostgreSQL_state import installPostgreSQL_state
        commands = []

        async def fake_run(command, timeout):
            commands.append(command)
            return False  # first call: "already installed?" -> no

        state = installPostgreSQL_state(SimpleNamespace(deployRoot=str(ROOT), GetStateConfig=lambda _: {}))
        state.Logger = Mock()
        state._run = fake_run
        asyncio.run(state.DoWork())
        install = commands[1]
        with tempfile.TemporaryDirectory() as bin_dir:
            for tool in ("sudo", "apt-get", "systemctl", "psql"):
                path = Path(bin_dir) / tool
                # sudo runs its command (env handles VAR=value prefixes); the rest succeed.
                sudo = ('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -*) shift ;; '
                        '*) break ;; esac; done\nexec env "$@"\n')
                path.write_text(sudo if tool == "sudo" else "#!/bin/sh\nexit 0\n")
                path.chmod(0o755)
            env = dict(os.environ, PATH=bin_dir + os.pathsep + "/bin:/usr/bin")
            result = subprocess.run(["bash", "-c", install], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_no_state_passes_doubled_braces_to_the_shell(self):
        import ast
        problems = []
        for path in sorted((ROOT / "workstates").glob("*.py")):
            tree = ast.parse(path.read_text())
            formatted = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                        and node.func.attr == "format":
                    formatted.update(id(sub) for sub in ast.walk(node.func.value))
                if isinstance(node, ast.JoinedStr):
                    formatted.update(id(sub) for sub in node.values)
            problems += ["{}:{}".format(path.name, node.lineno) for node in ast.walk(tree)
                         if isinstance(node, ast.Constant) and isinstance(node.value, str)
                         and "{{" in node.value and id(node) not in formatted]
        self.assertEqual(problems, [])
