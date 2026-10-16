"""The local stack manager never stops or restarts a running SBC controller.

Once the SBC vacuum controller runs it owns the vacuum system: stopping or
restarting it powers every pump down.  ``manage-local-system.sh stop`` leaves
it running; only the explicit ``stop-vacuum``/``restart-vacuum --yes`` actions
touch it.  The script runs against stand-in commands: nothing real is started
or stopped.
"""
import os
from pathlib import Path
import subprocess

SCRIPT = Path(__file__).parents[2] / "Scripts/manage-local-system.sh"
SBC = "sbc-vacuum.service"


def run_manager(tmp_path, *args):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    root = tmp_path / "Operations"
    (root / "Development/glasgow_service").mkdir(parents=True, exist_ok=True)
    log = tmp_path / "calls.log"
    log.touch()

    def executable(name, source):
        target = bin_dir / name
        target.write_text("#!/bin/bash\n" + source)
        target.chmod(0o755)

    executable("systemctl", f'''
echo "systemctl $*" >> "{log}"
if [[ "$*" == *"--property=LoadState"* ]]; then echo loaded; exit 0; fi
if [[ "$*" == *"--property=MainPID"* ]]; then echo 0; exit 0; fi
exit 0
''')
    executable("sudo", 'exec "$@"\n')
    executable("id", 'case "$1" in -un) echo operator ;; -u) echo 1000 ;; *) echo sudo ;; esac\n')
    executable("getent", f'echo "operator:x:1000:1000::{tmp_path}:/bin/bash"\n')
    executable("ss", "exit 0\n")
    executable("pgrep", "exit 1\n")
    executable("sleep", "exit 0\n")
    executable("curl", "exit 0\n")

    result = subprocess.run(
        ["/bin/bash", str(SCRIPT), *args], capture_output=True, text=True, timeout=20,
        env={**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin", "OPERATIONS_ROOT": str(root),
             "ADMIN_USER": "operator", "OPERATIONS_LOG_DIR": str(tmp_path / "logs")},
    )
    return result, log.read_text().splitlines()


def sbc_calls(calls, verb):
    return [c for c in calls if f" {verb} {SBC}" in c]


def test_stop_leaves_the_sbc_controller_running(tmp_path):
    result, calls = run_manager(tmp_path, "stop")
    assert result.returncode == 0, result.stderr
    assert not sbc_calls(calls, "stop") and not sbc_calls(calls, "restart")
    assert any(" stop ionbeam-web-backend.service" in c for c in calls)
    assert any(" stop glasgow-svc.service" in c for c in calls)
    assert f"{SBC} keeps running" in result.stdout


def test_vacuum_actions_require_explicit_confirmation(tmp_path):
    for action in ("stop-vacuum", "restart-vacuum"):
        result, calls = run_manager(tmp_path, action)
        assert result.returncode == 2
        assert "--yes" in result.stderr
        assert not sbc_calls(calls, "stop") and not sbc_calls(calls, "restart")


def test_confirmed_stop_vacuum_stops_only_the_sbc(tmp_path):
    result, calls = run_manager(tmp_path, "stop-vacuum", "--yes")
    assert result.returncode == 0, result.stderr
    assert sbc_calls(calls, "stop")
    assert not any(" stop glasgow-svc.service" in c for c in calls)


def test_confirmed_restart_vacuum_restarts_the_sbc(tmp_path):
    result, calls = run_manager(tmp_path, "restart-vacuum", "--yes")
    assert result.returncode == 0, result.stderr
    assert sbc_calls(calls, "restart")
