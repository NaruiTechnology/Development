"""Deployment gate for the FPGA gateware toolchain and the scan-path members.

The scan fix changes the gateware (IN-endpoint flush) and the scan macros
(beam unblank).  Two things must therefore be true of every release:

* the builder refuses to produce a distribution that lacks those modules;
* the deployer refuses to finish on a machine that cannot rebuild the
  bitstream (Glasgow rebuilds it at every launch).
"""
import importlib.util
import json
import shlex
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workstates.verifyFpgaToolchain_state import (  # noqa: E402
    CHECK_SCRIPT, DEFAULT_TOOLS, verifyFpgaToolchain_state)

SCAN_PATH_MODULES = (
    "Development/GlasgowDataIO/IobeamControl/applet/DataStreamApplet",
    "Development/GlasgowDataIO/IobeamControl/macros/raster",
    "Development/GlasgowDataIO/IobeamControl/macros/vector",
    "Development/GlasgowDataIO/IobeamControl/transfer/linkStats",
)


def _actions():
    payload = json.loads((ROOT / "Json" / "DistributionDeploy.json").read_text())
    return payload["Actions"]


class VerifyFpgaToolchainActionTest(unittest.TestCase):
    def test_action_runs_after_glasgow_setup_and_before_fpga_programming(self):
        names = [name for action in _actions() for name in action]
        self.assertIn("verifyFpgaToolchain", names)
        self.assertLess(names.index("installPipRequirements"),
                        names.index("verifyFpgaToolchain"))
        self.assertLess(names.index("setupGlasgow"),
                        names.index("verifyFpgaToolchain"))
        self.assertLess(names.index("verifyFpgaToolchain"),
                        names.index("programFpgaRam"))

    def test_action_is_enabled_and_has_a_timeout(self):
        entry = next(a["verifyFpgaToolchain"] for a in _actions()
                     if "verifyFpgaToolchain" in a)
        self.assertFalse(entry.get("skip", False))
        self.assertGreater(float(entry.get("timeout", 0)), 0)

    def test_state_module_exposes_class_named_like_the_action(self):
        self.assertEqual(verifyFpgaToolchain_state.__name__,
                         "verifyFpgaToolchain_state")

    def test_default_tools_are_the_full_ice40_chain(self):
        self.assertEqual(tuple(DEFAULT_TOOLS), ("yosys", "nextpnr-ice40", "icepack"))


class BuildCommandTest(unittest.TestCase):
    def test_command_activates_venv_and_sets_pythonpath(self):
        cmd = verifyFpgaToolchain_state.buildCommand(
            "/opt/dep/.venv/bin/activate", ["/opt/dep/Development"], DEFAULT_TOOLS)
        parts = shlex.split(cmd)
        self.assertEqual(parts[0], ".")
        self.assertEqual(parts[1], "/opt/dep/.venv/bin/activate")
        self.assertIn("PYTHONPATH=/opt/dep/Development${PYTHONPATH:+:$PYTHONPATH}", parts)
        self.assertEqual(parts[-3:], list(DEFAULT_TOOLS))

    def test_paths_with_spaces_are_quoted(self):
        cmd = verifyFpgaToolchain_state.buildCommand(
            "/opt/my dep/.venv/bin/activate", ["/opt/my dep/Development"], ["yosys"])
        self.assertIn(shlex.quote("/opt/my dep/.venv/bin/activate"), cmd)

    def test_hostile_tool_name_is_rejected(self):
        for bad in ("yosys; rm -rf /", "$(id)", "", "a b"):
            with self.assertRaises(ValueError):
                verifyFpgaToolchain_state.buildCommand("a", ["b"], [bad])

    def test_check_script_is_valid_python_and_uses_find_toolchain(self):
        compile(CHECK_SCRIPT, "<check>", "exec")
        self.assertIn("find_toolchain", CHECK_SCRIPT)
        self.assertIn("sys.exit(2)", CHECK_SCRIPT)
        self.assertIn("sys.exit(3)", CHECK_SCRIPT)


class CheckScriptBehaviourTest(unittest.TestCase):
    """Run CHECK_SCRIPT against a stub 'toolchain' module tree."""

    def _run(self, tmp, body, tools=("yosys",)):
        pkg = Path(tmp)
        mod = pkg / "GlasgowDataIO/IobeamControl/glasgowLib/glasgow/hardware"
        mod.mkdir(parents=True)
        for d in (pkg / "GlasgowDataIO", pkg / "GlasgowDataIO/IobeamControl",
                  pkg / "GlasgowDataIO/IobeamControl/glasgowLib",
                  pkg / "GlasgowDataIO/IobeamControl/glasgowLib/glasgow", mod):
            (d / "__init__.py").write_text("")
        (mod / "toolchain.py").write_text(body)
        return subprocess.run(
            [sys.executable, "-c", CHECK_SCRIPT, *tools],
            env={"PYTHONPATH": str(pkg), "PATH": ""},
            # `python -c` puts the cwd first on sys.path; run inside the stub
            # tree so a real GlasgowDataIO checkout in the caller's cwd cannot
            # shadow it.
            cwd=str(pkg),
            capture_output=True, text=True)

    def test_exit_codes(self):
        import tempfile
        header = ("class ToolchainNotFound(Exception): pass\n"
                  "class T:\n"
                  "    def __init__(s, m): s.tools=[type('X',(),{})()]; s.m=m\n"
                  "    missing = property(lambda s: iter(s.m))\n"
                  "    def __str__(s): return 'stub'\n")
        cases = (
            ("def find_toolchain(tools, quiet=False):\n    return T([])\n", 0),
            ("def find_toolchain(tools, quiet=False):\n    return T(['nextpnr-ice40'])\n", 3),
            ("def find_toolchain(tools, quiet=False):\n    raise ToolchainNotFound('none')\n", 2),
        )
        for tail, expected in cases:
            with tempfile.TemporaryDirectory() as tmp:
                result = self._run(tmp, header + tail)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)


class BuilderRequiredMembersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = ROOT.parents[2] / "buildCompiledDist.py"
        spec = importlib.util.spec_from_file_location("dist_builder_gate", path)
        cls.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.builder)

    def test_scan_path_modules_are_required(self):
        for member in SCAN_PATH_MODULES:
            self.assertIn(member, self.builder.REQUIRED_DIST_MODULES)

    def test_required_members_carry_the_compiled_suffix(self):
        members = self.builder.required_dist_members(False)
        for member in SCAN_PATH_MODULES:
            self.assertTrue(any(m.startswith(member + ".") for m in members), member)


if __name__ == "__main__":
    unittest.main()
