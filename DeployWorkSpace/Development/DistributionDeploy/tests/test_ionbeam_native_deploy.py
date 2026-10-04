"""The native desktop client (Development/ionbeam-native) in the build/deploy workflow."""
import importlib.util
import json
import subprocess
import shlex
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workstates.installIonbeamNative_state import installIonbeamNative_state  # noqa: E402

CONFIG = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
ACTIONS = {name: cfg for item in CONFIG["Actions"] for name, cfg in item.items()}
NAMES = [name for item in CONFIG["Actions"] for name in item]


def _builder():
    path = ROOT.parents[2] / "buildCompiledDist.py"
    spec = importlib.util.spec_from_file_location("distribution_builder_native", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkflowConfigTests(unittest.TestCase):
    def test_requirements_are_installed_with_the_platform(self):
        pip = ACTIONS["installPipRequirements"]["actionData"]
        self.assertIn("ionbeam-native/requirements.txt", pip["extraRequirements"])
        self.assertIn("PyQt6.QtCore", pip["verifyImports"])

    def test_native_install_runs_after_requirements_and_fpga_before_restart(self):
        self.assertFalse(ACTIONS["installIonbeamNative"]["skip"])
        for earlier in ("installPipRequirements", "installToolchain", "setupGlasgow", "programFpgaRam"):
            self.assertLess(NAMES.index(earlier), NAMES.index("installIonbeamNative"))
        self.assertLess(NAMES.index("installIonbeamNative"), NAMES.index("manageLocalSystem"))

    def test_builder_packages_native_client(self):
        builder = _builder()
        members = builder.required_dist_members(deliver_raw=False)
        for member in (
            "Development/ionbeam-native/ionbeam_native/__main__.pyc",
            "Development/ionbeam-native/ionbeam_native/engine/persistent.pyc",
            "Development/ionbeam-native/scripts/install_linux.sh",
            "Development/ionbeam-native/requirements.txt",
            "Development/ionbeam-native/ionbeam_native/i18n/data/en.json",
            "Development/ionbeam-native/ionbeam_native/resources/images/brand-logo.png",
            "Development/glasgow_service/glasgow_service/device_lock.pyc",
        ):
            self.assertIn(member, members)
        for tree in builder.PACKAGE_DATA_TREES:
            self.assertTrue((ROOT.parents[2] / Path(tree).relative_to("Development")).is_dir(), tree)

    def test_package_data_copy_excludes_python_sources(self):
        builder = _builder()
        with tempfile.TemporaryDirectory() as tmp:
            src, dist = Path(tmp) / "src", Path(tmp) / "dist"
            pkg = src / "Development" / "pkg" / "data"
            pkg.mkdir(parents=True)
            (pkg / "table.json").write_text("{}")
            (pkg / "loader.py").write_text("x = 1\n")
            (pkg / "__pycache__").mkdir()
            builder.copy_package_data(str(src), str(dist), [str(Path("Development") / "pkg")])
            copied = sorted(p.relative_to(dist).as_posix() for p in dist.rglob("*") if p.is_file())
            self.assertEqual(copied, ["Development/pkg/data/table.json"])


class AptRecoveryTests(unittest.TestCase):
    def run_sequence(self, failing_step):
        with tempfile.TemporaryDirectory() as tmp:
            state = installIonbeamNative_state(SimpleNamespace())
            log = Path(tmp) / "calls"
            # Stub sudo rather than touching the host package manager. Fail the
            # initial configure, or apt install, to exercise real shell flow.
            stub = """sudo() {
                echo "$*" >> "$CALL_LOG"
                case "$*" in
                    *dpkg*)
                        if [ "$FAIL_STEP" = configure ] && [ ! -e "$CALL_LOG.once" ]; then
                            touch "$CALL_LOG.once"; return 1
                        fi ;;
                    *'install -y --no-install-recommends'*)
                        if [ "$FAIL_STEP" = install ]; then return 42; fi ;;
                esac
                return 0
            }; """
            import os
            result = subprocess.run(
                ["sh", "-c", stub + state.aptInstallCommand(["libxcb-cursor0"],
                                                          "echo verified")],
                env=dict(os.environ, CALL_LOG=str(log), FAIL_STEP=failing_step),
                capture_output=True, text=True)
            return result, log.read_text()

    def test_failed_initial_configuration_still_repairs_and_verifies(self):
        result, calls = self.run_sequence("configure")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--fix-broken install -y", calls)
        self.assertEqual(calls.count("--configure -a"), 2)
        self.assertIn("verified", result.stdout)

    def test_install_failure_reports_phase_and_does_not_verify(self):
        result, calls = self.run_sequence("install")
        self.assertEqual(result.returncode, 42)
        self.assertIn("apt-install (exit 42)", result.stderr)
        self.assertNotIn("verified", result.stdout)


class InstallStateTests(unittest.IsolatedAsyncioTestCase):
    def _state(self, root, action_data=None, production=False):
        config = {"actionData": dict(action_data or {}), "timeout": 30.0}
        thread = SimpleNamespace(deployRoot=str(root), venvDir=".venv", _isProduction=production,
                                 GetStateConfig=lambda _: config)
        state = installIonbeamNative_state(thread)
        state._stdout = state._stderr = b""
        return state

    def _layout(self, root):
        for name in (".venv/bin/python", "Development/ionbeam-native/scripts/install_linux.sh"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    async def test_production_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = self._state(Path(tmp), production=True)
            state.commandAsyncio = AsyncMock(return_value=True)
            await state.DoWork()
            self.assertTrue(state._success)
            state.commandAsyncio.assert_not_called()

    async def test_runs_installer_against_deployment_venv_without_reinstalling_pins(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._layout(root)
            state = self._state(root, {"aptPackages": []})
            state.commandAsyncio = AsyncMock(return_value=True)
            await state.DoWork()
            self.assertTrue(state._success)
            argv = shlex.split(state.commandAsyncio.call_args.args[0])
            self.assertEqual(argv, ["bash", str(root / "Development/ionbeam-native/scripts/install_linux.sh"),
                                    "--venv", str(root / ".venv"), "--skip-pip"])

    async def test_options_and_apt_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._layout(root)
            state = self._state(root, {"aptPackages": ["libxcb-cursor0"], "desktopEntry": False,
                                       "runSmokeTest": False})
            state.commandAsyncio = AsyncMock(return_value=True)   # dpkg check passes -> no apt-get
            await state.DoWork()
            self.assertTrue(state._success)
            commands = [c.args[0] for c in state.commandAsyncio.call_args_list]
            self.assertEqual(len(commands), 2)
            self.assertIn("dpkg-query", commands[0])
            self.assertNotIn("apt-get", commands[0])
            self.assertTrue(commands[1].endswith("--skip-pip --no-desktop-entry --skip-smoke"))

    async def test_apt_install_repairs_broken_dpkg_state_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._layout(root)
            state = self._state(root, {"aptPackages": ["libxcb-cursor0"]})
            # dpkg check fails -> apt path; apt + installer succeed
            state.commandAsyncio = AsyncMock(side_effect=[False, True, True])
            await state.DoWork()
            self.assertTrue(state._success)
            apt = state.commandAsyncio.call_args_list[1].args[0]
            configure = apt.index("dpkg --force-confdef --force-confold --configure -a")
            fix = apt.index("--fix-broken install -y")
            install = apt.index("install -y --no-install-recommends")
            self.assertLess(configure, fix)
            self.assertLess(fix, install)

    async def test_apt_failure_fails_the_state_and_logs_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._layout(root)
            state = self._state(root, {"aptPackages": ["libxcb-cursor0"]})
            state.commandAsyncio = AsyncMock(side_effect=[False, False])
            errors = []
            state.error = errors.append
            state._stdout = b"The following packages have unmet dependencies:\n libgl1 : Depends: x"
            state._stderr = b"E: Unmet dependencies."
            await state.DoWork()
            self.assertFalse(state._success)
            self.assertEqual(state.commandAsyncio.call_count, 2)   # installer never runs
            self.assertIn("libgl1 : Depends", errors[-1])

    async def test_failure_and_missing_inputs_fail_the_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = self._state(root, {"aptPackages": []})
            state.commandAsyncio = AsyncMock(return_value=True)
            await state.DoWork()                       # installer missing
            self.assertFalse(state._success)
            self._layout(root)
            state = self._state(root, {"aptPackages": []})
            state.commandAsyncio = AsyncMock(return_value=False)
            await state.DoWork()                       # installer fails
            self.assertFalse(state._success)
            state = self._state(root, {"aptPackages": ["bad;rm -rf /"]})
            state.commandAsyncio = AsyncMock(return_value=True)
            await state.DoWork()                       # unsafe package name
            self.assertFalse(state._success)
            state.commandAsyncio.assert_not_called()


if __name__ == "__main__":
    unittest.main()
